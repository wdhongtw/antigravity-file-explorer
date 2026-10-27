/**
 * @fileoverview Session File Explorer Sidecar Backend (`explorer_ui`).
 *
 * Serves the File Explorer web UI and JSON APIs for listing session/project/MCP
 * root folders, browsing directory hierarchies, searching files, and performing
 * scoped file mutations within the selected root folder.
 */

import { readFileSync, watchFile } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDirectoryInRoot,
  createFileInRoot,
  deletePathInRoot,
  listDirectoryInRoot,
  renamePathInRoot,
  searchFilesInRoot,
} from '../../lib/file_service.mjs';
import { getSessionFolderState } from '../../lib/session_folders.mjs';
import { HttpResponse, RawSidecarServer } from '../../lib/sidecar_http.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATIC_ASSETS = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const app = new RawSidecarServer();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));
app.page('/fullscreen', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

for (const [route, [file, contentType]] of Object.entries(STATIC_ASSETS)) {
  app.api(
    route,
    () => new HttpResponse(readFileSync(join(__dirname, file), 'utf-8'), { contentType }),
    'GET'
  );
}

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

app.api(
  '/api/list',
  async (data) => {
    const rootPath = data.root || '';
    const dirPath = data.path || rootPath;
    const showHidden = data.showHidden === 'true' || data.showHidden === true;
    const limit = Number.parseInt(data.limit, 10) || 500;
    return await listDirectoryInRoot(rootPath, dirPath, { showHidden, limit });
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
  '/api/create-file',
  async (data) => {
    return await createFileInRoot(
      data.root || '',
      data.parentDir || data.root || '',
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
      data.root || '',
      data.parentDir || data.root || '',
      data.name || ''
    );
  },
  'POST'
);

app.api(
  '/api/rename',
  async (data) => {
    return await renamePathInRoot(
      data.root || '',
      data.oldPath || '',
      data.newName || ''
    );
  },
  'POST'
);

app.api(
  '/api/delete',
  async (data) => {
    return await deletePathInRoot(data.root || '', data.path || '');
  },
  'POST'
);

for (const watched of [
  join(__dirname, 'main.mjs'),
  join(__dirname, '../../lib/session_folders.mjs'),
  join(__dirname, '../../lib/file_service.mjs'),
]) {
  watchFile(watched, { interval: 2000 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) {
      process.exit(0);
    }
  }).unref();
}

app.run();
