/**
 * @fileoverview Filesystem listing, search, and mutation helpers for `file-explorer`.
 * All mutations validate that target paths reside strictly within the active root folder.
 */

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { normalizeFolderPath } from './session_folders.mjs';

export const MAX_LIST_ENTRIES = 500;

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

const IGNORED_SEARCH_DIRS = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'dist',
  'build',
  'target',
  '.next',
  'bazel-out',
  'bazel-bin',
  'bazel-testlogs',
]);

function pathExistsOrBrokenSymlink(targetPath) {
  try {
    lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verifies that the nearest existing ancestor directory of `candidate` resolves
 * via `realpathSync` inside `realpathSync(normRoot)`, preventing symlink escapes.
 */
function assertRealpathInsideRoot(normRoot, candidate) {
  if (!existsSync(normRoot)) return;
  const realRoot = realpathSync(normRoot);
  const realRootPrefix = realRoot === '/' ? '/' : `${realRoot}/`;

  let probe = dirname(candidate);
  while (probe && probe.length >= normRoot.length && !existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }

  if (existsSync(probe)) {
    const realProbe = realpathSync(probe);
    if (realProbe !== realRoot && !realProbe.startsWith(realRootPrefix)) {
      throw new Error(
        `Symlink target "${realProbe}" escapes root folder "${realRoot}".`
      );
    }
  }
}

/**
 * Ensures `targetPath` resolves inside `rootPath` (or equals `rootPath` when `allowRoot` is true).
 */
export function resolveScopedPath(
  rootPath,
  targetPath,
  { allowRoot = true, enforceRealpath = true } = {}
) {
  const normRoot = normalizeFolderPath(rootPath);
  if (!normRoot) {
    throw new Error('Root folder path is required.');
  }

  let candidate = '';
  if (!targetPath) {
    candidate = normRoot;
  } else {
    const raw = String(targetPath).trim();
    if (raw.startsWith('/') || raw.startsWith('~') || raw.startsWith('file://')) {
      candidate = normalizeFolderPath(raw);
    } else {
      candidate = resolve(normRoot, raw);
    }
  }

  if (candidate === normRoot) {
    if (!allowRoot) {
      throw new Error('Operation is not permitted on the root folder itself.');
    }
    return { rootPath: normRoot, targetPath: candidate, relPath: '' };
  }

  const rootPrefix = normRoot === '/' ? '/' : `${normRoot}/`;
  if (!candidate.startsWith(rootPrefix)) {
    throw new Error(
      `Path "${candidate}" is outside the selected root folder "${normRoot}".`
    );
  }

  if (enforceRealpath) {
    assertRealpathInsideRoot(normRoot, candidate);
  }

  return {
    rootPath: normRoot,
    targetPath: candidate,
    relPath: relative(normRoot, candidate),
  };
}

/**
 * Lists immediate children of `dirPath` inside `rootPath`.
 */
export async function listDirectoryInRoot(
  rootPath,
  dirPath = '',
  { showHidden = false, limit = MAX_LIST_ENTRIES } = {}
) {
  const scoped = resolveScopedPath(rootPath, dirPath || rootPath, {
    allowRoot: true,
    enforceRealpath: false,
  });
  const targetDir = scoped.targetPath;

  if (!existsSync(targetDir)) {
    return {
      rootPath: scoped.rootPath,
      path: targetDir,
      relPath: scoped.relPath,
      name: basename(targetDir) || '/',
      uri: `file://${targetDir}`,
      existsOnDisk: false,
      entries: [],
      total: 0,
      truncated: false,
    };
  }

  const dirents = await readdir(targetDir, { withFileTypes: true });
  const filtered = dirents.filter((d) => showHidden || !d.name.startsWith('.'));

  const enriched = await Promise.all(
    filtered.map(async (d) => {
      const fullPath = join(targetDir, d.name);
      const relPath = relative(scoped.rootPath, fullPath);
      const isSymlink = d.isSymbolicLink();
      let isDirectory = d.isDirectory();
      let size = 0;
      let mtimeMs = 0;

      try {
        const st = await stat(fullPath);
        isDirectory = st.isDirectory();
        size = isDirectory ? 0 : st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        try {
          const lst = await lstat(fullPath);
          mtimeMs = lst.mtimeMs;
        } catch {
          // Ignore disappeared entry
        }
      }

      const ext = isDirectory ? '' : extname(d.name).slice(1).toLowerCase();
      return {
        name: d.name,
        path: fullPath,
        relPath,
        uri: `file://${fullPath}`,
        kind: isDirectory ? 'directory' : isSymlink ? 'symlink' : 'file',
        isDirectory,
        isSymlink,
        size,
        mtimeMs,
        ext,
      };
    })
  );

  enriched.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return collator.compare(a.name, b.name);
  });

  const total = enriched.length;
  const maxItems = Math.max(1, Number(limit) || MAX_LIST_ENTRIES);
  const entries = enriched.slice(0, maxItems);

  return {
    rootPath: scoped.rootPath,
    path: targetDir,
    relPath: scoped.relPath,
    name: basename(targetDir) || '/',
    uri: `file://${targetDir}`,
    existsOnDisk: true,
    entries,
    total,
    truncated: total > entries.length,
  };
}

/**
 * Breadth-first filename/path search inside `rootPath`.
 */
export async function searchFilesInRoot(
  rootPath,
  query,
  { showHidden = false, maxResults = 150, maxDirs = 400 } = {}
) {
  const normRoot = normalizeFolderPath(rootPath);
  const q = String(query || '').trim().toLowerCase();
  if (!normRoot || !existsSync(normRoot) || !q) {
    return { rootPath: normRoot, query: q, results: [], truncated: false };
  }

  const results = [];
  const queue = [normRoot];
  let scannedDirs = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (results.length >= maxResults || scannedDirs >= maxDirs) {
      truncated = true;
      break;
    }

    const currentDir = queue.shift();
    scannedDirs++;

    let dirents;
    try {
      dirents = await readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    dirents.sort((a, b) => collator.compare(a.name, b.name));

    for (const d of dirents) {
      if (!showHidden && d.name.startsWith('.')) continue;

      const fullPath = join(currentDir, d.name);
      const relPath = relative(normRoot, fullPath);
      const isSymlink = d.isSymbolicLink();
      let isDirectory = d.isDirectory();
      let size = 0;

      if (isSymlink) {
        try {
          const st = await stat(fullPath);
          isDirectory = st.isDirectory();
          size = isDirectory ? 0 : st.size;
        } catch {
          isDirectory = false;
        }
      } else if (!isDirectory) {
        try {
          const st = await stat(fullPath);
          size = st.size;
        } catch {
          size = 0;
        }
      }

      if (
        d.name.toLowerCase().includes(q) ||
        relPath.toLowerCase().includes(q)
      ) {
        results.push({
          name: d.name,
          path: fullPath,
          relPath,
          uri: `file://${fullPath}`,
          kind: isDirectory ? 'directory' : isSymlink ? 'symlink' : 'file',
          isDirectory,
          isSymlink,
          size,
          ext: isDirectory ? '' : extname(d.name).slice(1).toLowerCase(),
        });
        if (results.length >= maxResults) {
          truncated = true;
          break;
        }
      }

      if (isDirectory && !isSymlink && !IGNORED_SEARCH_DIRS.has(d.name)) {
        queue.push(fullPath);
      }
    }
  }

  results.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return collator.compare(a.relPath, b.relPath);
  });

  return {
    rootPath: normRoot,
    query: q,
    results,
    scannedDirs,
    truncated,
  };
}

function validateRelativeChildName(name, label = 'Name') {
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    throw new Error(`${label} cannot be empty.`);
  }
  if (trimmed === '.' || trimmed === '..' || trimmed.includes('..')) {
    throw new Error(`Invalid ${label.toLowerCase()}: "${trimmed}".`);
  }
  return trimmed;
}

/**
 * Creates a new file inside `rootPath`.
 */
export async function createFileInRoot(rootPath, parentDir, name, content = '') {
  const cleanName = validateRelativeChildName(name, 'File name');
  const parentScoped = resolveScopedPath(rootPath, parentDir || rootPath, {
    allowRoot: true,
    enforceRealpath: true,
  });
  const targetScoped = resolveScopedPath(
    rootPath,
    join(parentScoped.targetPath, cleanName),
    { allowRoot: false, enforceRealpath: true }
  );

  if (pathExistsOrBrokenSymlink(targetScoped.targetPath)) {
    throw new Error(`Already exists: ${targetScoped.relPath}`);
  }

  await mkdir(dirname(targetScoped.targetPath), { recursive: true });
  await writeFile(targetScoped.targetPath, String(content ?? ''), {
    encoding: 'utf-8',
    flag: 'wx',
  });

  return {
    ok: true,
    path: targetScoped.targetPath,
    relPath: targetScoped.relPath,
    uri: `file://${targetScoped.targetPath}`,
    name: basename(targetScoped.targetPath),
  };
}

/**
 * Creates a new directory inside `rootPath`.
 */
export async function createDirectoryInRoot(rootPath, parentDir, name) {
  const cleanName = validateRelativeChildName(name, 'Folder name');
  const parentScoped = resolveScopedPath(rootPath, parentDir || rootPath, {
    allowRoot: true,
    enforceRealpath: true,
  });
  const targetScoped = resolveScopedPath(
    rootPath,
    join(parentScoped.targetPath, cleanName),
    { allowRoot: false, enforceRealpath: true }
  );

  if (pathExistsOrBrokenSymlink(targetScoped.targetPath)) {
    throw new Error(`Already exists: ${targetScoped.relPath}`);
  }

  await mkdir(targetScoped.targetPath, { recursive: true });

  return {
    ok: true,
    path: targetScoped.targetPath,
    relPath: targetScoped.relPath,
    uri: `file://${targetScoped.targetPath}`,
    name: basename(targetScoped.targetPath),
  };
}

/**
 * Renames a file or folder inside `rootPath`.
 */
export async function renamePathInRoot(rootPath, oldPath, newName) {
  const cleanNewName = validateRelativeChildName(newName, 'New name');
  if (cleanNewName.includes('/')) {
    throw new Error('New name must be a single file or folder name without slashes.');
  }

  const oldScoped = resolveScopedPath(rootPath, oldPath, {
    allowRoot: false,
    enforceRealpath: true,
  });
  if (!pathExistsOrBrokenSymlink(oldScoped.targetPath)) {
    throw new Error(`Path does not exist: ${oldScoped.relPath}`);
  }

  const newTarget = join(dirname(oldScoped.targetPath), cleanNewName);
  const newScoped = resolveScopedPath(rootPath, newTarget, {
    allowRoot: false,
    enforceRealpath: true,
  });

  if (pathExistsOrBrokenSymlink(newScoped.targetPath)) {
    throw new Error(`Destination already exists: ${newScoped.relPath}`);
  }

  await rename(oldScoped.targetPath, newScoped.targetPath);

  return {
    ok: true,
    oldPath: oldScoped.targetPath,
    path: newScoped.targetPath,
    relPath: newScoped.relPath,
    uri: `file://${newScoped.targetPath}`,
    name: cleanNewName,
  };
}

/**
 * Deletes a file or folder inside `rootPath` (never the root folder itself).
 */
export async function deletePathInRoot(rootPath, targetPath) {
  const scoped = resolveScopedPath(rootPath, targetPath, {
    allowRoot: false,
    enforceRealpath: true,
  });
  if (!pathExistsOrBrokenSymlink(scoped.targetPath)) {
    throw new Error(`Path does not exist: ${scoped.relPath}`);
  }

  await rm(scoped.targetPath, { recursive: true, force: false });

  return {
    ok: true,
    deletedPath: scoped.targetPath,
    relPath: scoped.relPath,
  };
}
