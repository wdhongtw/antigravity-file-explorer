/**
 * @fileoverview Session File Explorer Frontend (`explorer_ui`).
 *
 * - Top clickable root-folder rows supporting session workspaces, project folders,
 *   MCP-registered session folders (`folder_*`), and brain/artifact directory.
 * - Expandable hierarchical folder tree + recursive search within selected root.
 * - Opens files directly in the built-in AuxPane File Preview (`fileView`).
 * - Scoped inline file mutations (New File, New Folder, Rename, Delete).
 */
(() => {
  const POLL_INTERVAL_MS = 4000;
  const MAX_TREE_DEPTH = 32;
  const $ = (id) => document.getElementById(id);

  const state = {
    conversationId: '',
    projectId: '',
    projectName: '',
    isForkedSession: false,
    parentConversationId: '',
    focusedPath: '',
    lastFocusedStep: -1,
    roots: [],
    selectedRootPath: '',
    selectedItemPath: '',
    selectedItemIsDir: false,
    showHidden: true,
    live: true,
    // Per-root expanded directory paths: Map<rootPath, Set<dirPath>>
    expandedByRoot: new Map(),
    // Cached directory listings: Map<`${rootPath}::${dirPath}::${showHidden}`, Array<Entry>>
    dirCache: new Map(),
    loadingDirs: new Set(),
    searchQuery: '',
    searchResults: null,
    searching: false,
    // Inline mutation state: { mode: 'new-file'|'new-folder'|'rename'|'delete', targetDir, targetPath, targetName }
    mutation: null,
  };

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  function setHtmlIfChanged(el, nextHtml) {
    if (!el) return;
    if (el._lastHtml !== nextHtml) {
      el.innerHTML = nextHtml;
      el._lastHtml = nextHtml;
    }
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
  }

  const urlParams = new URLSearchParams(window.location.search);
  const sidecarToken = urlParams.get('token') || '';

  function syncThemeScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #18181b)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
  }
  syncThemeScheme();
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'theme-change') {
      const vars = event.data.payload?.cssVariables || {};
      for (const [key, value] of Object.entries(vars)) {
        document.documentElement.style.setProperty(key, value);
      }
      syncThemeScheme();
    }
  });
  new MutationObserver(syncThemeScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  function resolveConversationId() {
    return urlParams.get('conversationId') || window.sidecar?.conversationId || '';
  }

  async function apiGet(path, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        qs.set(k, String(v));
      }
    }
    const url = qs.toString() ? `${path}?${qs.toString()}` : path;
    const headers = {};
    if (sidecarToken) {
      headers['X-Sidecar-Token'] = sidecarToken;
    }
    const res = await fetch(url, { method: 'GET', headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function apiPost(path, body = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (sidecarToken) {
      headers['X-Sidecar-Token'] = sidecarToken;
    }
    const res = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  function sourceTagText(src) {
    switch (src) {
      case 'workspace':
        return 'Workspace';
      case 'project':
        return 'Project';
      case 'mcp':
        return 'MCP';
      case 'artifact':
        return 'Artifact';
      default:
        return src;
    }
  }

  function getExpandedSet(rootPath) {
    if (!state.expandedByRoot.has(rootPath)) {
      state.expandedByRoot.set(rootPath, new Set([rootPath]));
    }
    return state.expandedByRoot.get(rootPath);
  }

  function cacheKey(rootPath, dirPath) {
    return `${rootPath}::${dirPath}::${state.showHidden}`;
  }

  function pruneExpandedAndCachePrefix(rootPath, oldPrefix, newPrefix = '') {
    const exp = getExpandedSet(rootPath);
    for (const dirPath of [...exp]) {
      if (dirPath === oldPrefix || dirPath.startsWith(`${oldPrefix}/`)) {
        exp.delete(dirPath);
        if (newPrefix) {
          exp.add(newPrefix + dirPath.slice(oldPrefix.length));
        }
      }
    }
    for (const k of [...state.dirCache.keys()]) {
      if (k.startsWith(`${rootPath}::${oldPrefix}`)) {
        state.dirCache.delete(k);
      }
    }
  }

  /**
   * Opens a file in the built-in AuxPane File Preview (`fileView`).
   */
  function openInNativeFileViewer(absPath, rawUri = '') {
    const fileUri =
      rawUri || (absPath.startsWith('file://') ? absPath : `file://${absPath}`);
    const fileName = absPath.split('/').pop() || absPath;

    if (window.sidecar?.ui?.toggleAuxPane) {
      window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri: fileUri });
      showToast(`Opened ${fileName}`);
      return;
    }
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(
        { type: 'toggle-aux-pane', payload: { tabType: 'fileView', uri: fileUri } },
        '*'
      );
      showToast(`Opened ${fileName}`);
      return;
    }
    navigator.clipboard?.writeText(absPath);
    showToast(`Copied path: ${absPath}`);
  }

  function renderHeaderAndRoots() {
    $('count-roots').textContent = String(state.roots.length);

    const forkBadge = $('fork-badge');
    if (forkBadge) {
      if (state.isForkedSession) {
        const parentShort = state.parentConversationId
          ? state.parentConversationId.slice(0, 8)
          : 'parent';
        forkBadge.textContent = `fork:${parentShort}`;
        forkBadge.title = state.parentConversationId
          ? `Forked from conversation ${state.parentConversationId}`
          : 'Forked session';
        forkBadge.classList.remove('hidden');
      } else {
        forkBadge.classList.add('hidden');
      }
    }

    const listEl = $('root-list');
    const toolbarEl = $('explorer-toolbar');

    if (state.roots.length === 0) {
      setHtmlIfChanged(
        listEl,
        '<div class="empty-state">No associated folders in this session</div>'
      );
      toolbarEl.classList.add('hidden');
      return;
    }

    const rowsHtml = state.roots
      .map((r) => {
        const isSelected = r.path === state.selectedRootPath;
        const sourceBadges = r.sources
          .map((s) => `<span class="source-pill src-${esc(s)}">${esc(sourceTagText(s))}</span>`)
          .join('');

        const rightBadges = [];
        if (isSelected) {
          rightBadges.push('<span class="source-pill src-active">Active</span>');
        }
        if (r.isFocused && !isSelected) {
          rightBadges.push('<span class="source-pill src-focused" title="Focused session folder">Focused</span>');
        }
        if (r.inheritedFromFork) {
          rightBadges.push('<span class="source-pill src-inherited" title="Inherited from parent conversation fork">Inherited</span>');
        }
        if (!r.existsOnDisk) {
          rightBadges.push('<span class="source-pill src-missing">Missing</span>');
        }

        const labelHtml =
          r.label && r.label !== r.name
            ? `<span class="root-row-label">· ${esc(r.label)}</span>`
            : '';

        return `
          <button
            type="button"
            class="root-row${isSelected ? ' active' : ''}"
            data-select-root="${esc(r.path)}"
            role="option"
            aria-selected="${isSelected ? 'true' : 'false'}"
            title="${esc(r.path)}"
          >
            <div class="root-row-top">
              <div class="root-row-title-group">
                <span class="root-active-dot" aria-hidden="true"></span>
                ${sourceBadges}
                <span class="root-row-name">${esc(r.name)}</span>
                ${labelHtml}
              </div>
              <div class="root-row-badges">${rightBadges.join('')}</div>
            </div>
            <div class="root-row-bottom">
              <code class="root-row-path">${esc(r.displayPath)}</code>
            </div>
          </button>`;
      })
      .join('');

    setHtmlIfChanged(listEl, rowsHtml);

    const activeRoot = state.roots.find((r) => r.path === state.selectedRootPath);
    if (!activeRoot) {
      toolbarEl.classList.add('hidden');
      return;
    }
    toolbarEl.classList.remove('hidden');
  }

  function getActiveParentDirForCreate() {
    if (!state.selectedRootPath) return '';
    if (!state.selectedItemPath) return state.selectedRootPath;
    if (state.selectedItemIsDir) return state.selectedItemPath;
    const idx = state.selectedItemPath.lastIndexOf('/');
    if (idx > 0 && state.selectedItemPath.startsWith(state.selectedRootPath)) {
      const parent = state.selectedItemPath.slice(0, idx);
      if (parent.startsWith(state.selectedRootPath)) return parent;
    }
    return state.selectedRootPath;
  }

  function renderMutationBar() {
    const bar = $('mutation-bar');
    const m = state.mutation;
    if (!m) {
      bar.classList.add('hidden');
      bar.innerHTML = '';
      return;
    }

    bar.classList.remove('hidden');
    const relTarget =
      m.targetDir && m.targetDir.startsWith(state.selectedRootPath)
        ? m.targetDir.slice(state.selectedRootPath.length).replace(/^\/+/, '') || '/'
        : '/';

    if (m.mode === 'delete') {
      const relItem =
        m.targetPath.startsWith(state.selectedRootPath)
          ? m.targetPath.slice(state.selectedRootPath.length).replace(/^\/+/, '')
          : m.targetName;
      bar.innerHTML = `
        <div class="mutation-title">Delete <code>${esc(relItem)}</code> permanently?</div>
        <div class="mutation-controls">
          <button type="button" id="btn-mutation-confirm" class="ghost-btn danger">Delete</button>
          <button type="button" id="btn-mutation-cancel" class="ghost-btn">Cancel</button>
        </div>`;
      return;
    }

    const titleText =
      m.mode === 'new-file'
        ? `New file in <code>${esc(relTarget)}</code>`
        : m.mode === 'new-folder'
        ? `New folder in <code>${esc(relTarget)}</code>`
        : `Rename <code>${esc(m.targetName)}</code>`;

    const placeholder =
      m.mode === 'new-file'
        ? 'filename.ext'
        : m.mode === 'new-folder'
        ? 'folder-name'
        : 'new-name';

    const confirmLabel = m.mode === 'rename' ? 'Rename' : 'Create';

    bar.innerHTML = `
      <div class="mutation-title">${titleText}</div>
      <div class="mutation-controls">
        <input
          id="mutation-input"
          type="text"
          class="mutation-input"
          placeholder="${esc(placeholder)}"
          value="${esc(m.initialValue || '')}"
          autocomplete="off"
        >
        <button type="button" id="btn-mutation-confirm" class="ghost-btn primary">${confirmLabel}</button>
        <button type="button" id="btn-mutation-cancel" class="ghost-btn">Cancel</button>
      </div>`;

    const inputEl = $('mutation-input');
    if (inputEl) {
      inputEl.focus();
      inputEl.select();
    }
  }

  function folderSvg(isOpen) {
    if (isOpen) {
      return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M1.5 4C1.5 3.17 2.17 2.5 3 2.5h3.17c.4 0 .78.16 1.06.44l1.12 1.12c.28.28.66.44 1.06.44H13c.83 0 1.5.67 1.5 1.5v1H2.8L1.5 12V4Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
        <path d="M2.6 7h11.65l-1.35 5.5H1.5L2.6 7Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
      </svg>`;
    }
    return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.5 4C1.5 3.17 2.17 2.5 3 2.5h3.17c.4 0 .78.16 1.06.44l1.12 1.12c.28.28.66.44 1.06.44H13c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5H3c-.83 0-1.5-.67-1.5-1.5V4Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
    </svg>`;
  }

  function fileSvg() {
    return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 2.5h5.8L12.5 5.7v7.8c0 .55-.45 1-1 1h-8c-.55 0-1-.45-1-1v-10c0-.55.45-1 1-1Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
      <path d="M9 2.5v3.5h3.5" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
    </svg>`;
  }

  function renderTreeRowsHtml(rootPath, dirPath, depth, expandedSet) {
    if (depth > MAX_TREE_DEPTH) return '';
    const key = cacheKey(rootPath, dirPath);
    const entries = state.dirCache.get(key);
    const padLeft = 6 + depth * 14;

    if (!entries) {
      if (state.loadingDirs.has(dirPath)) {
        return `<div class="tree-empty-dir" style="padding-left:${padLeft}px">Loading…</div>`;
      }
      return '';
    }

    if (entries.length === 0) {
      return `<div class="tree-empty-dir" style="padding-left:${padLeft}px">(empty folder)</div>`;
    }

    const htmlParts = [];
    for (const entry of entries) {
      const isExpanded = entry.isDirectory && expandedSet.has(entry.path);
      const isSelected = entry.path === state.selectedItemPath;
      const caret = entry.isDirectory ? (isExpanded ? '&#9662;' : '&#9656;') : '';
      const icon = entry.isDirectory ? folderSvg(isExpanded) : fileSvg();
      const symlinkBadge = entry.isSymlink ? '<span class="symlink-badge">symlink</span>' : '';

      const actionsHtml = entry.isDirectory
        ? `
          <button type="button" class="row-btn" data-action="new-file" data-path="${esc(entry.path)}" title="New file in ${esc(entry.name)}">+File</button>
          <button type="button" class="row-btn" data-action="new-folder" data-path="${esc(entry.path)}" title="New folder in ${esc(entry.name)}">+Dir</button>
          <button type="button" class="row-btn" data-action="copy-path" data-path="${esc(entry.path)}" title="Copy path">Copy</button>
          <button type="button" class="row-btn" data-action="rename" data-path="${esc(entry.path)}" data-name="${esc(entry.name)}" title="Rename">Ren</button>
          <button type="button" class="row-btn danger" data-action="delete" data-path="${esc(entry.path)}" data-name="${esc(entry.name)}" title="Delete">Del</button>`
        : `
          <button type="button" class="row-btn" data-action="open-file" data-path="${esc(entry.path)}" data-uri="${esc(entry.uri)}" title="Open in native File Preview">Open</button>
          <button type="button" class="row-btn" data-action="copy-path" data-path="${esc(entry.path)}" title="Copy path">Copy</button>
          <button type="button" class="row-btn" data-action="rename" data-path="${esc(entry.path)}" data-name="${esc(entry.name)}" title="Rename">Ren</button>
          <button type="button" class="row-btn danger" data-action="delete" data-path="${esc(entry.path)}" data-name="${esc(entry.name)}" title="Delete">Del</button>`;

      htmlParts.push(`
        <div
          class="tree-row${entry.isDirectory ? ' is-dir' : ' is-file'}${isSelected ? ' selected' : ''}"
          style="padding-left:${padLeft}px"
          data-row-path="${esc(entry.path)}"
          data-row-uri="${esc(entry.uri)}"
          data-row-isdir="${entry.isDirectory ? '1' : '0'}"
          role="treeitem"
          aria-expanded="${entry.isDirectory ? String(isExpanded) : 'false'}"
        >
          <div class="tree-row-left">
            <span class="tree-caret">${caret}</span>
            <span class="tree-icon ${entry.isDirectory ? 'dir-icon' : 'file-icon'}">${icon}</span>
            <span class="tree-name" title="${esc(entry.relPath || entry.name)}">${esc(entry.name)}</span>
            ${symlinkBadge}
          </div>
          <div class="tree-row-right">
            ${!entry.isDirectory ? `<span class="file-size">${esc(formatBytes(entry.size))}</span>` : ''}
            <div class="row-actions">${actionsHtml}</div>
          </div>
        </div>`);

      if (entry.isDirectory && isExpanded) {
        htmlParts.push(renderTreeRowsHtml(rootPath, entry.path, depth + 1, expandedSet));
      }
    }

    return htmlParts.join('');
  }

  function renderSearchResultsHtml() {
    const container = $('tree-container');
    if (state.searching && !state.searchResults) {
      setHtmlIfChanged(container, '<div class="empty-state">Searching files…</div>');
      return;
    }

    const results = state.searchResults?.results || [];
    const headerHtml = `
      <div class="search-header">
        <span>Search results for <strong>"${esc(state.searchQuery)}"</strong> (${results.length}${state.searchResults?.truncated ? '+' : ''})</span>
        <button type="button" class="ghost-btn sm" id="btn-clear-search">Clear</button>
      </div>`;

    if (results.length === 0) {
      setHtmlIfChanged(
        container,
        headerHtml + '<div class="empty-state">No matching files or folders in this root.</div>'
      );
      return;
    }

    const rowsHtml = results
      .map((entry) => {
        const isSelected = entry.path === state.selectedItemPath;
        const icon = entry.isDirectory ? folderSvg(false) : fileSvg();
        return `
          <div
            class="tree-row${entry.isDirectory ? ' is-dir' : ' is-file'}${isSelected ? ' selected' : ''}"
            data-search-path="${esc(entry.path)}"
            data-row-uri="${esc(entry.uri)}"
            data-row-isdir="${entry.isDirectory ? '1' : '0'}"
          >
            <div class="tree-row-left">
              <span class="tree-icon ${entry.isDirectory ? 'dir-icon' : 'file-icon'}">${icon}</span>
              <span class="tree-name">${esc(entry.name)}</span>
              <span class="tree-relpath" title="${esc(entry.relPath)}">${esc(entry.relPath)}</span>
            </div>
            <div class="tree-row-right">
              ${!entry.isDirectory ? `<span class="file-size">${esc(formatBytes(entry.size))}</span>` : ''}
              <div class="row-actions">
                ${!entry.isDirectory ? `<button type="button" class="row-btn" data-action="open-file" data-path="${esc(entry.path)}" data-uri="${esc(entry.uri)}">Open</button>` : ''}
                <button type="button" class="row-btn" data-action="reveal-in-tree" data-path="${esc(entry.path)}" data-isdir="${entry.isDirectory ? '1' : '0'}">Reveal</button>
                <button type="button" class="row-btn" data-action="copy-path" data-path="${esc(entry.path)}">Copy</button>
              </div>
            </div>
          </div>`;
      })
      .join('');

    setHtmlIfChanged(container, headerHtml + rowsHtml);
  }

  function renderExplorerBody() {
    const container = $('tree-container');
    const activeRoot = state.roots.find((r) => r.path === state.selectedRootPath);

    if (!activeRoot) {
      setHtmlIfChanged(
        container,
        `<div class="empty-state">
          <div>No root folders associated with this session yet.</div>
          <div class="empty-hint">
            Register an on-premise folder using the <code>folder_register</code> MCP tool.
          </div>
        </div>`
      );
      return;
    }

    if (!activeRoot.existsOnDisk) {
      setHtmlIfChanged(
        container,
        `<div class="empty-state">
          <div>Directory does not currently exist on disk:</div>
          <div class="empty-hint"><code>${esc(activeRoot.path)}</code></div>
        </div>`
      );
      return;
    }

    if (state.searchQuery.trim()) {
      renderSearchResultsHtml();
      return;
    }

    const expandedSet = getExpandedSet(activeRoot.path);
    setHtmlIfChanged(
      container,
      renderTreeRowsHtml(activeRoot.path, activeRoot.path, 0, expandedSet)
    );
  }

  async function loadDirectory(rootPath, dirPath, { silent = false } = {}) {
    if (!rootPath || !dirPath) return;
    if (!silent) {
      state.loadingDirs.add(dirPath);
      renderExplorerBody();
    }
    try {
      const res = await apiGet('/api/list', {
        root: rootPath,
        path: dirPath,
        showHidden: state.showHidden,
      });
      if (res.existsOnDisk === false && dirPath !== rootPath) {
        pruneExpandedAndCachePrefix(rootPath, dirPath);
      } else {
        state.dirCache.set(cacheKey(rootPath, dirPath), res.entries || []);
      }
    } catch (err) {
      if (!silent) {
        showToast(`Failed to list folder: ${err.message}`);
      }
    } finally {
      state.loadingDirs.delete(dirPath);
      renderExplorerBody();
    }
  }

  async function refreshExpandedDirectories(rootPath, { silent = false } = {}) {
    if (!rootPath) return;
    const activeRoot = state.roots.find((r) => r.path === rootPath);
    if (!activeRoot || !activeRoot.existsOnDisk) {
      renderExplorerBody();
      return;
    }
    const expandedSet = getExpandedSet(rootPath);
    expandedSet.add(rootPath);
    await Promise.all(
      [...expandedSet].map((dirPath) => loadDirectory(rootPath, dirPath, { silent }))
    );
  }

  let searchTimer = null;
  function triggerSearch() {
    clearTimeout(searchTimer);
    const q = state.searchQuery.trim();
    if (!q || !state.selectedRootPath) {
      state.searchResults = null;
      state.searching = false;
      renderExplorerBody();
      return;
    }
    state.searching = true;
    renderExplorerBody();
    searchTimer = setTimeout(async () => {
      const rootAtStart = state.selectedRootPath;
      const queryAtStart = q;
      try {
        const res = await apiGet('/api/search', {
          root: rootAtStart,
          q: queryAtStart,
          showHidden: state.showHidden,
        });
        if (state.selectedRootPath === rootAtStart && state.searchQuery.trim() === queryAtStart) {
          state.searchResults = res;
        }
      } catch (err) {
        showToast(`Search error: ${err.message}`);
      } finally {
        state.searching = false;
        renderExplorerBody();
      }
    }, 160);
  }

  async function selectRootFolder(nextRootPath) {
    if (!nextRootPath) return;
    const changed = state.selectedRootPath !== nextRootPath;
    state.selectedRootPath = nextRootPath;
    if (changed) {
      state.selectedItemPath = nextRootPath;
      state.selectedItemIsDir = true;
      state.mutation = null;
      renderMutationBar();
    }
    renderHeaderAndRoots();
    if (state.searchQuery.trim()) {
      triggerSearch();
    } else {
      await refreshExpandedDirectories(nextRootPath, { silent: false });
    }
  }

  async function refreshAll({ silent = false } = {}) {
    try {
      const data = await apiGet('/api/roots', {
        conversationId: state.conversationId,
      });
      state.roots = data.folders || [];
      state.projectId = data.projectId || '';
      state.projectName = data.projectName || '';
      state.focusedPath = data.focusedPath || '';
      state.isForkedSession = Boolean(data.isForkedSession);
      state.parentConversationId = data.parentConversationId || '';

      const newFocusedStep = Number(data.focusedStep ?? -1);
      const newFocusedPath = data.focusedPath || '';

      if (state.roots.length === 0) {
        state.selectedRootPath = '';
        renderHeaderAndRoots();
        renderExplorerBody();
        return;
      }

      if (
        newFocusedPath &&
        newFocusedStep > state.lastFocusedStep &&
        state.roots.some((r) => r.path === newFocusedPath)
      ) {
        state.lastFocusedStep = newFocusedStep;
        state.selectedRootPath = newFocusedPath;
      } else if (!state.roots.some((r) => r.path === state.selectedRootPath)) {
        state.selectedRootPath = newFocusedPath || state.roots[0].path;
      }

      renderHeaderAndRoots();
      if (!state.searchQuery.trim()) {
        await refreshExpandedDirectories(state.selectedRootPath, { silent });
      }
    } catch (err) {
      if (!silent) {
        setHtmlIfChanged(
          $('tree-container'),
          `<div class="empty-state">Error loading session folders: ${esc(err.message)}</div>`
        );
      }
    }
  }

  async function revealInTree(targetPath, isDir) {
    const rootPath = state.selectedRootPath;
    if (!rootPath || !targetPath.startsWith(rootPath)) return;

    state.searchQuery = '';
    state.searchResults = null;
    if ($('search-input')) $('search-input').value = '';

    const expandedSet = getExpandedSet(rootPath);
    expandedSet.add(rootPath);

    const rel = targetPath.slice(rootPath.length).replace(/^\/+/, '');
    const parts = rel ? rel.split('/') : [];
    const dirCount = isDir ? parts.length : Math.max(0, parts.length - 1);
    let current = rootPath;
    for (let i = 0; i < dirCount; i++) {
      current = `${current}/${parts[i]}`;
      expandedSet.add(current);
    }

    state.selectedItemPath = targetPath;
    state.selectedItemIsDir = isDir;
    await refreshExpandedDirectories(rootPath, { silent: false });
  }

  async function executeMutation() {
    const m = state.mutation;
    if (!m || !state.selectedRootPath) return;

    try {
      if (m.mode === 'delete') {
        await apiPost('/api/delete', {
          root: state.selectedRootPath,
          path: m.targetPath,
        });
        pruneExpandedAndCachePrefix(state.selectedRootPath, m.targetPath);
        showToast(`Deleted ${m.targetName}`);
        if (
          state.selectedItemPath === m.targetPath ||
          state.selectedItemPath.startsWith(`${m.targetPath}/`)
        ) {
          state.selectedItemPath = state.selectedRootPath;
          state.selectedItemIsDir = true;
        }
      } else {
        const inputVal = ($('mutation-input')?.value || '').trim();
        if (!inputVal) {
          showToast('Please enter a name');
          return;
        }
        if (m.mode === 'new-file') {
          const res = await apiPost('/api/create-file', {
            root: state.selectedRootPath,
            parentDir: m.targetDir,
            name: inputVal,
            content: '',
          });
          getExpandedSet(state.selectedRootPath).add(m.targetDir);
          state.selectedItemPath = res.path;
          state.selectedItemIsDir = false;
          showToast(`Created ${res.name}`);
          openInNativeFileViewer(res.path, res.uri);
        } else if (m.mode === 'new-folder') {
          const res = await apiPost('/api/create-directory', {
            root: state.selectedRootPath,
            parentDir: m.targetDir,
            name: inputVal,
          });
          const exp = getExpandedSet(state.selectedRootPath);
          exp.add(m.targetDir);
          exp.add(res.path);
          state.selectedItemPath = res.path;
          state.selectedItemIsDir = true;
          showToast(`Created folder ${res.name}`);
        } else if (m.mode === 'rename') {
          const res = await apiPost('/api/rename', {
            root: state.selectedRootPath,
            oldPath: m.targetPath,
            newName: inputVal,
          });
          pruneExpandedAndCachePrefix(state.selectedRootPath, m.targetPath, res.path);
          state.selectedItemPath = res.path;
          showToast(`Renamed to ${res.name}`);
        }
      }

      state.mutation = null;
      renderMutationBar();
      await refreshExpandedDirectories(state.selectedRootPath, { silent: false });
      if (state.searchQuery.trim()) {
        triggerSearch();
      }
    } catch (err) {
      showToast(err.message);
    }
  }

  // Event Delegation
  document.addEventListener('click', async (e) => {
    const rootRow = e.target.closest('[data-select-root]');
    if (rootRow) {
      await selectRootFolder(rootRow.dataset.selectRoot);
      return;
    }

    if (e.target.closest('#btn-clear-search')) {
      state.searchQuery = '';
      state.searchResults = null;
      if ($('search-input')) $('search-input').value = '';
      await refreshExpandedDirectories(state.selectedRootPath, { silent: false });
      return;
    }

    if (e.target.closest('#btn-mutation-confirm')) {
      await executeMutation();
      return;
    }

    if (e.target.closest('#btn-mutation-cancel')) {
      state.mutation = null;
      renderMutationBar();
      return;
    }

    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      e.stopPropagation();
      const action = actionBtn.dataset.action;
      const targetPath = actionBtn.dataset.path || '';
      const targetName = actionBtn.dataset.name || targetPath.split('/').pop() || '';

      if (action === 'open-file') {
        openInNativeFileViewer(targetPath, actionBtn.dataset.uri || '');
        return;
      }
      if (action === 'copy-path') {
        try {
          await navigator.clipboard.writeText(targetPath);
          showToast('Copied path');
        } catch {
          showToast(targetPath);
        }
        return;
      }
      if (action === 'reveal-in-tree') {
        await revealInTree(targetPath, actionBtn.dataset.isdir === '1');
        return;
      }
      if (action === 'new-file' || action === 'new-folder') {
        state.mutation = {
          mode: action,
          targetDir: targetPath || state.selectedRootPath,
          initialValue: '',
        };
        renderMutationBar();
        return;
      }
      if (action === 'rename') {
        state.mutation = {
          mode: 'rename',
          targetPath,
          targetName,
          initialValue: targetName,
        };
        renderMutationBar();
        return;
      }
      if (action === 'delete') {
        state.mutation = {
          mode: 'delete',
          targetPath,
          targetName,
        };
        renderMutationBar();
        return;
      }
    }

    const searchRow = e.target.closest('[data-search-path]');
    if (searchRow) {
      const path = searchRow.dataset.searchPath;
      const isDir = searchRow.dataset.rowIsdir === '1';
      state.selectedItemPath = path;
      state.selectedItemIsDir = isDir;
      if (isDir) {
        await revealInTree(path, true);
      } else {
        renderExplorerBody();
        openInNativeFileViewer(path, searchRow.dataset.rowUri || '');
      }
      return;
    }

    const treeRow = e.target.closest('[data-row-path]');
    if (treeRow) {
      const path = treeRow.dataset.rowPath;
      const isDir = treeRow.dataset.rowIsdir === '1';
      state.selectedItemPath = path;
      state.selectedItemIsDir = isDir;

      if (isDir) {
        const exp = getExpandedSet(state.selectedRootPath);
        if (exp.has(path)) {
          exp.delete(path);
          renderExplorerBody();
        } else {
          exp.add(path);
          await loadDirectory(state.selectedRootPath, path, { silent: false });
        }
      } else {
        renderExplorerBody();
        openInNativeFileViewer(path, treeRow.dataset.rowUri || '');
      }
    }
  });

  document.addEventListener('keydown', async (e) => {
    if (!state.mutation) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      state.mutation = null;
      renderMutationBar();
    } else if (e.key === 'Enter' && e.target.id === 'mutation-input') {
      e.preventDefault();
      await executeMutation();
    }
  });

  $('btn-refresh')?.addEventListener('click', () => {
    showToast('Refreshing file explorer…');
    refreshAll({ silent: false });
  });

  $('chk-live')?.addEventListener('change', (e) => {
    state.live = e.target.checked;
  });

  $('chk-hidden')?.addEventListener('change', async (e) => {
    state.showHidden = e.target.checked;
    if (state.searchQuery.trim()) {
      triggerSearch();
    } else {
      await refreshExpandedDirectories(state.selectedRootPath, { silent: false });
    }
  });

  $('search-input')?.addEventListener('input', (e) => {
    state.searchQuery = e.target.value || '';
    triggerSearch();
  });

  $('btn-new-file')?.addEventListener('click', () => {
    if (!state.selectedRootPath) return;
    state.mutation = {
      mode: 'new-file',
      targetDir: getActiveParentDirForCreate(),
      initialValue: '',
    };
    renderMutationBar();
  });

  $('btn-new-folder')?.addEventListener('click', () => {
    if (!state.selectedRootPath) return;
    state.mutation = {
      mode: 'new-folder',
      targetDir: getActiveParentDirForCreate(),
      initialValue: '',
    };
    renderMutationBar();
  });

  $('btn-copy-root')?.addEventListener('click', async () => {
    if (!state.selectedRootPath) return;
    try {
      await navigator.clipboard.writeText(state.selectedRootPath);
      showToast('Copied root folder path');
    } catch {
      showToast(state.selectedRootPath);
    }
  });

  $('btn-collapse-all')?.addEventListener('click', () => {
    if (!state.selectedRootPath) return;
    state.expandedByRoot.set(state.selectedRootPath, new Set([state.selectedRootPath]));
    renderExplorerBody();
  });

  async function init() {
    state.conversationId = resolveConversationId();
    if (state.conversationId) {
      const badge = $('conv-badge');
      badge.textContent = `conv:${state.conversationId.slice(0, 8)}`;
      badge.classList.remove('hidden');
    }

    await refreshAll({ silent: false });

    setInterval(() => {
      if (state.live && !document.hidden && !state.mutation) {
        refreshAll({ silent: true });
      }
    }, POLL_INTERVAL_MS);
  }

  init();
})();
