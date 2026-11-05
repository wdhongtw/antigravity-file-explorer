/**
 * @fileoverview Persistent global state store for the Sidebar File Explorer.
 *
 * Stores global bookmarks, current directory (defaults to user home directory),
 * recent directories, and UI view/sort preferences in `sidebar_state.json`
 * inside the sidecar data directory (`ANTIGRAVITY_EXECUTABLE_DATA_DIR`).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { formatFolderDisplayPath, normalizeFolderPath } from './session_folders.mjs';

const HOME = homedir();
const MAX_RECENT_DIRS = 12;

export function createDefaultBookmarks() {
  const candidates = [
    { path: HOME, label: 'Home' },
    { path: join(HOME, 'Projects'), label: 'Projects' },
    { path: join(HOME, 'Downloads'), label: 'Downloads' },
    { path: join(HOME, 'Documents'), label: 'Documents' },
    { path: '/tmp', label: 'Temp (/tmp)' },
  ];

  const seen = new Set();
  const bookmarks = [];
  for (const item of candidates) {
    const norm = normalizeFolderPath(item.path);
    if (!norm || seen.has(norm)) continue;
    if (norm === HOME || existsSync(norm)) {
      seen.add(norm);
      bookmarks.push({
        path: norm,
        name: basename(norm) || '/',
        label: item.label,
        displayPath: formatFolderDisplayPath(norm),
        addedAt: new Date().toISOString(),
      });
    }
  }
  return bookmarks;
}

export function createDefaultSidebarState() {
  return {
    currentDir: HOME,
    bookmarks: createDefaultBookmarks(),
    recentDirs: [HOME],
    settings: {
      showHidden: true,
      sortBy: 'name',
      sortDir: 'asc',
      inspectorOpen: true,
    },
  };
}

export class SidebarStore {
  #filePath;
  #state;

  constructor(storagePathOrOptions) {
    const defaultDir =
      process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
      join(HOME, '.gemini', 'sidecar_data', 'file-explorer', 'data');
    const customPath =
      typeof storagePathOrOptions === 'string'
        ? storagePathOrOptions
        : storagePathOrOptions?.filePath || storagePathOrOptions?.storagePath;
    this.#filePath = customPath || join(defaultDir, 'sidebar_state.json');
    this.#state = this.#load();
  }

  get filePath() {
    return this.#filePath;
  }

  #enrichBookmark(b) {
    const norm = normalizeFolderPath(b?.path || '');
    if (!norm) return null;
    const name = basename(norm) || '/';
    return {
      path: norm,
      name,
      label: String(b?.label || name).trim() || name,
      displayPath: formatFolderDisplayPath(norm),
      existsOnDisk: existsSync(norm),
      addedAt: b?.addedAt || new Date().toISOString(),
    };
  }

  #load() {
    const base = createDefaultSidebarState();
    try {
      if (!existsSync(this.#filePath)) {
        return base;
      }
      const raw = JSON.parse(readFileSync(this.#filePath, 'utf-8'));
      if (!raw || typeof raw !== 'object') {
        return base;
      }

      const normCurrent = normalizeFolderPath(raw.currentDir || HOME);
      const currentDir = normCurrent && existsSync(normCurrent) ? normCurrent : HOME;

      const bookmarks = Array.isArray(raw.bookmarks)
        ? raw.bookmarks.map((b) => this.#enrichBookmark(b)).filter(Boolean)
        : base.bookmarks;

      const recentDirs = Array.isArray(raw.recentDirs)
        ? raw.recentDirs
            .map((p) => normalizeFolderPath(p))
            .filter((p, idx, arr) => p && arr.indexOf(p) === idx)
            .slice(0, MAX_RECENT_DIRS)
        : [currentDir];

      const settings = {
        showHidden:
          typeof raw.settings?.showHidden === 'boolean'
            ? raw.settings.showHidden
            : true,
        sortBy: ['name', 'size', 'mtime', 'ext'].includes(raw.settings?.sortBy)
          ? raw.settings.sortBy
          : 'name',
        sortDir: raw.settings?.sortDir === 'desc' ? 'desc' : 'asc',
        inspectorOpen:
          typeof raw.settings?.inspectorOpen === 'boolean'
            ? raw.settings.inspectorOpen
            : true,
      };

      return {
        currentDir,
        bookmarks,
        recentDirs,
        settings,
      };
    } catch {
      return base;
    }
  }

  #save() {
    try {
      mkdirSync(dirname(this.#filePath), { recursive: true });
      const tmpPath = `${this.#filePath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(this.#state, null, 2), 'utf-8');
      renameSync(tmpPath, this.#filePath);
    } catch {
      // Ignore transient disk write errors
    }
  }

  getState() {
    const currentDir =
      this.#state.currentDir && existsSync(this.#state.currentDir)
        ? this.#state.currentDir
        : HOME;
    return {
      homeDir: HOME,
      currentDir,
      currentDisplayPath: formatFolderDisplayPath(currentDir),
      bookmarks: this.#state.bookmarks
        .map((b) => this.#enrichBookmark(b))
        .filter(Boolean),
      recentDirs: this.#state.recentDirs.map((p) => ({
        path: p,
        name: basename(p) || '/',
        displayPath: formatFolderDisplayPath(p),
        existsOnDisk: existsSync(p),
      })),
      settings: { ...this.#state.settings },
    };
  }

  setCurrentDir(dirPath) {
    const norm = normalizeFolderPath(dirPath || HOME);
    if (!norm || !existsSync(norm)) {
      throw new Error(`Directory does not exist: ${dirPath}`);
    }
    this.#state.currentDir = norm;
    this.#state.recentDirs = [
      norm,
      ...this.#state.recentDirs.filter((p) => p !== norm),
    ].slice(0, MAX_RECENT_DIRS);
    this.#save();
    return this.getState();
  }

  addBookmark(dirPath, label = '') {
    const norm = normalizeFolderPath(dirPath || '');
    if (!norm) {
      throw new Error('Bookmark path is required.');
    }
    const existingIdx = this.#state.bookmarks.findIndex((b) => b.path === norm);
    const name = basename(norm) || '/';
    const cleanLabel = String(label || '').trim();

    if (existingIdx >= 0) {
      if (cleanLabel) {
        this.#state.bookmarks[existingIdx].label = cleanLabel;
      }
    } else {
      this.#state.bookmarks.push({
        path: norm,
        name,
        label: cleanLabel || name,
        displayPath: formatFolderDisplayPath(norm),
        addedAt: new Date().toISOString(),
      });
    }
    this.#save();
    return this.getState();
  }

  removeBookmark(dirPath) {
    const norm = normalizeFolderPath(dirPath || '');
    if (!norm) return this.getState();
    this.#state.bookmarks = this.#state.bookmarks.filter((b) => b.path !== norm);
    this.#save();
    return this.getState();
  }

  updateSettings(patch = {}) {
    if (typeof patch.showHidden === 'boolean') {
      this.#state.settings.showHidden = patch.showHidden;
    }
    if (['name', 'size', 'mtime', 'ext'].includes(patch.sortBy)) {
      this.#state.settings.sortBy = patch.sortBy;
    }
    if (['asc', 'desc'].includes(patch.sortDir)) {
      this.#state.settings.sortDir = patch.sortDir;
    }
    if (typeof patch.inspectorOpen === 'boolean') {
      this.#state.settings.inspectorOpen = patch.inspectorOpen;
    }
    this.#save();
    return this.getState();
  }
}
