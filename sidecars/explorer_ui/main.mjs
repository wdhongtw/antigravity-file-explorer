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
  renamePathInRoot,
  searchFilesInRoot,
  transferItemsInRoot,
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

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));
app.page('/fullscreen', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));
app.page('/sidebar', () => readFileSync(join(__dirname, 'sidebar.html'), 'utf-8'));

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

for (const watched of [
  join(__dirname, 'main.mjs'),
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
