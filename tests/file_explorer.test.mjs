import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDirectoryInRoot,
  createFileInRoot,
  deletePathInRoot,
  listDirectoryInRoot,
  renamePathInRoot,
  resolveScopedPath,
  searchFilesInRoot,
} from '../lib/file_service.mjs';
import {
  extractFolderStepAction,
  getSessionFolderState,
  normalizeFolderPath,
} from '../lib/session_folders.mjs';

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('normalizeFolderPath normalizes file://, tilde, and trailing slashes', () => {
  assert.equal(
    normalizeFolderPath('file:///tmp/example/dir///'),
    '/tmp/example/dir'
  );
  assert.equal(normalizeFolderPath('/'), '/');
});

test('getSessionFolderState aggregates workspace, project, MCP, and brain folders with fork inheritance', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'fe-test-'));
  try {
    const wsDir = join(tempRoot, 'ws-repo');
    const projDir = join(tempRoot, 'proj-extra');
    const mcpDir1 = join(tempRoot, 'mcp-one');
    const mcpDir2 = join(tempRoot, 'mcp-two');
    const projectsDir = join(tempRoot, 'projects');
    const appDataDir = join(tempRoot, 'appdata');
    const convId = 'conv-12345678';
    const brainDir = join(appDataDir, 'brain', convId);

    for (const d of [wsDir, projDir, mcpDir1, mcpDir2, projectsDir, brainDir]) {
      mkdirSync(d, { recursive: true });
    }

    writeFileSync(
      join(projectsDir, 'proj-abc.json'),
      JSON.stringify({
        id: 'proj-abc',
        name: 'Demo Project',
        projectResources: {
          resources: [
            { folderUri: `file://${wsDir}` },
            { gitFolder: { folderUri: `file://${projDir}` } },
          ],
        },
      }),
      'utf-8'
    );

    const trajectoryData = {
      ok: true,
      metadata: {
        projectId: 'proj-abc',
        workspaceUris: [`file://${wsDir}`],
      },
      parentReferences: [
        {
          conversationId: 'parent-conv-999',
          stepIndex: 0,
        },
      ],
      steps: [
        {
          type: 'CORTEX_STEP_TYPE_GENERIC',
          status: 'CORTEX_STEP_STATUS_DONE',
          metadata: {
            toolCall: {
              id: 'call-1',
              name: 'mcp_file-explorer_folder_folder_register',
              argumentsJson: JSON.stringify({
                path: mcpDir1,
                label: 'Inherited Folder',
                focus: true,
              }),
            },
          },
        },
        {
          type: 'CORTEX_STEP_TYPE_MCP_TOOL',
          status: 'CORTEX_STEP_STATUS_DONE',
          mcpTool: {
            toolCall: {
              id: 'call-2',
              name: 'folder_register',
              argumentsJson: JSON.stringify({
                path: mcpDir2,
                label: 'Post-Fork Folder',
                focus: true,
              }),
            },
          },
        },
      ],
    };

    const state = await getSessionFolderState(convId, null, {
      trajectoryData,
      projectsDirs: [projectsDir],
      appDataDirs: [appDataDir],
    });

    assert.equal(state.isForkedSession, true);
    assert.equal(state.parentConversationId, 'parent-conv-999');
    assert.equal(state.focusedPath, mcpDir2);
    assert.equal(state.folders.length, 5);

    const wsEntry = state.folders.find((f) => f.path === wsDir);
    assert.ok(wsEntry);
    assert.deepEqual(wsEntry.sources, ['workspace', 'project']);

    const mcp1Entry = state.folders.find((f) => f.path === mcpDir1);
    assert.ok(mcp1Entry);
    assert.equal(mcp1Entry.inheritedFromFork, true);
    assert.equal(mcp1Entry.label, 'Inherited Folder');

    const mcp2Entry = state.folders.find((f) => f.path === mcpDir2);
    assert.ok(mcp2Entry);
    assert.equal(mcp2Entry.isFocused, true);
    assert.equal(mcp2Entry.inheritedFromFork, false);

    const brainEntry = state.folders.find((f) => f.path === brainDir);
    assert.ok(brainEntry);
    assert.equal(brainEntry.primarySource, 'artifact');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('folder_unregister removes folder and shifts focus', async () => {
  const trajectoryData = {
    ok: true,
    metadata: {},
    parentReferences: [],
    steps: [
      {
        type: 'CORTEX_STEP_TYPE_GENERIC',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: {
          toolCall: {
            id: 'c1',
            name: 'folder_register',
            argumentsJson: JSON.stringify({ path: '/tmp/dir-a', label: 'A' }),
          },
        },
      },
      {
        type: 'CORTEX_STEP_TYPE_GENERIC',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: {
          toolCall: {
            id: 'c2',
            name: 'folder_register',
            argumentsJson: JSON.stringify({ path: '/tmp/dir-b', label: 'B' }),
          },
        },
      },
      {
        type: 'CORTEX_STEP_TYPE_GENERIC',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: {
          toolCall: {
            id: 'c3',
            name: 'folder_unregister',
            argumentsJson: JSON.stringify({ path: '/tmp/dir-b' }),
          },
        },
      },
    ],
  };

  const state = await getSessionFolderState('conv-test', null, {
    trajectoryData,
    includeBrainDir: false,
  });

  assert.equal(state.folders.length, 1);
  assert.equal(state.folders[0].path, '/tmp/dir-a');
  assert.equal(state.focusedPath, '/tmp/dir-a');
});

test('extractFolderStepAction supports CLI fallback in run_command steps', () => {
  const step = {
    type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      toolCall: {
        id: 'cmd-1',
        name: 'run_command',
        argumentsJson: JSON.stringify({
          CommandLine:
            'node /path/mcp/folder_mcp.mjs --cli folder_register \'{"path":"/tmp/cli-dir","label":"CLI"}\'',
        }),
      },
    },
  };
  const action = extractFolderStepAction(step);
  assert.ok(action);
  assert.equal(action.toolName, 'folder_register');
  assert.equal(action.args.path, '/tmp/cli-dir');
});

test('file_service lists, searches, creates, renames, deletes, and blocks path traversal and symlink escapes', async () => {
  const outer = mkdtempSync(join(tmpdir(), 'fe-fs-'));
  const root = join(outer, 'root');
  const outside = join(outer, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'nope', 'utf-8');

  try {
    writeFileSync(join(root, '.hidden-file'), 'secret', 'utf-8');

    const createdDir = await createDirectoryInRoot(root, root, 'src');
    assert.equal(createdDir.relPath, 'src');

    const createdFile = await createFileInRoot(
      root,
      createdDir.path,
      'hello.js',
      'console.log(1);\n'
    );
    assert.equal(createdFile.relPath, 'src/hello.js');

    const listHiddenFalse = await listDirectoryInRoot(root, root, {
      showHidden: false,
    });
    assert.deepEqual(
      listHiddenFalse.entries.map((e) => e.name),
      ['src']
    );

    const listHiddenTrue = await listDirectoryInRoot(root, root, {
      showHidden: true,
    });
    assert.deepEqual(
      listHiddenTrue.entries.map((e) => e.name),
      ['src', '.hidden-file']
    );

    const searchRes = await searchFilesInRoot(root, 'hello', {
      showHidden: false,
    });
    assert.equal(searchRes.results.length, 1);
    assert.equal(searchRes.results[0].relPath, 'src/hello.js');

    const renamed = await renamePathInRoot(root, createdFile.path, 'main.js');
    assert.equal(renamed.relPath, 'src/main.js');
    assert.equal(existsSync(renamed.path), true);

    await deletePathInRoot(root, renamed.path);
    assert.equal(existsSync(renamed.path), false);

    assert.throws(() => {
      resolveScopedPath(root, '/etc/passwd');
    }, /outside the selected root folder/);

    await assert.rejects(async () => {
      await deletePathInRoot(root, root);
    }, /not permitted on the root folder itself/);

    // Symlink escape guard: a symlink inside root pointing outside root cannot be used to mutate files outside root
    const escapeLink = join(root, 'escape_link');
    symlinkSync(outside, escapeLink);
    await assert.rejects(async () => {
      await deletePathInRoot(root, join(escapeLink, 'secret.txt'));
    }, /escapes root folder/);
    assert.equal(existsSync(join(outside, 'secret.txt')), true);

    // Deleting the symlink itself inside root is allowed and does not delete target
    await deletePathInRoot(root, escapeLink);
    assert.equal(existsSync(join(outside, 'secret.txt')), true);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`PASS: ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL: ${t.name}`);
    console.error(err);
  }
}
if (failed > 0) {
  process.exit(1);
}
console.log(`All ${tests.length} tests passed.`);
