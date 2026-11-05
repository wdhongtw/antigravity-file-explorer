/**
 * @fileoverview Global Sidebar File Explorer Frontend (`sidebar.js`).
 *
 * - Global state persisted via `/api/sidebar/*` (defaulting to user Home folder `~`).
 * - Bookmarks & Recent Locations sidebar.
 * - Full-pane sortable file table with Back/Forward/Up/Home navigation and breadcrumbs.
 * - File/folder manipulation: New File, New Folder, Rename, Duplicate, Copy/Cut/Paste,
 *   Delete, Chmod (+x / octal), Zip/Tar.gz compression, and Zip/Tar extraction.
 * - Right-hand Inspector panel with metadata, folder size calculation, SHA-256 hash,
 *   archive member listing, and read-only text preview (no AuxPane open on file click).
 */
(() => {
  const POLL_INTERVAL_MS = 4000;
  const $ = (id) => document.getElementById(id);

  const state = {
    homeDir: '',
    currentDir: '',
    parentPath: null,
    breadcrumbs: [],
    bookmarks: [],
    recentDirs: [],
    settings: {
      showHidden: true,
      sortBy: 'name',
      sortDir: 'asc',
      inspectorOpen: true,
    },
    entries: [],
    totalEntries: 0,
    truncated: false,
    filterText: '',
    recursiveQuery: '',
    searchResults: null,
    searching: false,
    selectedPaths: new Set(),
    inspectedPath: '',
    inspectedData: null,
    inspecting: false,
    clipboard: null, // { mode: 'copy' | 'move', paths: string[] }
    prompt: null,
    history: [],
    historyIndex: -1,
    live: true,
  };

  function getSidecarToken() {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('token') || '';
    } catch {
      return '';
    }
  }
  const SIDECAR_TOKEN = getSidecarToken();

  // Host Theme Sync
  function applyThemeVariables(vars) {
    if (!vars || typeof vars !== 'object') return;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(vars)) {
      if (k.startsWith('--') && typeof v === 'string') {
        root.style.setProperty(k, v);
      }
    }
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'theme-change' && data.payload?.cssVariables) {
      applyThemeVariables(data.payload.cssVariables);
    }
  });

  async function apiGet(path, params = {}) {
    const url = new URL(path, window.location.origin);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url.toString(), { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  async function apiPost(path, body = {}) {
    const url = new URL(path, window.location.origin);
    const headers = { 'Content-Type': 'application/json' };
    if (SIDECAR_TOKEN) {
      headers['X-Sidecar-Token'] = SIDECAR_TOKEN;
      url.searchParams.set('token', SIDECAR_TOKEN);
    }
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const val = bytes / Math.pow(1024, i);
    return `${val >= 10 || i === 0 ? Math.round(val) : val.toFixed(1)} ${units[i]}`;
  }

  function formatDate(ms) {
    if (!ms || !Number.isFinite(ms)) return '—';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  function setHtmlIfChanged(el, html) {
    if (!el) return;
    if (el.dataset.lastHtml !== html) {
      el.dataset.lastHtml = html;
      el.innerHTML = html;
    }
  }

  function isBookmarked(dirPath) {
    return state.bookmarks.some((b) => b.path === dirPath);
  }

  function applyServerSidebarState(data) {
    if (data.homeDir) state.homeDir = data.homeDir;
    if (data.currentDir) state.currentDir = data.currentDir;
    if (Array.isArray(data.bookmarks)) state.bookmarks = data.bookmarks;
    if (Array.isArray(data.recentDirs)) state.recentDirs = data.recentDirs;
    if (data.settings) {
      state.settings = { ...state.settings, ...data.settings };
      if ($('chk-hidden')) $('chk-hidden').checked = state.settings.showHidden;
      if ($('chk-inspector')) $('chk-inspector').checked = state.settings.inspectorOpen;
      $('inspector-pane')?.classList.toggle('hidden', !state.settings.inspectorOpen);
    }
  }

  function folderSvg() {
    return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.5 4C1.5 3.17 2.17 2.5 3 2.5h3.17c.4 0 .78.16 1.06.44l1.12 1.12c.28.28.66.44 1.06.44H13c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5H3c-.83 0-1.5-.67-1.5-1.5V4Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/>
    </svg>`;
  }

  function archiveSvg() {
    return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.35"/>
      <path d="M8 2.5v11M6.5 5h3M6.5 7.5h3M6.5 10h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    </svg>`;
  }

  function fileSvg() {
    return `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 2.5h5.8L12.5 5.7v7.8c0 .55-.45 1-1 1h-8c-.55 0-1-.45-1-1v-10c0-.55.45-1 1-1Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
      <path d="M9 2.5v3.5h3.5" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
    </svg>`;
  }

  function renderHeaderAndNav() {
    $('btn-back').disabled = state.historyIndex <= 0;
    $('btn-forward').disabled =
      state.historyIndex < 0 || state.historyIndex >= state.history.length - 1;
    $('btn-up').disabled = !state.parentPath || state.currentDir === '/';

    // Breadcrumbs
    const crumbs = state.breadcrumbs || [];
    const crumbsHtml = crumbs
      .map((c, idx) => {
        const isLast = idx === crumbs.length - 1;
        const sep = idx > 0 && crumbs[idx - 1].path !== '/' ? '<span class="sb-crumb-sep">/</span>' : idx === 1 && crumbs[0].path === '/' ? '' : '';
        return `${sep}<button type="button" class="sb-crumb${isLast ? ' current' : ''}" data-nav-path="${esc(c.path)}" title="${esc(c.path)}">${esc(c.name)}</button>`;
      })
      .join('');
    setHtmlIfChanged($('breadcrumb-bar'), crumbsHtml);

    // Bookmark button state for currentDir
    const bmBtn = $('btn-bookmark-cwd');
    const bookmarked = isBookmarked(state.currentDir);
    if (bmBtn) {
      bmBtn.innerHTML = bookmarked ? '&#9733; Bookmarked' : '&#9734; Bookmark';
      bmBtn.classList.toggle('bookmarked', bookmarked);
    }

    // Sort indicators
    for (const col of ['name', 'size', 'mtime']) {
      const el = $(`sort-ind-${col}`);
      if (!el) continue;
      if (state.settings.sortBy === col) {
        el.textContent = state.settings.sortDir === 'asc' ? '▲' : '▼';
      } else {
        el.textContent = '';
      }
    }

    // Selection & Clipboard toolbar buttons
    const selCount = state.selectedPaths.size;
    $('btn-copy-sel').disabled = selCount === 0;
    $('btn-copy-sel').textContent = selCount > 0 ? `Copy (${selCount})` : 'Copy';
    $('btn-cut-sel').disabled = selCount === 0;
    $('btn-cut-sel').textContent = selCount > 0 ? `Cut (${selCount})` : 'Cut';
    $('btn-zip-sel').disabled = selCount === 0;
    $('btn-zip-sel').textContent = selCount > 0 ? `Zip (${selCount})` : 'Zip / Archive';
    $('btn-delete-sel').disabled = selCount === 0;
    $('btn-delete-sel').textContent = selCount > 0 ? `Delete (${selCount})` : 'Delete';

    const pasteBtn = $('btn-paste');
    const clearClipBtn = $('btn-clear-clip');
    if (state.clipboard && state.clipboard.paths.length > 0) {
      const verb = state.clipboard.mode === 'move' ? 'Move' : 'Paste';
      pasteBtn.textContent = `${verb} Here (${state.clipboard.paths.length})`;
      pasteBtn.classList.remove('hidden');
      clearClipBtn.classList.remove('hidden');
    } else {
      pasteBtn.classList.add('hidden');
      clearClipBtn.classList.add('hidden');
    }

    // Left Sidebar: Bookmarks
    $('bookmark-count').textContent = String(state.bookmarks.length);
    const bmHtml =
      state.bookmarks.length === 0
        ? '<div class="sb-empty">No bookmarks yet</div>'
        : state.bookmarks
            .map((b) => {
              const active = b.path === state.currentDir;
              return `
                <div class="sb-nav-item${active ? ' active' : ''}" data-nav-path="${esc(b.path)}" title="${esc(b.path)}">
                  <div class="sb-nav-top">
                    <span class="sb-nav-name">&#9733; ${esc(b.label || b.name)}</span>
                    <div class="sb-nav-actions">
                      <button type="button" class="sb-row-btn" data-action="edit-bookmark" data-path="${esc(b.path)}" data-label="${esc(b.label || b.name)}" title="Rename bookmark label">Label</button>
                      <button type="button" class="sb-row-btn" data-action="copy-abs" data-path="${esc(b.path)}" title="Copy path">Copy</button>
                      <button type="button" class="sb-row-btn danger" data-action="remove-bookmark" data-path="${esc(b.path)}" title="Remove bookmark">&#215;</button>
                    </div>
                  </div>
                  <div class="sb-nav-bottom">
                    <code class="sb-nav-path">${esc(b.displayPath)}</code>
                  </div>
                </div>`;
            })
            .join('');
    setHtmlIfChanged($('bookmark-list'), bmHtml);

    // Left Sidebar: Recent Folders
    const recentHtml =
      state.recentDirs.length === 0
        ? '<div class="sb-empty">No recent folders</div>'
        : state.recentDirs
            .map((r) => {
              const active = r.path === state.currentDir;
              const alreadyBm = isBookmarked(r.path);
              return `
                <div class="sb-nav-item${active ? ' active' : ''}" data-nav-path="${esc(r.path)}" title="${esc(r.path)}">
                  <div class="sb-nav-top">
                    <span class="sb-nav-name">${esc(r.name)}</span>
                    <div class="sb-nav-actions">
                      ${!alreadyBm ? `<button type="button" class="sb-row-btn" data-action="quick-bookmark" data-path="${esc(r.path)}" title="Add to Bookmarks">&#9734;</button>` : ''}
                      <button type="button" class="sb-row-btn" data-action="copy-abs" data-path="${esc(r.path)}" title="Copy path">Copy</button>
                    </div>
                  </div>
                  <div class="sb-nav-bottom">
                    <code class="sb-nav-path">${esc(r.displayPath)}</code>
                  </div>
                </div>`;
            })
            .join('');
    setHtmlIfChanged($('recent-list'), recentHtml);
  }

  function getVisibleEntries() {
    if (state.searchResults) {
      return state.searchResults.results || [];
    }
    const q = state.filterText.trim().toLowerCase();
    if (!q) return state.entries;
    return state.entries.filter((e) => e.name.toLowerCase().includes(q));
  }

  function renderFileList() {
    const container = $('file-list');
    const visible = getVisibleEntries();

    const clearBtn = $('btn-clear-search');
    if (state.filterText.trim() || state.searchResults) {
      clearBtn.classList.remove('hidden');
    } else {
      clearBtn.classList.add('hidden');
    }

    if (state.searching) {
      setHtmlIfChanged(container, '<div class="sb-empty">Searching subfolders…</div>');
      return;
    }

    let bannerHtml = '';
    if (state.searchResults) {
      bannerHtml = `
        <div class="sb-insp-card" style="margin:4px 4px 6px;flex-direction:row;align-items:center;justify-content:space-between">
          <span>Recursive search for <strong>"${esc(state.recursiveQuery)}"</strong> in <code>${esc(state.currentDir)}</code> (${visible.length}${state.searchResults.truncated ? '+' : ''} matches)</span>
          <button type="button" class="sb-btn sm" data-action="exit-search">Exit Search</button>
        </div>`;
    }

    if (visible.length === 0) {
      setHtmlIfChanged(
        container,
        bannerHtml +
          `<div class="sb-empty">${
            state.filterText.trim() || state.searchResults
              ? 'No matching files or folders.'
              : 'This folder is empty.'
          }</div>`
      );
      updateStatusBar(0);
      return;
    }

    const allSelected =
      visible.length > 0 && visible.every((e) => state.selectedPaths.has(e.path));
    if ($('chk-select-all')) {
      $('chk-select-all').checked = allSelected;
    }

    const rowsHtml = visible
      .map((entry) => {
        const isSel = state.selectedPaths.has(entry.path);
        const isInsp = state.inspectedPath === entry.path;
        const iconClass = entry.isDirectory
          ? 'dir'
          : entry.isArchive
          ? 'archive'
          : 'file';
        const icon = entry.isDirectory
          ? folderSvg()
          : entry.isArchive
          ? archiveSvg()
          : fileSvg();

        const tags = [];
        if (entry.isSymlink) {
          tags.push(
            `<span class="sb-tag symlink" title="${esc(entry.symlinkTarget ? `-> ${entry.symlinkTarget}` : 'symlink')}">symlink</span>`
          );
        }
        if (entry.isArchive) {
          tags.push('<span class="sb-tag archive">archive</span>');
        }
        if (entry.isExecutable) {
          tags.push('<span class="sb-tag exec">+x</span>');
        }

        const displayName = state.searchResults
          ? entry.relPath || entry.name
          : entry.name;

        let actionsHtml = '';
        if (entry.isDirectory) {
          const bm = isBookmarked(entry.path);
          actionsHtml = `
            <button type="button" class="sb-row-btn${bm ? ' accent' : ''}" data-action="toggle-bookmark" data-path="${esc(entry.path)}" data-name="${esc(entry.name)}" title="${bm ? 'Remove bookmark' : 'Bookmark folder'}">${bm ? '&#9733;' : '&#9734;'}</button>
            <button type="button" class="sb-row-btn" data-action="zip-item" data-path="${esc(entry.path)}" data-name="${esc(entry.name)}" title="Compress folder to .zip">Zip</button>
            <button type="button" class="sb-row-btn" data-action="copy-abs" data-path="${esc(entry.path)}" title="Copy absolute path">Copy</button>
            <button type="button" class="sb-row-btn" data-action="rename" data-path="${esc(entry.path)}" data-name="${esc(entry.name)}" title="Rename">Ren</button>
            <button type="button" class="sb-row-btn danger" data-action="delete-item" data-path="${esc(entry.path)}" data-name="${esc(entry.name)}" title="Delete">Del</button>`;
        } else if (entry.isArchive) {
          actionsHtml = `
            <button type="button" class="sb-row-btn accent" data-action="extract-item" data-path="${esc(entry.path)}" data-name="${esc(entry.name)}" title="Extract archive (Unzip / Untar)">Unzip</button>
            <button type="button" class="sb-row-btn" data-action="copy-abs" data-path="${esc(entry.path)}" title="Copy absolute path">Copy</button>
            <button type="button" class="sb-row-btn" data-action="duplicate" data-path="${esc(entry.path)}" data-name="${esc(entry.name)}" title="Duplicate archive">Dup</button>
            <button type="button" class="sb-row-btn" data-action="rename" data-path="${esc(entry.path)}" data-name="${esc(entry.name)}" title="Rename">Ren</button>
            <button type="button" class="sb-row-btn danger" data-action="delete-item" data-path="${esc(entry.path)}" data-name="${esc(entry.name)}" title="Delete">Del</button>`;
        } else {
          actionsHtml = `
            <button type="button" class="sb-row-btn" data-action="zip-item" data-path="${esc(entry.path)}" data-name="${esc(entry.name)}" title="Compress file to .zip">Zip</button>
            <button type="button" class="sb-row-btn" data-action="copy-abs" data-path="${esc(entry.path)}" title="Copy absolute path">Copy</button>
            <button type="button" class="sb-row-btn" data-action="duplicate" data-path="${esc(entry.path)}" data-name="${esc(entry.name)}" title="Duplicate file">Dup</button>
            <button type="button" class="sb-row-btn" data-action="rename" data-path="${esc(entry.path)}" data-name="${esc(entry.name)}" title="Rename">Ren</button>
            <button type="button" class="sb-row-btn danger" data-action="delete-item" data-path="${esc(entry.path)}" data-name="${esc(entry.name)}" title="Delete">Del</button>`;
        }

        return `
          <div
            class="sb-file-row${entry.isDirectory ? ' is-dir' : ' is-file'}${isSel ? ' selected' : ''}${isInsp ? ' inspected' : ''}"
            data-row-path="${esc(entry.path)}"
            data-row-isdir="${entry.isDirectory ? '1' : '0'}"
          >
            <div class="sb-col-check">
              <input type="checkbox" class="row-check" data-check-path="${esc(entry.path)}" ${isSel ? 'checked' : ''}>
            </div>
            <div class="sb-cell-name">
              <span class="sb-item-icon ${iconClass}">${icon}</span>
              <span class="sb-item-title" title="${esc(entry.path)}">${esc(displayName)}</span>
              ${tags.join('')}
            </div>
            <div class="sb-cell-size">${entry.isDirectory ? '—' : esc(formatBytes(entry.size))}</div>
            <div class="sb-cell-perms" title="${esc(entry.modeOctal || '')}">${esc(entry.permissions || '—')}</div>
            <div class="sb-cell-mtime">${esc(formatDate(entry.mtimeMs))}</div>
            <div class="sb-cell-actions">${actionsHtml}</div>
          </div>`;
      })
      .join('');

    setHtmlIfChanged(container, bannerHtml + rowsHtml);
    updateStatusBar(visible.length);
  }

  function updateStatusBar(visibleCount) {
    const dirCount = state.entries.filter((e) => e.isDirectory).length;
    const fileCount = state.entries.length - dirCount;
    $('status-summary').textContent = `${visibleCount} shown (${dirCount} folders, ${fileCount} files)`;
    $('status-selection').textContent =
      state.selectedPaths.size > 0 ? `${state.selectedPaths.size} selected` : '';
    $('status-clipboard').textContent =
      state.clipboard && state.clipboard.paths.length > 0
        ? `Clipboard: ${state.clipboard.paths.length} (${state.clipboard.mode})`
        : '';
  }

  function renderPromptBar() {
    const bar = $('prompt-bar');
    const p = state.prompt;
    if (!p) {
      bar.classList.add('hidden');
      bar.innerHTML = '';
      return;
    }

    bar.classList.remove('hidden');

    if (p.mode === 'delete') {
      const label =
        p.paths.length === 1
          ? `<code>${esc(p.paths[0].split('/').pop() || p.paths[0])}</code>`
          : `<strong>${p.paths.length} items</strong>`;
      bar.innerHTML = `
        <div class="sb-prompt-title">Permanently delete ${label}?</div>
        <div class="sb-prompt-controls">
          <button type="button" id="btn-prompt-confirm" class="sb-btn danger solid">Delete</button>
          <button type="button" id="btn-prompt-cancel" class="sb-btn">Cancel</button>
        </div>`;
      return;
    }

    if (p.mode === 'extract') {
      bar.innerHTML = `
        <div class="sb-prompt-title">Extract archive <code>${esc(p.archiveName)}</code></div>
        <div class="sb-prompt-controls">
          <label class="sb-toggle">
            <input type="checkbox" id="prompt-subfolder" checked>
            <span>Extract into new subfolder</span>
          </label>
          <button type="button" id="btn-prompt-confirm" class="sb-btn primary">Extract</button>
          <button type="button" id="btn-prompt-cancel" class="sb-btn">Cancel</button>
        </div>`;
      return;
    }

    if (p.mode === 'compress') {
      bar.innerHTML = `
        <div class="sb-prompt-title">Compress ${p.paths.length} item(s) in <code>${esc(state.currentDir)}</code></div>
        <div class="sb-prompt-controls">
          <input id="prompt-input" type="text" class="sb-prompt-input" value="${esc(p.initialValue || '')}" placeholder="archive.zip" autocomplete="off">
          <select id="prompt-format" class="sb-prompt-select">
            <option value="zip">.zip</option>
            <option value="tar.gz">.tar.gz</option>
          </select>
          <button type="button" id="btn-prompt-confirm" class="sb-btn primary">Create Archive</button>
          <button type="button" id="btn-prompt-cancel" class="sb-btn">Cancel</button>
        </div>`;
      const inp = $('prompt-input');
      if (inp) {
        inp.focus();
        inp.select();
      }
      return;
    }

    const titleMap = {
      'new-file': `New file in <code>${esc(state.currentDir)}</code>`,
      'new-folder': `New folder in <code>${esc(state.currentDir)}</code>`,
      rename: `Rename <code>${esc(p.targetName)}</code>`,
      duplicate: `Duplicate <code>${esc(p.targetName)}</code> as`,
      chmod: `Set octal permissions for <code>${esc(p.targetName)}</code>`,
      'bookmark-label': `Bookmark label for <code>${esc(p.targetPath)}</code>`,
    };

    const confirmLabel =
      p.mode === 'rename'
        ? 'Rename'
        : p.mode === 'chmod'
        ? 'Apply'
        : p.mode === 'bookmark-label'
        ? 'Save'
        : 'Create';

    bar.innerHTML = `
      <div class="sb-prompt-title">${titleMap[p.mode] || 'Input'}</div>
      <div class="sb-prompt-controls">
        <input id="prompt-input" type="text" class="sb-prompt-input" value="${esc(p.initialValue || '')}" placeholder="${esc(p.placeholder || '')}" autocomplete="off">
        <button type="button" id="btn-prompt-confirm" class="sb-btn primary">${confirmLabel}</button>
        <button type="button" id="btn-prompt-cancel" class="sb-btn">Cancel</button>
      </div>`;

    const inp = $('prompt-input');
    if (inp) {
      inp.focus();
      inp.select();
    }
  }

  function renderInspector() {
    const body = $('inspector-body');
    const badge = $('inspector-kind-badge');
    if (!body) return;

    if (state.inspecting && !state.inspectedData) {
      setHtmlIfChanged(body, '<div class="sb-empty">Loading inspector…</div>');
      return;
    }

    const d = state.inspectedData;
    if (!d) {
      setHtmlIfChanged(
        body,
        '<div class="sb-empty">Select any file or folder to inspect its metadata, permissions, archive contents, or text preview.</div>'
      );
      return;
    }

    if (badge) {
      badge.textContent = d.isDirectory
        ? 'Directory'
        : d.isArchive
        ? 'Archive'
        : d.isSymlink
        ? 'Symlink'
        : 'File';
    }

    let sizeSectionHtml = d.isDirectory
      ? d.folderStats
        ? `${esc(formatBytes(d.folderStats.totalBytes))} (${d.folderStats.fileCount} files, ${d.folderStats.dirCount} dirs${d.folderStats.truncated ? '+' : ''})`
        : `${d.childCount ?? 0} immediate items <button type="button" class="sb-row-btn" data-action="calc-folder-size" data-path="${esc(d.path)}">Calc Size</button>`
      : `${esc(formatBytes(d.size))} (${d.size.toLocaleString()} B)`;

    const symlinkHtml = d.isSymlink
      ? `<div class="sb-insp-label">Symlink</div><div class="sb-insp-val">-> ${esc(d.symlinkTarget || '(broken)')}</div>`
      : '';

    const hashHtml = !d.isDirectory
      ? d.sha256
        ? `<div class="sb-insp-label">SHA-256</div><div class="sb-insp-val">${esc(d.sha256)}</div>`
        : `<div class="sb-insp-label">SHA-256</div><div class="sb-insp-val"><button type="button" class="sb-row-btn" data-action="calc-hash" data-path="${esc(d.path)}">Compute SHA-256</button></div>`
      : '';

    const bm = d.isDirectory && isBookmarked(d.path);
    const quickActions = [];
    quickActions.push(
      `<button type="button" class="sb-btn sm" data-action="copy-abs" data-path="${esc(d.path)}">Copy Abs Path</button>`
    );
    quickActions.push(
      `<button type="button" class="sb-btn sm" data-action="copy-name" data-name="${esc(d.name)}">Copy Name</button>`
    );
    if (d.isDirectory) {
      quickActions.push(
        `<button type="button" class="sb-btn sm${bm ? ' bookmarked' : ''}" data-action="toggle-bookmark" data-path="${esc(d.path)}" data-name="${esc(d.name)}">${bm ? '★ Bookmarked' : '☆ Bookmark'}</button>`
      );
      quickActions.push(
        `<button type="button" class="sb-btn sm" data-action="zip-item" data-path="${esc(d.path)}" data-name="${esc(d.name)}">Zip Folder</button>`
      );
    } else {
      if (d.isArchive) {
        quickActions.push(
          `<button type="button" class="sb-btn primary sm" data-action="extract-item" data-path="${esc(d.path)}" data-name="${esc(d.name)}">Extract Archive</button>`
        );
      } else {
        quickActions.push(
          `<button type="button" class="sb-btn sm" data-action="zip-item" data-path="${esc(d.path)}" data-name="${esc(d.name)}">Zip File</button>`
        );
      }
      quickActions.push(
        `<button type="button" class="sb-btn sm" data-action="toggle-exec" data-path="${esc(d.path)}">${d.isExecutable ? 'Remove +x' : 'Make +x'}</button>`
      );
    }
    quickActions.push(
      `<button type="button" class="sb-btn sm" data-action="chmod-prompt" data-path="${esc(d.path)}" data-name="${esc(d.name)}" data-mode="${esc((d.modeOctal || '0644').slice(1))}">Chmod (${esc(d.modeOctal || '')})</button>`
    );

    let extraCardHtml = '';
    if (d.archivePreview) {
      const entries = d.archivePreview.entries || [];
      const listHtml =
        entries.length === 0
          ? '<div class="sb-empty">Empty archive</div>'
          : entries
              .map(
                (a) => `
              <div class="sb-archive-entry">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(a.name)}">${esc(a.name)}</span>
                <span style="color:var(--muted-foreground);flex-shrink:0">${a.isDirectory ? 'dir' : esc(formatBytes(a.size))}</span>
              </div>`
              )
              .join('');
      extraCardHtml = `
        <div class="sb-insp-card">
          <div class="sb-section-title">Archive Contents (${d.archivePreview.total}${d.archivePreview.truncated ? '+' : ''})</div>
          <div class="sb-archive-list">${listHtml}</div>
        </div>`;
    } else if (typeof d.textPreview === 'string') {
      extraCardHtml = `
        <div class="sb-insp-card">
          <div class="sb-section-title">Text Preview${d.textPreviewTruncated ? ' (first 8 KB)' : ''}</div>
          <pre class="sb-preview-pre">${esc(d.textPreview)}</pre>
        </div>`;
    } else if (d.isBinary) {
      extraCardHtml = `
        <div class="sb-insp-card">
          <div class="sb-section-title">Content</div>
          <div style="font-size:11px;color:var(--muted-foreground)">Binary file (${esc(formatBytes(d.size))})</div>
        </div>`;
    }

    const html = `
      <div class="sb-insp-card">
        <div class="sb-insp-title">${esc(d.name)}</div>
        <div class="sb-insp-path">${esc(d.path)}</div>
        <div class="sb-insp-actions">${quickActions.join('')}</div>
      </div>

      <div class="sb-insp-card">
        <div class="sb-insp-grid">
          <div class="sb-insp-label">Size</div>
          <div class="sb-insp-val">${sizeSectionHtml}</div>
          <div class="sb-insp-label">Permissions</div>
          <div class="sb-insp-val">${esc(d.permissions)} (${esc(d.modeOctal)})</div>
          ${symlinkHtml}
          <div class="sb-insp-label">Modified</div>
          <div class="sb-insp-val">${esc(formatDate(d.mtimeMs))}</div>
          <div class="sb-insp-label">Changed</div>
          <div class="sb-insp-val">${esc(formatDate(d.ctimeMs))}</div>
          ${hashHtml}
        </div>
      </div>
      ${extraCardHtml}`;

    setHtmlIfChanged(body, html);
  }

  async function inspectItem(targetPath, { includeHash = false, includeFolderSize = false } = {}) {
    if (!targetPath) return;
    state.inspectedPath = targetPath;
    state.inspecting = true;
    renderFileList();
    renderInspector();
    try {
      const data = await apiGet('/api/inspect', {
        root: '/',
        path: targetPath,
        includeHash,
        includeFolderSize,
      });
      if (state.inspectedPath === targetPath) {
        state.inspectedData = data;
      }
    } catch (err) {
      showToast(`Inspect error: ${err.message}`);
    } finally {
      state.inspecting = false;
      renderInspector();
    }
  }

  async function loadCurrentDirectory({ silent = false, pushHistory = false } = {}) {
    if (!state.currentDir) return;
    try {
      const res = await apiGet('/api/list', {
        root: '/',
        path: state.currentDir,
        showHidden: state.settings.showHidden,
        sortBy: state.settings.sortBy,
        sortDir: state.settings.sortDir,
        limit: 1000,
      });

      state.currentDir = res.path || state.currentDir;
      state.parentPath = res.parentPath;
      state.breadcrumbs = res.breadcrumbs || [];
      state.entries = res.entries || [];
      state.totalEntries = res.total || 0;
      state.truncated = Boolean(res.truncated);

      if (pushHistory) {
        if (state.history[state.historyIndex] !== state.currentDir) {
          state.history = state.history.slice(0, state.historyIndex + 1);
          state.history.push(state.currentDir);
          state.historyIndex = state.history.length - 1;
        }
      }

      // Prune selections that no longer exist
      const validPaths = new Set(state.entries.map((e) => e.path));
      for (const p of [...state.selectedPaths]) {
        if (!validPaths.has(p)) {
          state.selectedPaths.delete(p);
        }
      }

      renderHeaderAndNav();
      renderFileList();

      if (!state.inspectedPath || (!validPaths.has(state.inspectedPath) && state.inspectedPath !== state.currentDir)) {
        await inspectItem(state.currentDir);
      } else if (!silent) {
        await inspectItem(state.inspectedPath);
      }
    } catch (err) {
      if (!silent) {
        showToast(`Failed to open directory: ${err.message}`);
      }
    }
  }

  async function navigateTo(targetDir, { pushHistory = true } = {}) {
    if (!targetDir) return;
    try {
      const st = await apiPost('/api/sidebar/navigate', { path: targetDir });
      applyServerSidebarState(st);
      state.selectedPaths.clear();
      state.searchResults = null;
      state.recursiveQuery = '';
      state.prompt = null;
      renderPromptBar();
      state.inspectedPath = state.currentDir;
      state.inspectedData = null;
      await loadCurrentDirectory({ silent: false, pushHistory });
    } catch (err) {
      showToast(err.message);
    }
  }

  async function runRecursiveSearch() {
    const q = ($('filter-input')?.value || '').trim();
    if (!q) {
      state.searchResults = null;
      state.recursiveQuery = '';
      renderFileList();
      return;
    }
    state.searching = true;
    state.recursiveQuery = q;
    renderFileList();
    try {
      const res = await apiGet('/api/search', {
        root: state.currentDir,
        q,
        showHidden: state.settings.showHidden,
        maxResults: 200,
      });
      state.searchResults = res;
    } catch (err) {
      showToast(`Search failed: ${err.message}`);
    } finally {
      state.searching = false;
      renderFileList();
    }
  }

  async function executePrompt() {
    const p = state.prompt;
    if (!p) return;

    try {
      if (p.mode === 'delete') {
        await apiPost('/api/delete', { root: '/', paths: p.paths });
        for (const delPath of p.paths) {
          state.selectedPaths.delete(delPath);
        }
        showToast(`Deleted ${p.paths.length} item(s)`);
      } else if (p.mode === 'extract') {
        const createSubfolder = Boolean($('prompt-subfolder')?.checked);
        const res = await apiPost('/api/extract', {
          root: '/',
          archivePath: p.archivePath,
          destDir: state.currentDir,
          createSubfolder,
        });
        showToast(`Extracted ${res.entryCount} items to ${res.extractedName}`);
        state.inspectedPath = res.extractedTo;
      } else if (p.mode === 'compress') {
        const archiveName = ($('prompt-input')?.value || '').trim();
        const format = $('prompt-format')?.value || 'zip';
        const res = await apiPost('/api/compress', {
          root: '/',
          sourcePaths: p.paths,
          destDir: state.currentDir,
          archiveName,
          format,
        });
        showToast(`Created archive ${res.name} (${formatBytes(res.size)})`);
        state.inspectedPath = res.path;
      } else {
        const val = ($('prompt-input')?.value || '').trim();
        if (!val) {
          showToast('Please enter a value');
          return;
        }
        if (p.mode === 'new-file') {
          const res = await apiPost('/api/create-file', {
            root: '/',
            parentDir: state.currentDir,
            name: val,
          });
          showToast(`Created file ${res.name}`);
          state.inspectedPath = res.path;
        } else if (p.mode === 'new-folder') {
          const res = await apiPost('/api/create-directory', {
            root: '/',
            parentDir: state.currentDir,
            name: val,
          });
          showToast(`Created folder ${res.name}`);
          state.inspectedPath = res.path;
        } else if (p.mode === 'rename') {
          const res = await apiPost('/api/rename', {
            root: '/',
            oldPath: p.targetPath,
            newName: val,
          });
          showToast(`Renamed to ${res.name}`);
          state.inspectedPath = res.path;
        } else if (p.mode === 'duplicate') {
          const res = await apiPost('/api/duplicate', {
            root: '/',
            path: p.targetPath,
            newName: val,
          });
          showToast(`Duplicated as ${res.name}`);
          state.inspectedPath = res.path;
        } else if (p.mode === 'chmod') {
          const res = await apiPost('/api/chmod', {
            root: '/',
            path: p.targetPath,
            mode: val,
          });
          showToast(`Permissions updated to ${res.modeOctal}`);
        } else if (p.mode === 'bookmark-label') {
          const st = await apiPost('/api/sidebar/bookmark', {
            path: p.targetPath,
            label: val,
          });
          applyServerSidebarState(st);
          renderHeaderAndNav();
          showToast(`Updated bookmark "${val}"`);
        }
      }

      state.prompt = null;
      renderPromptBar();
      await loadCurrentDirectory({ silent: false });
    } catch (err) {
      showToast(err.message);
    }
  }

  // Event Delegation
  document.addEventListener('click', async (e) => {
    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) {
      const col = sortBtn.dataset.sort;
      const nextDir =
        state.settings.sortBy === col && state.settings.sortDir === 'asc'
          ? 'desc'
          : 'asc';
      const st = await apiPost('/api/sidebar/settings', {
        sortBy: col,
        sortDir: nextDir,
      });
      applyServerSidebarState(st);
      await loadCurrentDirectory({ silent: false });
      return;
    }

    if (e.target.closest('#btn-prompt-confirm')) {
      await executePrompt();
      return;
    }

    if (e.target.closest('#btn-prompt-cancel')) {
      state.prompt = null;
      renderPromptBar();
      return;
    }

    const checkEl = e.target.closest('[data-check-path]');
    if (checkEl) {
      e.stopPropagation();
      const p = checkEl.dataset.checkPath;
      if (checkEl.checked) {
        state.selectedPaths.add(p);
      } else {
        state.selectedPaths.delete(p);
      }
      renderHeaderAndNav();
      renderFileList();
      return;
    }

    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      e.stopPropagation();
      const action = actionBtn.dataset.action;
      const targetPath = actionBtn.dataset.path || '';
      const targetName =
        actionBtn.dataset.name || targetPath.split('/').pop() || '';

      if (action === 'exit-search') {
        state.searchResults = null;
        state.recursiveQuery = '';
        renderFileList();
        return;
      }
      if (action === 'copy-abs') {
        await navigator.clipboard?.writeText(targetPath);
        showToast(`Copied path: ${targetPath}`);
        return;
      }
      if (action === 'copy-name') {
        await navigator.clipboard?.writeText(targetName);
        showToast(`Copied name: ${targetName}`);
        return;
      }
      if (action === 'quick-bookmark' || action === 'toggle-bookmark') {
        if (isBookmarked(targetPath)) {
          const st = await apiPost('/api/sidebar/unbookmark', { path: targetPath });
          applyServerSidebarState(st);
          showToast(`Removed bookmark: ${targetName}`);
        } else {
          const st = await apiPost('/api/sidebar/bookmark', {
            path: targetPath,
            label: targetName,
          });
          applyServerSidebarState(st);
          showToast(`Bookmarked: ${targetName}`);
        }
        renderHeaderAndNav();
        renderFileList();
        renderInspector();
        return;
      }
      if (action === 'remove-bookmark') {
        const st = await apiPost('/api/sidebar/unbookmark', { path: targetPath });
        applyServerSidebarState(st);
        renderHeaderAndNav();
        renderFileList();
        renderInspector();
        showToast('Bookmark removed');
        return;
      }
      if (action === 'edit-bookmark') {
        state.prompt = {
          mode: 'bookmark-label',
          targetPath,
          initialValue: actionBtn.dataset.label || targetName,
          placeholder: 'Bookmark label',
        };
        renderPromptBar();
        return;
      }
      if (action === 'zip-item') {
        state.prompt = {
          mode: 'compress',
          paths: [targetPath],
          initialValue: `${targetName}.zip`,
        };
        renderPromptBar();
        return;
      }
      if (action === 'extract-item') {
        state.prompt = {
          mode: 'extract',
          archivePath: targetPath,
          archiveName: targetName,
        };
        renderPromptBar();
        return;
      }
      if (action === 'duplicate') {
        const res = await apiPost('/api/duplicate', {
          root: '/',
          path: targetPath,
        });
        showToast(`Duplicated as ${res.name}`);
        state.inspectedPath = res.path;
        await loadCurrentDirectory({ silent: false });
        return;
      }
      if (action === 'rename') {
        state.prompt = {
          mode: 'rename',
          targetPath,
          targetName,
          initialValue: targetName,
          placeholder: 'New name',
        };
        renderPromptBar();
        return;
      }
      if (action === 'delete-item') {
        state.prompt = {
          mode: 'delete',
          paths: [targetPath],
        };
        renderPromptBar();
        return;
      }
      if (action === 'toggle-exec') {
        const res = await apiPost('/api/chmod', {
          root: '/',
          path: targetPath,
          mode: 'toggle-exec',
        });
        showToast(`Permissions: ${res.permissions} (${res.modeOctal})`);
        await loadCurrentDirectory({ silent: false });
        return;
      }
      if (action === 'chmod-prompt') {
        state.prompt = {
          mode: 'chmod',
          targetPath,
          targetName,
          initialValue: actionBtn.dataset.mode || '755',
          placeholder: '755 or 644',
        };
        renderPromptBar();
        return;
      }
      if (action === 'calc-folder-size') {
        await inspectItem(targetPath, { includeFolderSize: true });
        return;
      }
      if (action === 'calc-hash') {
        await inspectItem(targetPath, { includeHash: true });
        return;
      }
    }

    const navEl = e.target.closest('[data-nav-path]');
    if (navEl) {
      await navigateTo(navEl.dataset.navPath, { pushHistory: true });
      return;
    }

    const fileRow = e.target.closest('[data-row-path]');
    if (fileRow) {
      const rowPath = fileRow.dataset.rowPath;
      const isDir = fileRow.dataset.rowIsdir === '1';
      if (isDir) {
        await navigateTo(rowPath, { pushHistory: true });
      } else {
        await inspectItem(rowPath);
      }
    }
  });

  document.addEventListener('keydown', async (e) => {
    if (!state.prompt) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      state.prompt = null;
      renderPromptBar();
    } else if (e.key === 'Enter' && e.target.id === 'prompt-input') {
      e.preventDefault();
      await executePrompt();
    }
  });

  // Top Navigation Buttons
  $('btn-back')?.addEventListener('click', async () => {
    if (state.historyIndex > 0) {
      state.historyIndex--;
      await navigateTo(state.history[state.historyIndex], { pushHistory: false });
    }
  });

  $('btn-forward')?.addEventListener('click', async () => {
    if (state.historyIndex < state.history.length - 1) {
      state.historyIndex++;
      await navigateTo(state.history[state.historyIndex], { pushHistory: false });
    }
  });

  $('btn-up')?.addEventListener('click', async () => {
    if (state.parentPath) {
      await navigateTo(state.parentPath, { pushHistory: true });
    }
  });

  $('btn-home')?.addEventListener('click', async () => {
    if (state.homeDir) {
      await navigateTo(state.homeDir, { pushHistory: true });
    }
  });

  $('btn-refresh')?.addEventListener('click', async () => {
    showToast('Refreshing folder…');
    await loadCurrentDirectory({ silent: false });
  });

  $('btn-edit-path')?.addEventListener('click', () => {
    $('breadcrumb-bar')?.classList.add('hidden');
    const form = $('path-form');
    const inp = $('path-input');
    if (form && inp) {
      form.classList.remove('hidden');
      inp.value = state.currentDir;
      inp.focus();
      inp.select();
    }
  });

  $('btn-cancel-path')?.addEventListener('click', () => {
    $('path-form')?.classList.add('hidden');
    $('breadcrumb-bar')?.classList.remove('hidden');
  });

  $('path-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const target = ($('path-input')?.value || '').trim();
    $('path-form')?.classList.add('hidden');
    $('breadcrumb-bar')?.classList.remove('hidden');
    if (target) {
      await navigateTo(target, { pushHistory: true });
    }
  });

  $('btn-copy-cwd')?.addEventListener('click', async () => {
    if (!state.currentDir) return;
    await navigator.clipboard?.writeText(state.currentDir);
    showToast(`Copied directory path: ${state.currentDir}`);
  });

  const handleBookmarkCurrent = async () => {
    if (!state.currentDir) return;
    if (isBookmarked(state.currentDir)) {
      const st = await apiPost('/api/sidebar/unbookmark', { path: state.currentDir });
      applyServerSidebarState(st);
      showToast('Removed bookmark for current directory');
    } else {
      const st = await apiPost('/api/sidebar/bookmark', { path: state.currentDir });
      applyServerSidebarState(st);
      showToast(`Bookmarked ${state.currentDir}`);
    }
    renderHeaderAndNav();
    renderInspector();
  };

  $('btn-bookmark-cwd')?.addEventListener('click', handleBookmarkCurrent);
  $('btn-add-bookmark')?.addEventListener('click', handleBookmarkCurrent);

  // Header Toggles
  $('chk-hidden')?.addEventListener('change', async (e) => {
    const st = await apiPost('/api/sidebar/settings', {
      showHidden: e.target.checked,
    });
    applyServerSidebarState(st);
    await loadCurrentDirectory({ silent: false });
  });

  $('chk-inspector')?.addEventListener('change', async (e) => {
    const st = await apiPost('/api/sidebar/settings', {
      inspectorOpen: e.target.checked,
    });
    applyServerSidebarState(st);
  });

  $('chk-live')?.addEventListener('change', (e) => {
    state.live = e.target.checked;
  });

  // Search & Filter
  $('filter-input')?.addEventListener('input', (e) => {
    state.filterText = e.target.value || '';
    if (!state.filterText.trim() && state.searchResults) {
      state.searchResults = null;
      state.recursiveQuery = '';
    }
    renderFileList();
  });

  $('filter-input')?.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      await runRecursiveSearch();
    }
  });

  $('btn-recursive-search')?.addEventListener('click', runRecursiveSearch);

  $('btn-clear-search')?.addEventListener('click', () => {
    state.filterText = '';
    state.searchResults = null;
    state.recursiveQuery = '';
    if ($('filter-input')) $('filter-input').value = '';
    renderFileList();
  });

  // Select All Checkbox
  $('chk-select-all')?.addEventListener('change', (e) => {
    const visible = getVisibleEntries();
    if (e.target.checked) {
      for (const item of visible) {
        state.selectedPaths.add(item.path);
      }
    } else {
      state.selectedPaths.clear();
    }
    renderHeaderAndNav();
    renderFileList();
  });

  // Toolbar Actions
  $('btn-new-file')?.addEventListener('click', () => {
    state.prompt = {
      mode: 'new-file',
      initialValue: '',
      placeholder: 'filename.ext',
    };
    renderPromptBar();
  });

  $('btn-new-folder')?.addEventListener('click', () => {
    state.prompt = {
      mode: 'new-folder',
      initialValue: '',
      placeholder: 'folder-name',
    };
    renderPromptBar();
  });

  $('btn-copy-sel')?.addEventListener('click', () => {
    if (state.selectedPaths.size === 0) return;
    state.clipboard = {
      mode: 'copy',
      paths: [...state.selectedPaths],
    };
    renderHeaderAndNav();
    updateStatusBar(getVisibleEntries().length);
    showToast(`Copied ${state.clipboard.paths.length} item(s) to clipboard`);
  });

  $('btn-cut-sel')?.addEventListener('click', () => {
    if (state.selectedPaths.size === 0) return;
    state.clipboard = {
      mode: 'move',
      paths: [...state.selectedPaths],
    };
    renderHeaderAndNav();
    updateStatusBar(getVisibleEntries().length);
    showToast(`Cut ${state.clipboard.paths.length} item(s) to clipboard`);
  });

  $('btn-clear-clip')?.addEventListener('click', () => {
    state.clipboard = null;
    renderHeaderAndNav();
    updateStatusBar(getVisibleEntries().length);
  });

  $('btn-paste')?.addEventListener('click', async () => {
    if (!state.clipboard || state.clipboard.paths.length === 0) return;
    try {
      const res = await apiPost('/api/transfer', {
        root: '/',
        sourcePaths: state.clipboard.paths,
        destDir: state.currentDir,
        mode: state.clipboard.mode,
      });
      const verb = state.clipboard.mode === 'move' ? 'Moved' : 'Copied';
      if (state.clipboard.mode === 'move') {
        state.clipboard = null;
      }
      showToast(`${verb} ${res.count} item(s) into ${state.currentDir}`);
      await loadCurrentDirectory({ silent: false });
    } catch (err) {
      showToast(err.message);
    }
  });

  $('btn-zip-sel')?.addEventListener('click', () => {
    if (state.selectedPaths.size === 0) return;
    const paths = [...state.selectedPaths];
    const baseName =
      paths.length === 1
        ? paths[0].split('/').pop() || 'archive'
        : state.currentDir.split('/').pop() || 'archive';
    state.prompt = {
      mode: 'compress',
      paths,
      initialValue: `${baseName}.zip`,
    };
    renderPromptBar();
  });

  $('btn-delete-sel')?.addEventListener('click', () => {
    if (state.selectedPaths.size === 0) return;
    state.prompt = {
      mode: 'delete',
      paths: [...state.selectedPaths],
    };
    renderPromptBar();
  });

  async function init() {
    try {
      const st = await apiGet('/api/sidebar/state');
      applyServerSidebarState(st);
      await loadCurrentDirectory({ silent: false, pushHistory: true });
    } catch (err) {
      showToast(`Init failed: ${err.message}`);
    }

    setInterval(() => {
      if (state.live && !document.hidden && !state.prompt && !state.searchResults) {
        loadCurrentDirectory({ silent: true });
      }
    }, POLL_INTERVAL_MS);
  }

  init();
})();
