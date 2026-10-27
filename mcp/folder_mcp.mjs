/**
 * @fileoverview Stdio MCP Server for `file-explorer`.
 *
 * Exposes `folder_*` tools so the agent can register, focus, unregister,
 * or list additional on-premise folders for the active chat session's File Explorer.
 *
 * All session folder state is persisted natively inside the per-conversation
 * Trajectory (`CortexStepMcpTool` steps) rather than on the filesystem, so it
 * is automatically inherited when a chat session is forked in the client.
 */

import {
  getSessionFolderState,
  normalizeFolderPath,
} from '../lib/session_folders.mjs';

const SERVER_INFO = {
  name: 'folder',
  version: '0.1.1',
};

const TOOLS = [
  {
    name: 'folder_register',
    description:
      'Register an additional on-premise directory in the current chat session File Explorer (and focus it by default). Tracked purely in per-session trajectory metadata and inherited across client-side session forks.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the directory to register (absolute, ~/..., or file://...).',
        },
        label: {
          type: 'string',
          description:
            'Optional short human-readable label describing what this folder is used for in this session.',
        },
        focus: {
          type: 'boolean',
          description:
            'Whether to make this folder the currently selected root folder in the File Explorer UI (defaults to true).',
        },
      },
      required: ['path'],
    },
    _meta: {
      'antigravity/alwaysLoad': true,
    },
  },
  {
    name: 'folder_focus',
    description:
      'Set the active focused root directory in the File Explorer for the current chat session (registers it in the session metadata if not already tracked).',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the directory to focus as the active root in the File Explorer.',
        },
        label: {
          type: 'string',
          description: 'Optional updated short label for this folder.',
        },
      },
      required: ['path'],
    },
    _meta: {
      'antigravity/alwaysLoad': true,
    },
  },
  {
    name: 'folder_unregister',
    description:
      'Unregister a directory from the current chat session File Explorer metadata without modifying files on disk.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the directory to remove from session tracking.',
        },
      },
      required: ['path'],
    },
    _meta: {
      'antigravity/alwaysLoad': true,
    },
  },
  {
    name: 'folder_list',
    description:
      'List all root directories available in the active chat session File Explorer, including MCP-registered folders, session workspace folders, project folders, brain/artifact directory, and any folders inherited from a forked parent session.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    _meta: {
      'antigravity/alwaysLoad': true,
    },
  },
];

let useContentLengthFraming = false;
let inputBuffer = Buffer.alloc(0);

process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') {
    process.exit(0);
  }
});

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  if (useContentLengthFraming) {
    const byteLen = Buffer.byteLength(json, 'utf-8');
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleToolCall(params) {
  const rawToolName = params?.name || '';
  const args = params?.arguments || {};
  const meta = params?._meta || {};
  const conversationId =
    meta['antigravity.google/conversation_id'] ||
    args.conversation_id ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    '';

  const match = /(?:^|_)(folder_(?:register|focus|unregister|list))$/.exec(
    rawToolName
  );
  const toolName = match ? match[1] : rawToolName;

  if (
    toolName === 'folder_register' ||
    toolName === 'folder_focus' ||
    toolName === 'folder_unregister'
  ) {
    const folderPath = normalizeFolderPath(args.path || '');
    if (!folderPath) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Missing required argument: `path`.' }],
      };
    }

    const pendingAction = {
      toolName,
      args: { ...args, path: folderPath },
      createdAt: new Date().toISOString(),
    };
    const state = await getSessionFolderState(conversationId, pendingAction);

    const actionVerb =
      toolName === 'folder_unregister'
        ? 'Unregistered'
        : toolName === 'folder_focus'
        ? 'Focused'
        : 'Registered';

    const payload = {
      ok: true,
      action: toolName,
      message: `${actionVerb} folder ${folderPath} in session ${conversationId || '(active)'}`,
      conversationId,
      focusedPath: state.focusedPath,
      trackedCount: state.folders.length,
      folders: state.folders,
    };

    return {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  }

  if (toolName === 'folder_list') {
    const state = await getSessionFolderState(conversationId, null);
    const payload = {
      ok: true,
      conversationId,
      projectId: state.projectId,
      projectName: state.projectName,
      isForkedSession: state.isForkedSession,
      parentConversationId: state.parentConversationId,
      focusedPath: state.focusedPath,
      trackedCount: state.folders.length,
      folders: state.folders,
    };
    return {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  }

  return {
    isError: true,
    content: [{ type: 'text', text: `Unknown tool: ${rawToolName}` }],
  };
}

async function processRpcMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.id === undefined || msg.id === null) {
    return;
  }

  try {
    switch (msg.method) {
      case 'initialize': {
        const clientProtocol = msg.params?.protocolVersion || '2024-11-05';
        sendResult(msg.id, {
          protocolVersion: clientProtocol,
          capabilities: {
            tools: {},
          },
          serverInfo: SERVER_INFO,
        });
        break;
      }
      case 'ping': {
        sendResult(msg.id, {});
        break;
      }
      case 'tools/list': {
        sendResult(msg.id, { tools: TOOLS });
        break;
      }
      case 'tools/call': {
        const result = await handleToolCall(msg.params || {});
        sendResult(msg.id, result);
        break;
      }
      default: {
        sendError(msg.id, -32601, `Method not found: ${msg.method}`);
        break;
      }
    }
  } catch (err) {
    sendError(msg.id, -32603, err?.message || String(err));
  }
}

function drainInputBuffer() {
  while (inputBuffer.length > 0) {
    const headerStart = inputBuffer.subarray(0, 32).toString('utf-8');
    if (headerStart.startsWith('Content-Length:')) {
      useContentLengthFraming = true;
      const sepIdx = inputBuffer.indexOf('\r\n\r\n');
      if (sepIdx === -1) return;
      const headerText = inputBuffer.subarray(0, sepIdx).toString('utf-8');
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      const bodyLen = match ? Number(match[1]) : 0;
      const totalLen = sepIdx + 4 + bodyLen;
      if (inputBuffer.length < totalLen) return;
      const bodyText = inputBuffer.subarray(sepIdx + 4, totalLen).toString('utf-8');
      inputBuffer = inputBuffer.subarray(totalLen);
      try {
        processRpcMessage(JSON.parse(bodyText));
      } catch (err) {
        sendError(null, -32700, `Parse error: ${err.message}`);
      }
    } else {
      const nlIdx = inputBuffer.indexOf('\n');
      if (nlIdx === -1) return;
      const line = inputBuffer.subarray(0, nlIdx).toString('utf-8').trim();
      inputBuffer = inputBuffer.subarray(nlIdx + 1);
      if (!line) continue;
      try {
        processRpcMessage(JSON.parse(line));
      } catch (err) {
        sendError(null, -32700, `Parse error: ${err.message}`);
      }
    }
  }
}

if (process.argv[2] === '--cli') {
  const cliToolName = process.argv[3] || '';
  const cliArgsRaw = process.argv[4] || '{}';
  let cliArgs = {};
  try {
    cliArgs = JSON.parse(cliArgsRaw);
  } catch (err) {
    console.error(`Invalid JSON arguments: ${err.message}`);
    process.exit(1);
  }
  handleToolCall({
    name: cliToolName,
    arguments: cliArgs,
  }).then((res) => {
    const text = res.content?.[0]?.text || '';
    if (res.isError) {
      console.error(text);
      process.exit(1);
    }
    console.log(text);
    process.exit(0);
  });
} else {
  process.stdin.on('data', (chunk) => {
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    drainInputBuffer();
  });
  process.stdin.on('end', () => {
    process.exit(0);
  });
}
