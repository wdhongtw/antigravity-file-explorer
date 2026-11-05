/**
 * @fileoverview Filesystem listing, search, archive (zip/unzip/tar), clipboard
 * (copy/move/duplicate), permissions, and inspection helpers for `file-explorer`.
 * All mutations validate that target paths reside strictly within the active root folder.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { normalizeFolderPath } from './session_folders.mjs';

const execFileAsync = promisify(execFile);
const HOME = homedir();

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

const ARCHIVE_SUFFIXES = [
  '.tar.gz',
  '.tgz',
  '.tar.bz2',
  '.tbz2',
  '.tar.xz',
  '.txz',
  '.tar',
  '.zip',
];

export function isArchiveFilename(name) {
  const lower = String(name || '').toLowerCase();
  return ARCHIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export function stripArchiveSuffix(name) {
  const raw = String(name || '');
  const lower = raw.toLowerCase();
  for (const suffix of ARCHIVE_SUFFIXES) {
    if (lower.endsWith(suffix) && raw.length > suffix.length) {
      return raw.slice(0, raw.length - suffix.length);
    }
  }
  return basename(raw, extname(raw)) || 'extracted';
}

export function formatModePermissions(mode, isDirectory = false, isSymlink = false) {
  const prefix = isSymlink ? 'l' : isDirectory ? 'd' : '-';
  const chars = ['r', 'w', 'x'];
  let out = prefix;
  for (let shift = 6; shift >= 0; shift -= 3) {
    const triad = (mode >> shift) & 0b111;
    out += triad & 4 ? chars[0] : '-';
    out += triad & 2 ? chars[1] : '-';
    out += triad & 1 ? chars[2] : '-';
  }
  return out;
}

export function formatModeOctal(mode) {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

export function buildBreadcrumbs(dirPath) {
  const norm = normalizeFolderPath(dirPath || '/');
  if (!norm || norm === '/') {
    return [{ name: '/', path: '/' }];
  }
  const parts = norm.split('/').filter(Boolean);
  const crumbs = [{ name: '/', path: '/' }];
  let acc = '';
  for (const part of parts) {
    acc += `/${part}`;
    crumbs.push({ name: part, path: acc });
  }
  return crumbs;
}

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
  {
    showHidden = false,
    limit = MAX_LIST_ENTRIES,
    sortBy = 'name',
    sortDir = 'asc',
  } = {}
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
      parentPath: targetDir === '/' ? null : dirname(targetDir),
      relPath: scoped.relPath,
      name: basename(targetDir) || '/',
      uri: `file://${targetDir}`,
      breadcrumbs: buildBreadcrumbs(targetDir),
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
      let mode = 0;
      let symlinkTarget = '';

      if (isSymlink) {
        try {
          symlinkTarget = await readlink(fullPath);
        } catch {
          symlinkTarget = '';
        }
      }

      try {
        const st = await stat(fullPath);
        isDirectory = st.isDirectory();
        size = isDirectory ? 0 : st.size;
        mtimeMs = st.mtimeMs;
        mode = st.mode;
      } catch {
        try {
          const lst = await lstat(fullPath);
          mtimeMs = lst.mtimeMs;
          mode = lst.mode;
        } catch {
          // Ignore disappeared entry
        }
      }

      const ext = isDirectory ? '' : extname(d.name).slice(1).toLowerCase();
      const isArchive = !isDirectory && isArchiveFilename(d.name);
      const isExecutable = !isDirectory && Boolean(mode & 0o111);

      return {
        name: d.name,
        path: fullPath,
        relPath,
        uri: `file://${fullPath}`,
        kind: isDirectory ? 'directory' : isSymlink ? 'symlink' : 'file',
        isDirectory,
        isSymlink,
        symlinkTarget,
        isArchive,
        isExecutable,
        modeOctal: mode ? formatModeOctal(mode) : '',
        permissions: mode
          ? formatModePermissions(mode, isDirectory, isSymlink)
          : '',
        size,
        mtimeMs,
        ext,
      };
    })
  );

  const dirMul = sortDir === 'desc' ? -1 : 1;
  enriched.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    if (sortBy === 'size' && !a.isDirectory && !b.isDirectory) {
      if (a.size !== b.size) return (a.size - b.size) * dirMul;
    } else if (sortBy === 'mtime') {
      if (a.mtimeMs !== b.mtimeMs) return (a.mtimeMs - b.mtimeMs) * dirMul;
    } else if (sortBy === 'ext' && !a.isDirectory && !b.isDirectory) {
      const cmpExt = collator.compare(a.ext || '', b.ext || '');
      if (cmpExt !== 0) return cmpExt * dirMul;
    }
    return collator.compare(a.name, b.name) * dirMul;
  });

  const total = enriched.length;
  const maxItems = Math.max(1, Number(limit) || MAX_LIST_ENTRIES);
  const entries = enriched.slice(0, maxItems);

  return {
    rootPath: scoped.rootPath,
    path: targetDir,
    parentPath: targetDir === '/' ? null : dirname(targetDir),
    relPath: scoped.relPath,
    name: basename(targetDir) || '/',
    uri: `file://${targetDir}`,
    breadcrumbs: buildBreadcrumbs(targetDir),
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
      let mtimeMs = 0;

      if (isSymlink) {
        try {
          const st = await stat(fullPath);
          isDirectory = st.isDirectory();
          size = isDirectory ? 0 : st.size;
          mtimeMs = st.mtimeMs;
        } catch {
          isDirectory = false;
        }
      } else {
        try {
          const st = await stat(fullPath);
          size = isDirectory ? 0 : st.size;
          mtimeMs = st.mtimeMs;
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
          isArchive: !isDirectory && isArchiveFilename(d.name),
          size,
          mtimeMs,
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

function assertNotProtectedSystemDir(targetPath) {
  const norm = normalizeFolderPath(targetPath);
  if (norm === '/' || norm === HOME) {
    throw new Error(`Protected directory cannot be modified or deleted: "${norm}".`);
  }
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
  assertNotProtectedSystemDir(oldScoped.targetPath);
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
  assertNotProtectedSystemDir(scoped.targetPath);
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

function findAvailableCopyPath(parentDir, origName) {
  const ext = isArchiveFilename(origName)
    ? ARCHIVE_SUFFIXES.find((s) => origName.toLowerCase().endsWith(s)) || extname(origName)
    : extname(origName);
  const stem = ext ? origName.slice(0, origName.length - ext.length) : origName;

  for (let i = 1; i <= 100; i++) {
    const suffix = i === 1 ? ' copy' : ` copy ${i}`;
    const candidateName = `${stem}${suffix}${ext}`;
    const candidatePath = join(parentDir, candidateName);
    if (!pathExistsOrBrokenSymlink(candidatePath)) {
      return { name: candidateName, path: candidatePath };
    }
  }
  const fallbackName = `${stem} copy ${Date.now()}${ext}`;
  return { name: fallbackName, path: join(parentDir, fallbackName) };
}

/**
 * Duplicates a file or directory in-place inside `rootPath`.
 */
export async function duplicatePathInRoot(rootPath, sourcePath, customNewName = '') {
  const srcScoped = resolveScopedPath(rootPath, sourcePath, {
    allowRoot: false,
    enforceRealpath: true,
  });
  if (!pathExistsOrBrokenSymlink(srcScoped.targetPath)) {
    throw new Error(`Source does not exist: ${srcScoped.relPath}`);
  }

  const parentDir = dirname(srcScoped.targetPath);
  let destPath = '';
  let destName = '';

  if (customNewName && String(customNewName).trim()) {
    destName = validateRelativeChildName(customNewName, 'Duplicate name');
    if (destName.includes('/')) {
      throw new Error('Duplicate name must not contain slashes.');
    }
    destPath = join(parentDir, destName);
    if (pathExistsOrBrokenSymlink(destPath)) {
      throw new Error(`Destination already exists: ${destName}`);
    }
  } else {
    const avail = findAvailableCopyPath(parentDir, basename(srcScoped.targetPath));
    destName = avail.name;
    destPath = avail.path;
  }

  const destScoped = resolveScopedPath(rootPath, destPath, {
    allowRoot: false,
    enforceRealpath: true,
  });

  await cp(srcScoped.targetPath, destScoped.targetPath, {
    recursive: true,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
  });

  return {
    ok: true,
    sourcePath: srcScoped.targetPath,
    path: destScoped.targetPath,
    relPath: destScoped.relPath,
    name: destName,
  };
}

/**
 * Copies or moves one or more paths into `destDir` inside `rootPath`.
 */
export async function transferItemsInRoot(
  rootPath,
  sourcePaths,
  destDir,
  { mode = 'copy', overwrite = false } = {}
) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
    throw new Error('No source items provided.');
  }
  const destDirScoped = resolveScopedPath(rootPath, destDir, {
    allowRoot: true,
    enforceRealpath: true,
  });
  if (!existsSync(destDirScoped.targetPath)) {
    throw new Error(`Destination folder does not exist: ${destDir}`);
  }

  const transferred = [];
  for (const rawSrc of sourcePaths) {
    const srcScoped = resolveScopedPath(rootPath, rawSrc, {
      allowRoot: false,
      enforceRealpath: true,
    });
    if (!pathExistsOrBrokenSymlink(srcScoped.targetPath)) {
      throw new Error(`Source does not exist: ${rawSrc}`);
    }
    if (mode === 'move') {
      assertNotProtectedSystemDir(srcScoped.targetPath);
    }

    const base = basename(srcScoped.targetPath);
    let targetPath = join(destDirScoped.targetPath, base);

    if (srcScoped.targetPath === targetPath) {
      if (mode === 'copy') {
        const avail = findAvailableCopyPath(destDirScoped.targetPath, base);
        targetPath = avail.path;
      } else {
        continue;
      }
    } else if (pathExistsOrBrokenSymlink(targetPath) && !overwrite) {
      if (mode === 'copy') {
        const avail = findAvailableCopyPath(destDirScoped.targetPath, base);
        targetPath = avail.path;
      } else {
        throw new Error(`Destination already exists: ${base}`);
      }
    }

    if (
      targetPath.startsWith(`${srcScoped.targetPath}/`)
    ) {
      throw new Error(`Cannot ${mode} folder "${base}" into itself.`);
    }

    const targetScoped = resolveScopedPath(rootPath, targetPath, {
      allowRoot: false,
      enforceRealpath: true,
    });

    if (mode === 'move') {
      try {
        await rename(srcScoped.targetPath, targetScoped.targetPath);
      } catch (err) {
        if (err && err.code === 'EXDEV') {
          await cp(srcScoped.targetPath, targetScoped.targetPath, {
            recursive: true,
            force: overwrite,
            verbatimSymlinks: true,
          });
          await rm(srcScoped.targetPath, { recursive: true, force: true });
        } else {
          throw err;
        }
      }
    } else {
      await cp(srcScoped.targetPath, targetScoped.targetPath, {
        recursive: true,
        force: overwrite,
        errorOnExist: !overwrite,
        verbatimSymlinks: true,
      });
    }

    transferred.push({
      sourcePath: srcScoped.targetPath,
      path: targetScoped.targetPath,
      name: basename(targetScoped.targetPath),
    });
  }

  return {
    ok: true,
    mode,
    destDir: destDirScoped.targetPath,
    count: transferred.length,
    items: transferred,
  };
}

/**
 * Changes file permissions (`chmod`) or toggles executable bit (`toggle-exec`).
 */
export async function chmodPathInRoot(rootPath, targetPath, modeInput) {
  const scoped = resolveScopedPath(rootPath, targetPath, {
    allowRoot: false,
    enforceRealpath: true,
  });
  const st = await stat(scoped.targetPath);
  let newMode;
  if (modeInput === 'toggle-exec') {
    const hasExec = Boolean(st.mode & 0o111);
    newMode = hasExec ? st.mode & ~0o111 : st.mode | 0o755;
  } else {
    const clean = String(modeInput || '').trim().replace(/^0o?/i, '');
    if (!/^[0-7]{3,4}$/.test(clean)) {
      throw new Error(`Invalid octal permission mode: "${modeInput}" (expected e.g. 755 or 644).`);
    }
    newMode = Number.parseInt(clean, 8);
  }

  await chmod(scoped.targetPath, newMode);
  const updated = await stat(scoped.targetPath);
  return {
    ok: true,
    path: scoped.targetPath,
    modeOctal: formatModeOctal(updated.mode),
    permissions: formatModePermissions(updated.mode, updated.isDirectory(), false),
    isExecutable: !updated.isDirectory() && Boolean(updated.mode & 0o111),
  };
}

/**
 * Compresses one or more files/folders in the same parent directory into a `.zip` or `.tar.gz` archive.
 */
export async function compressItemsInRoot(
  rootPath,
  sourcePaths,
  destDir,
  archiveName = '',
  format = 'zip'
) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
    throw new Error('Select at least one file or folder to compress.');
  }

  const destDirScoped = resolveScopedPath(rootPath, destDir, {
    allowRoot: true,
    enforceRealpath: true,
  });

  const resolvedSources = sourcePaths.map((p) => {
    const s = resolveScopedPath(rootPath, p, {
      allowRoot: false,
      enforceRealpath: true,
    });
    if (!pathExistsOrBrokenSymlink(s.targetPath)) {
      throw new Error(`Path does not exist: ${p}`);
    }
    return s.targetPath;
  });

  const isTarGz = format === 'tar.gz' || format === 'tgz';
  const defaultExt = isTarGz ? '.tar.gz' : '.zip';
  const baseDefault =
    resolvedSources.length === 1
      ? basename(resolvedSources[0])
      : basename(destDirScoped.targetPath) || 'archive';

  let cleanArchiveName = validateRelativeChildName(
    archiveName || `${baseDefault}${defaultExt}`,
    'Archive name'
  );
  if (cleanArchiveName.includes('/')) {
    throw new Error('Archive name must not contain slashes.');
  }
  if (!isArchiveFilename(cleanArchiveName)) {
    cleanArchiveName += defaultExt;
  }

  const archiveTarget = resolveScopedPath(
    rootPath,
    join(destDirScoped.targetPath, cleanArchiveName),
    { allowRoot: false, enforceRealpath: true }
  );

  if (pathExistsOrBrokenSymlink(archiveTarget.targetPath)) {
    throw new Error(`Archive already exists: ${cleanArchiveName}`);
  }

  // Use python3 zipfile / tarfile via execFile so compression works reliably across environments without shell interpolation
  const pyScript = `
import os, sys, zipfile, tarfile

archive_path = sys.argv[1]
fmt = sys.argv[2]
sources = sys.argv[3:]

if fmt in ('tar.gz', 'tgz'):
    with tarfile.open(archive_path, 'w:gz') as tf:
        for src in sources:
            tf.add(src, arcname=os.path.basename(src))
else:
    with zipfile.ZipFile(archive_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        for src in sources:
            base_parent = os.path.dirname(src)
            if os.path.isdir(src) and not os.path.islink(src):
                has_children = False
                for root, dirs, files in os.walk(src):
                    rel_root = os.path.relpath(root, base_parent)
                    if not dirs and not files:
                        zf.writestr(rel_root.rstrip('/') + '/', '')
                    for d in dirs:
                        full_d = os.path.join(root, d)
                        if os.path.islink(full_d):
                            zf.write(full_d, os.path.join(rel_root, d))
                    for f in files:
                        full_f = os.path.join(root, f)
                        zf.write(full_f, os.path.join(rel_root, f))
                        has_children = True
                if not has_children:
                    zf.writestr(os.path.basename(src).rstrip('/') + '/', '')
            else:
                zf.write(src, os.path.basename(src))
`;

  await execFileAsync(
    'python3',
    ['-c', pyScript, archiveTarget.targetPath, isTarGz ? 'tar.gz' : 'zip', ...resolvedSources],
    { maxBuffer: 16 * 1024 * 1024 }
  );

  const st = await stat(archiveTarget.targetPath);
  return {
    ok: true,
    path: archiveTarget.targetPath,
    name: cleanArchiveName,
    size: st.size,
  };
}

/**
 * Extracts a `.zip` or `.tar*` archive inside `rootPath` with Zip-Slip protection.
 */
export async function extractArchiveInRoot(
  rootPath,
  archivePath,
  destDir = '',
  { createSubfolder = true } = {}
) {
  const archiveScoped = resolveScopedPath(rootPath, archivePath, {
    allowRoot: false,
    enforceRealpath: true,
  });
  if (!existsSync(archiveScoped.targetPath)) {
    throw new Error(`Archive does not exist: ${archivePath}`);
  }
  if (!isArchiveFilename(archiveScoped.targetPath)) {
    throw new Error(`Unsupported archive format: ${basename(archiveScoped.targetPath)}`);
  }

  const baseDestDir = destDir || dirname(archiveScoped.targetPath);
  const destDirScoped = resolveScopedPath(rootPath, baseDestDir, {
    allowRoot: true,
    enforceRealpath: true,
  });

  let finalExtractDir = destDirScoped.targetPath;
  if (createSubfolder) {
    const stem = stripArchiveSuffix(basename(archiveScoped.targetPath));
    let candidateDir = join(destDirScoped.targetPath, stem);
    let suffixIdx = 2;
    while (pathExistsOrBrokenSymlink(candidateDir)) {
      candidateDir = join(destDirScoped.targetPath, `${stem}-${suffixIdx}`);
      suffixIdx++;
    }
    const subScoped = resolveScopedPath(rootPath, candidateDir, {
      allowRoot: false,
      enforceRealpath: true,
    });
    finalExtractDir = subScoped.targetPath;
    await mkdir(finalExtractDir, { recursive: true });
  }

  const pyExtractScript = `
import os, sys, zipfile, tarfile

archive_path = sys.argv[1]
dest_dir = os.path.realpath(sys.argv[2])
dest_prefix = dest_dir if dest_dir == '/' else dest_dir + os.sep

def assert_safe(member_name):
    target = os.path.realpath(os.path.join(dest_dir, member_name))
    if target != dest_dir and not target.startswith(dest_prefix):
        raise ValueError(f"Unsafe archive entry blocked (Zip-Slip): {member_name}")

lower = archive_path.lower()
count = 0
if lower.endswith('.zip'):
    with zipfile.ZipFile(archive_path, 'r') as zf:
        for info in zf.infolist():
            assert_safe(info.filename)
        for info in zf.infolist():
            zf.extract(info, dest_dir)
            count += 1
else:
    with tarfile.open(archive_path, 'r:*') as tf:
        members = tf.getmembers()
        for m in members:
            assert_safe(m.name)
            if m.issym() or m.islnk():
                link_target = os.path.join(os.path.dirname(os.path.join(dest_dir, m.name)), m.linkname)
                assert_safe(os.path.relpath(link_target, dest_dir))
        tf.extractall(dest_dir, members=members)
        count = len(members)
print(count)
`;

  const { stdout } = await execFileAsync(
    'python3',
    ['-c', pyExtractScript, archiveScoped.targetPath, finalExtractDir],
    { maxBuffer: 16 * 1024 * 1024 }
  );

  return {
    ok: true,
    archivePath: archiveScoped.targetPath,
    extractedTo: finalExtractDir,
    extractedName: basename(finalExtractDir),
    entryCount: Number.parseInt(String(stdout).trim(), 10) || 0,
  };
}

/**
 * Lists members inside an archive file (`.zip` or `.tar*`) without extracting.
 */
export async function listArchiveEntries(archivePath, maxEntries = 100) {
  const pyListScript = `
import json, sys, zipfile, tarfile

archive_path = sys.argv[1]
limit = int(sys.argv[2])
lower = archive_path.lower()
items = []
total = 0

if lower.endswith('.zip'):
    with zipfile.ZipFile(archive_path, 'r') as zf:
        infos = zf.infolist()
        total = len(infos)
        for i in infos[:limit]:
            items.append({
                "name": i.filename,
                "size": i.file_size,
                "compressedSize": i.compress_size,
                "isDirectory": i.is_dir(),
            })
else:
    with tarfile.open(archive_path, 'r:*') as tf:
        for m in tf:
            total += 1
            if len(items) < limit:
                items.append({
                    "name": m.name,
                    "size": m.size,
                    "compressedSize": m.size,
                    "isDirectory": m.isdir(),
                })

print(json.dumps({"total": total, "entries": items, "truncated": total > len(items)}))
`;
  const { stdout } = await execFileAsync(
    'python3',
    ['-c', pyListScript, archivePath, String(maxEntries)],
    { maxBuffer: 8 * 1024 * 1024 }
  );
  return JSON.parse(stdout);
}

/**
 * Computes recursive folder size and item count (bounded so huge trees return quickly).
 */
export async function computeFolderStats(dirPath, { maxDirs = 1500 } = {}) {
  let totalBytes = 0;
  let fileCount = 0;
  let dirCount = 0;
  let truncated = false;
  const queue = [dirPath];
  let visitedDirs = 0;

  while (queue.length > 0) {
    if (visitedDirs >= maxDirs) {
      truncated = true;
      break;
    }
    const curr = queue.shift();
    visitedDirs++;
    let dirents;
    try {
      dirents = await readdir(curr, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      const full = join(curr, d.name);
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        dirCount++;
        queue.push(full);
      } else {
        fileCount++;
        try {
          const st = await stat(full);
          totalBytes += st.size;
        } catch {
          // ignore
        }
      }
    }
  }
  return { totalBytes, fileCount, dirCount, truncated };
}

/**
 * Inspects a file or directory inside `rootPath`, returning rich metadata,
 * optional SHA-256 hash, archive member preview, or text snippet preview.
 */
export async function inspectPathInRoot(
  rootPath,
  targetPath,
  { includeHash = false, includeFolderSize = false } = {}
) {
  const scoped = resolveScopedPath(rootPath, targetPath, {
    allowRoot: true,
    enforceRealpath: false,
  });
  const fullPath = scoped.targetPath;
  if (!pathExistsOrBrokenSymlink(fullPath)) {
    throw new Error(`Path does not exist: ${fullPath}`);
  }

  const lst = await lstat(fullPath);
  const isSymlink = lst.isSymbolicLink();
  let st = lst;
  let brokenSymlink = false;
  let symlinkTarget = '';
  let realPath = fullPath;

  if (isSymlink) {
    try {
      symlinkTarget = await readlink(fullPath);
    } catch {
      symlinkTarget = '';
    }
    try {
      st = await stat(fullPath);
      realPath = realpathSync(fullPath);
    } catch {
      brokenSymlink = true;
    }
  } else {
    try {
      realPath = realpathSync(fullPath);
    } catch {
      realPath = fullPath;
    }
  }

  const isDirectory = !brokenSymlink && st.isDirectory();
  const isArchive = !isDirectory && isArchiveFilename(fullPath);
  const result = {
    name: basename(fullPath) || '/',
    path: fullPath,
    realPath,
    parentPath: fullPath === '/' ? null : dirname(fullPath),
    isDirectory,
    isSymlink,
    brokenSymlink,
    symlinkTarget,
    isArchive,
    isExecutable: !isDirectory && Boolean(st.mode & 0o111),
    size: isDirectory ? 0 : st.size,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    modeOctal: formatModeOctal(st.mode),
    permissions: formatModePermissions(st.mode, isDirectory, isSymlink),
    ext: isDirectory ? '' : extname(fullPath).slice(1).toLowerCase(),
  };

  if (isDirectory && includeFolderSize) {
    result.folderStats = await computeFolderStats(fullPath);
  } else if (isDirectory) {
    try {
      const children = await readdir(fullPath);
      result.childCount = children.length;
    } catch {
      result.childCount = 0;
    }
  }

  if (isArchive && !brokenSymlink) {
    try {
      result.archivePreview = await listArchiveEntries(fullPath, 80);
    } catch (err) {
      result.archiveError = err?.message || String(err);
    }
  } else if (!isDirectory && !brokenSymlink && st.size > 0) {
    // Check if file is readable text (up to first 8KB)
    try {
      const fh = await open(fullPath, 'r');
      try {
        const sampleLen = Math.min(st.size, 8192);
        const buf = Buffer.alloc(sampleLen);
        const { bytesRead } = await fh.read(buf, 0, sampleLen, 0);
        const slice = buf.subarray(0, bytesRead);
        const hasNullByte = slice.includes(0);
        result.isBinary = hasNullByte;
        if (!hasNullByte) {
          result.textPreview = slice.toString('utf-8');
          result.textPreviewTruncated = st.size > bytesRead;
        }
      } finally {
        await fh.close();
      }
    } catch {
      // Ignore unreadable file preview
    }

    if (includeHash && st.size <= 50 * 1024 * 1024) {
      try {
        const content = await readFile(fullPath);
        result.sha256 = createHash('sha256').update(content).digest('hex');
      } catch {
        // Ignore hash error
      }
    }
  }

  return result;
}
