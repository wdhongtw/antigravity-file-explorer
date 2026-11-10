/**
 * @fileoverview File Explorer Sidecar Backend (`explorer_ui`).
 *
 * Serves both:
 * 1. The per-session AuxPane File Explorer (`/`, `/fullscreen`) backed by
 *    session/project/MCP root folders.
 * 2. The global Sidebar File Explorer (`/sidebar`, `SIDECAR_UI_ENTRYPOINT_SIDEBAR`)
 *    defaulting to the user's home folder with global bookmarks, file/folder
 *    manipulation, clipboard copy/cut/paste, zip/tar.gz compression & extraction,
 *    permissions (`chmod`), and an item inspector.
 */

import { readFileSync, watchFile } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chmodPathInRoot,
  compressItemsInRoot,
  createDirectoryInRoot,
  createFileInRoot,
  deletePathInRoot,
  duplicatePathInRoot,
  extractArchiveInRoot,
  inspectPathInRoot,
  listDirectoryInRoot,
  prepareDownloadInRoot,
  renamePathInRoot,
  searchFilesInRoot,
  transferItemsInRoot,
  uploadFilesInRoot,
} from '../../lib/file_service.mjs';
import { getSessionFolderState } from '../../lib/session_folders.mjs';
import { SidebarStore } from '../../lib/sidebar_store.mjs';
import { HttpResponse, RawSidecarServer } from '../../lib/sidecar_http.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATIC_ASSETS = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/sidebar.css': ['sidebar.css', 'text/css; charset=utf-8'],
  '/sidebar.js': ['sidebar.js', 'application/javascript; charset=utf-8'],
};

const app = new RawSidecarServer();
const sidebarStore = new SidebarStore();

function renderPageWithToken(htmlFile) {
  const rawHtml = readFileSync(join(__dirname, htmlFile), 'utf-8');
  const uiToken = (process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '').trim();
  const tokenScript = `<script>window.__SIDECAR_TOKEN__=${JSON.stringify(uiToken)};</script>`;
  if (rawHtml.includes('</head>')) {
    return rawHtml.replace('</head>', `  ${tokenScript}\n</head>`);
  }
  return `${tokenScript}\n${rawHtml}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

app.page('/', () => renderPageWithToken('index.html'));
app.page('/fullscreen', () => renderPageWithToken('index.html'));
app.page('/sidebar', () => renderPageWithToken('sidebar.html'));

app.page('/api/download-page', async (url) => {
  const root = url.searchParams.get('root') || '/';
  const paths = url.searchParams.getAll('path').filter(Boolean);
  const token =
    url.searchParams.get('token') ||
    (process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '').trim();

  const dlParams = new URLSearchParams();
  dlParams.set('root', root);
  for (const p of paths) {
    dlParams.append('path', p);
  }
  if (token) {
    dlParams.set('token', token);
  }
  const downloadHref = `/api/download?${dlParams.toString()}`;
  const label =
    paths.length === 1
      ? paths[0].split('/').filter(Boolean).pop() || 'download'
      : `${paths.length} items (.zip)`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Downloading ${escapeHtml(label)}…</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #18181b;
      color: #f4f4f5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .card {
      padding: 20px 24px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: #27272a;
      max-width: 420px;
      text-align: center;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    }
    .title {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 8px;
      word-break: break-all;
    }
    .sub {
      font-size: 12px;
      color: #a1a1aa;
      margin-bottom: 16px;
    }
    .actions {
      display: flex;
      gap: 8px;
      justify-content: center;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      text-decoration: none;
      cursor: pointer;
      border: 1px solid rgba(255, 255, 255, 0.18);
      background: #3b82f6;
      color: #ffffff;
    }
    .btn-ghost {
      background: transparent;
      color: #d4d4d8;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="title">Downloading ${escapeHtml(label)}</div>
    <div class="sub">Your download should begin automatically. This tab will close shortly.</div>
    <div class="actions">
      <a id="dl-link" class="btn" href="${escapeHtml(downloadHref)}" download>Download Now</a>
      <button type="button" class="btn btn-ghost" onclick="window.close()">Close Tab</button>
    </div>
  </div>
  <script>
    (function () {
      const link = document.getElementById('dl-link');
      if (link) {
        link.click();
      }
      setTimeout(function () {
        try { window.close(); } catch (_) {}
      }, 2000);
    })();
  </script>
</body>
</html>`;
});

for (const [route, [file, contentType]] of Object.entries(STATIC_ASSETS)) {
  app.api(
    route,
    () => new HttpResponse(readFileSync(join(__dirname, file), 'utf-8'), { contentType }),
    'GET'
  );
}

// Per-session AuxPane roots
app.api(
  '/api/roots',
  async (data) => {
    const conversationId = data.conversationId || app.config.conversationId || '';
    const state = await getSessionFolderState(conversationId);
    return {
      ...state,
      timestamp: Date.now(),
    };
  },
  'GET'
);

// Global Sidebar state & bookmark management
app.api(
  '/api/sidebar/state',
  async () => {
    return {
      ok: true,
      ...sidebarStore.getState(),
      timestamp: Date.now(),
    };
  },
  'GET'
);

app.api(
  '/api/sidebar/navigate',
  async (data) => {
    const nextState = sidebarStore.setCurrentDir(data.path || '');
    return {
      ok: true,
      ...nextState,
    };
  },
  'POST'
);

app.api(
  '/api/sidebar/bookmark',
  async (data) => {
    const nextState = sidebarStore.addBookmark(data.path || '', data.label || '');
    return {
      ok: true,
      ...nextState,
    };
  },
  'POST'
);

app.api(
  '/api/sidebar/unbookmark',
  async (data) => {
    const nextState = sidebarStore.removeBookmark(data.path || '');
    return {
      ok: true,
      ...nextState,
    };
  },
  'POST'
);

app.api(
  '/api/sidebar/settings',
  async (data) => {
    const nextState = sidebarStore.updateSettings(data || {});
    return {
      ok: true,
      ...nextState,
    };
  },
  'POST'
);

// Shared & Global File Service endpoints
app.api(
  '/api/list',
  async (data) => {
    const rootPath = data.root || '/';
    const dirPath = data.path || rootPath;
    const showHidden = data.showHidden === 'true' || data.showHidden === true;
    const limit = Number.parseInt(data.limit, 10) || 500;
    const sortBy = data.sortBy || 'name';
    const sortDir = data.sortDir || 'asc';
    return await listDirectoryInRoot(rootPath, dirPath, {
      showHidden,
      limit,
      sortBy,
      sortDir,
    });
  },
  'GET'
);

app.api(
  '/api/search',
  async (data) => {
    const rootPath = data.root || '';
    const query = data.q ?? data.query ?? '';
    const showHidden = data.showHidden === 'true' || data.showHidden === true;
    const maxResults = Number.parseInt(data.maxResults, 10) || 150;
    return await searchFilesInRoot(rootPath, query, { showHidden, maxResults });
  },
  'GET'
);

app.api(
  '/api/inspect',
  async (data) => {
    const rootPath = data.root || '/';
    const targetPath = data.path || '';
    const includeHash = data.includeHash === 'true' || data.includeHash === true;
    const includeFolderSize =
      data.includeFolderSize === 'true' || data.includeFolderSize === true;
    return await inspectPathInRoot(rootPath, targetPath, {
      includeHash,
      includeFolderSize,
    });
  },
  'GET'
);

app.api(
  '/api/create-file',
  async (data) => {
    return await createFileInRoot(
      data.root || '/',
      data.parentDir || data.root || '/',
      data.name || '',
      data.content || ''
    );
  },
  'POST'
);

app.api(
  '/api/create-directory',
  async (data) => {
    return await createDirectoryInRoot(
      data.root || '/',
      data.parentDir || data.root || '/',
      data.name || ''
    );
  },
  'POST'
);

app.api(
  '/api/rename',
  async (data) => {
    return await renamePathInRoot(
      data.root || '/',
      data.oldPath || '',
      data.newName || ''
    );
  },
  'POST'
);

app.api(
  '/api/delete',
  async (data) => {
    const root = data.root || '/';
    if (Array.isArray(data.paths) && data.paths.length > 0) {
      const deleted = [];
      for (const p of data.paths) {
        const res = await deletePathInRoot(root, p);
        deleted.push(res.deletedPath);
      }
      return { ok: true, count: deleted.length, deletedPaths: deleted };
    }
    return await deletePathInRoot(root, data.path || '');
  },
  'POST'
);

app.api(
  '/api/duplicate',
  async (data) => {
    return await duplicatePathInRoot(
      data.root || '/',
      data.path || '',
      data.newName || ''
    );
  },
  'POST'
);

app.api(
  '/api/transfer',
  async (data) => {
    return await transferItemsInRoot(
      data.root || '/',
      data.sourcePaths || [],
      data.destDir || '',
      {
        mode: data.mode === 'move' ? 'move' : 'copy',
        overwrite: Boolean(data.overwrite),
      }
    );
  },
  'POST'
);

app.api(
  '/api/compress',
  async (data) => {
    return await compressItemsInRoot(
      data.root || '/',
      data.sourcePaths || [],
      data.destDir || '',
      data.archiveName || '',
      data.format || 'zip'
    );
  },
  'POST'
);

app.api(
  '/api/extract',
  async (data) => {
    return await extractArchiveInRoot(
      data.root || '/',
      data.archivePath || '',
      data.destDir || '',
      {
        createSubfolder: data.createSubfolder !== false,
      }
    );
  },
  'POST'
);

app.api(
  '/api/chmod',
  async (data) => {
    return await chmodPathInRoot(
      data.root || '/',
      data.path || '',
      data.mode || 'toggle-exec'
    );
  },
  'POST'
);

app.api(
  '/api/upload',
  async (data) => {
    const root = data.root || '/';
    const targetDir = data.targetDir || root;
    const overwrite = data.overwrite === 'true' || data.overwrite === true;

    if (Buffer.isBuffer(data._rawBuffer)) {
      const relPath = data.relPath || data.name || '';
      return await uploadFilesInRoot(
        root,
        targetDir,
        [{ relPath, data: data._rawBuffer }],
        { overwrite }
      );
    }

    return await uploadFilesInRoot(root, targetDir, data.files || [], {
      overwrite,
    });
  },
  'POST'
);

async function handleDownloadRequest(data) {
  const root = data.root || '/';
  const targets =
    Array.isArray(data.paths) && data.paths.length > 0
      ? data.paths
      : data.path || '';
  const dl = await prepareDownloadInRoot(root, targets);
  const asciiName = dl.filename.replace(/[^\x20-\x7E]|["\\]/g, '_');
  const encodedName = encodeURIComponent(dl.filename);
  return new HttpResponse(dl.buffer, {
    contentType: dl.contentType,
    headers: {
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
      'X-Download-Filename': encodedName,
      'Content-Length': String(dl.size),
      'Cache-Control': 'no-store',
    },
  });
}

app.api('/api/download', handleDownloadRequest, 'GET');
app.api('/api/download', handleDownloadRequest, 'POST');

for (const watched of [
  join(__dirname, 'main.mjs'),
  join(__dirname, '../../lib/sidecar_http.mjs'),
  join(__dirname, '../../lib/session_folders.mjs'),
  join(__dirname, '../../lib/sidebar_store.mjs'),
  join(__dirname, '../../lib/file_service.mjs'),
]) {
  watchFile(watched, { interval: 2000 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) {
      process.exit(0);
    }
  }).unref();
}

app.run();
