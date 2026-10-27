/**
 * @fileoverview Per-chat session root folder metadata resolver for `file-explorer`.
 *
 * Aggregates root folders associated with a conversation from:
 * 1. Session workspace URIs (`CortexTrajectoryMetadata.workspace_uris` / `workspaces`)
 * 2. Project folder resources (`~/.gemini/config/projects/<project_id>.json`)
 * 3. Session folders registered via `folder_*` MCP tool steps in the trajectory
 *    (inherited across client-side session forks with zero filesystem markers)
 * 4. Conversation brain / artifact directory (`brain/<conv-id>`)
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const HOME = homedir();
const FOLDER_TOOL_RE =
  /(?:^|_)(folder_(?:register|focus|unregister|list|add|remove))$/;

const DEFAULT_PROJECTS_DIRS = [
  join(HOME, '.gemini', 'config', 'projects'),
  join(HOME, '.gemini', 'config_dev', 'projects'),
];

let cachedRuntimeEnv = null;

/**
 * Normalizes a directory path (`file://`, `~/`, relative, trailing slashes).
 */
export function normalizeFolderPath(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('file://')) {
    try {
      trimmed = decodeURIComponent(new URL(trimmed).pathname);
    } catch {
      trimmed = trimmed.replace(/^file:\/\//, '');
    }
  } else if (trimmed === '~') {
    trimmed = HOME;
  } else if (trimmed.startsWith('~/')) {
    trimmed = join(HOME, trimmed.slice(2));
  }
  const resolved = resolve(trimmed);
  return resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved;
}

/**
 * Formats a concise human-readable path string (`~/...`).
 */
export function formatFolderDisplayPath(folderPath) {
  if (!folderPath) return '';
  if (folderPath === HOME) return '~';
  if (folderPath.startsWith(`${HOME}/`)) {
    return `~/${folderPath.slice(HOME.length + 1)}`;
  }
  return folderPath;
}

/**
 * Discovers the running Language Server address, CSRF token, and appDataDir
 * from process environment, `/proc/<pid>/environ`, or `~/.gemini/*`.
 */
export function resolveLanguageServerConnection() {
  const envAddr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const envCsrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  const envAppData = (process.env.ANTIGRAVITY_APP_DATA_DIR || '').trim();

  if (envAddr && envCsrf && envAppData) {
    return {
      address: envAddr,
      csrfToken: envCsrf,
      appDataDirs: [envAppData],
    };
  }
  if (
    cachedRuntimeEnv?.address &&
    cachedRuntimeEnv?.csrfToken &&
    cachedRuntimeEnv?.appDataDirs?.length
  ) {
    return {
      address: envAddr || cachedRuntimeEnv.address,
      csrfToken: envCsrf || cachedRuntimeEnv.csrfToken,
      appDataDirs: envAppData
        ? [envAppData, ...cachedRuntimeEnv.appDataDirs]
        : cachedRuntimeEnv.appDataDirs,
    };
  }

  let procAddr = '';
  let procCsrf = '';
  let procAppData = '';

  try {
    const pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
    for (const pid of pids) {
      try {
        const raw = readFileSync(`/proc/${pid}/environ`, 'utf-8');
        if (
          !raw.includes('ANTIGRAVITY_LS_ADDRESS=') &&
          !raw.includes('ANTIGRAVITY_APP_DATA_DIR=')
        ) {
          continue;
        }
        for (const entry of raw.split('\0')) {
          if (!procAddr && entry.startsWith('ANTIGRAVITY_LS_ADDRESS=')) {
            procAddr = entry.slice('ANTIGRAVITY_LS_ADDRESS='.length).trim();
          } else if (!procCsrf && entry.startsWith('ANTIGRAVITY_CSRF_TOKEN=')) {
            procCsrf = entry.slice('ANTIGRAVITY_CSRF_TOKEN='.length).trim();
          } else if (!procAppData && entry.startsWith('ANTIGRAVITY_APP_DATA_DIR=')) {
            procAppData = entry.slice('ANTIGRAVITY_APP_DATA_DIR='.length).trim();
          }
        }
        if (procAddr && procCsrf && procAppData) {
          break;
        }
      } catch {
        // Ignore unreadable /proc entries
      }
    }
  } catch {
    // Ignore /proc scan errors on non-Linux systems
  }

  const candidateDirs = [];
  const addDir = (d) => {
    if (d && !candidateDirs.includes(d)) candidateDirs.push(d);
  };

  addDir(envAppData);
  addDir(procAppData);

  const geminiRoot = join(HOME, '.gemini');
  try {
    const subdirs = readdirSync(geminiRoot, { withFileTypes: true });
    for (const dirent of subdirs) {
      if (!dirent.isDirectory() || dirent.name.startsWith('config')) continue;
      const candidate = join(geminiRoot, dirent.name);
      if (
        existsSync(join(candidate, 'brain')) ||
        existsSync(join(candidate, 'conversations')) ||
        existsSync(join(candidate, 'conversation_summaries.db'))
      ) {
        addDir(candidate);
      }
    }
  } catch {
    // Ignore scan errors
  }

  addDir(join(HOME, '.gemini', 'antigravity'));

  cachedRuntimeEnv = {
    address: envAddr || procAddr,
    csrfToken: envCsrf || procCsrf,
    appDataDirs: candidateDirs,
  };
  return cachedRuntimeEnv;
}

/**
 * Calls a method on `exa.language_server_pb.LanguageServerService`.
 */
export async function callLanguageServerRpc(method, payload = {}, timeoutMs = 4000) {
  const { address, csrfToken } = resolveLanguageServerConnection();
  if (!address) {
    return { ok: false, status: 0, data: null, error: 'Language Server address not found' };
  }
  let baseUrl = address;
  if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    baseUrl = `http://${baseUrl}`;
  }
  baseUrl = baseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/exa.language_server_pb.LanguageServerService/${method}`;

  const headers = { 'Content-Type': 'application/json' };
  if (csrfToken) {
    headers['x-codeium-csrf-token'] = csrfToken;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
    return { ok: resp.ok, status: resp.status, data };
  } catch (err) {
    cachedRuntimeEnv = null;
    return { ok: false, status: 0, data: null, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches all trajectory steps, metadata, and fork lineage for `conversationId`.
 */
export async function fetchConversationTrajectory(conversationId) {
  if (!conversationId) {
    return { ok: false, steps: [], parentReferences: [], metadata: {} };
  }
  const res = await callLanguageServerRpc('GetCascadeTrajectory', {
    cascadeId: conversationId,
  });
  if (!res.ok || !res.data?.trajectory) {
    return { ok: false, steps: [], parentReferences: [], metadata: {} };
  }

  const trajectory = res.data.trajectory;
  const steps = Array.isArray(trajectory.steps) ? [...trajectory.steps] : [];
  const totalSteps = Number(
    res.data.numTotalSteps ?? res.data.num_total_steps ?? trajectory.numTotalSteps ?? steps.length
  );

  while (steps.length < totalSteps) {
    const pageRes = await callLanguageServerRpc('GetCascadeTrajectorySteps', {
      cascadeId: conversationId,
      stepOffset: steps.length,
    });
    const pageSteps = pageRes.data?.steps;
    if (!pageRes.ok || !Array.isArray(pageSteps) || pageSteps.length === 0) {
      break;
    }
    steps.push(...pageSteps);
  }

  return {
    ok: true,
    steps,
    parentReferences: Array.isArray(trajectory.parentReferences)
      ? trajectory.parentReferences
      : Array.isArray(trajectory.parent_references)
      ? trajectory.parent_references
      : [],
    metadata: trajectory.metadata || {},
  };
}

/**
 * Extracts normalized workspace folder paths from `CortexTrajectoryMetadata`.
 */
export function extractWorkspacePathsFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return [];
  const paths = [];
  const seen = new Set();

  const addRaw = (raw) => {
    const norm = normalizeFolderPath(raw);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      paths.push(norm);
    }
  };

  const direct = metadata.workspaceUris ?? metadata.workspace_uris ?? [];
  if (Array.isArray(direct)) {
    for (const u of direct) {
      if (typeof u === 'string') addRaw(u);
    }
  }

  const wsList = metadata.workspaces ?? [];
  if (Array.isArray(wsList)) {
    for (const w of wsList) {
      const u =
        w?.workspaceFolderAbsoluteUri ||
        w?.workspace_folder_absolute_uri ||
        w?.gitRootAbsoluteUri ||
        w?.git_root_absolute_uri;
      if (typeof u === 'string') addRaw(u);
    }
  }

  return paths;
}

/**
 * Extracts folder resources from a `Resources` protojson object.
 */
function extractResourcesArray(resourcesWrapper) {
  const list = resourcesWrapper?.resources;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list) {
    const folderUri =
      r?.folderUri ||
      r?.folder_uri ||
      r?.gitFolder?.folderUri ||
      r?.git_folder?.folder_uri ||
      '';
    const norm = normalizeFolderPath(folderUri);
    if (!norm) continue;
    out.push({
      path: norm,
      isGit: Boolean(r?.gitFolder || r?.git_folder),
      defaultBranch:
        r?.gitFolder?.defaultBranch || r?.git_folder?.default_branch || '',
    });
  }
  return out;
}

/**
 * Reads associated folders for a project (`~/.gemini/config/projects/<projectId>.json`).
 */
export function loadProjectFolders(projectId, environmentId = '', options = {}) {
  const cleanId = String(projectId || '').trim();
  if (
    !cleanId ||
    cleanId === 'outside-of-project' ||
    cleanId === 'default-cli-project' ||
    cleanId.includes('/') ||
    cleanId.includes('..')
  ) {
    return { projectId: cleanId, projectName: '', folders: [] };
  }

  const projectsDirs = options.projectsDirs || DEFAULT_PROJECTS_DIRS;
  let projJson = null;
  for (const dir of projectsDirs) {
    const candidate = join(dir, `${cleanId}.json`);
    if (existsSync(candidate)) {
      try {
        projJson = JSON.parse(readFileSync(candidate, 'utf-8'));
        break;
      } catch {
        // Ignore malformed project JSON
      }
    }
  }

  if (!projJson || typeof projJson !== 'object') {
    return { projectId: cleanId, projectName: '', folders: [] };
  }

  const projectName = String(projJson.name || '').trim();
  const seen = new Set();
  const folders = [];

  const addFolder = (entry, envName = '') => {
    if (!entry?.path || seen.has(entry.path)) return;
    seen.add(entry.path);
    folders.push({
      path: entry.path,
      isGit: Boolean(entry.isGit),
      defaultBranch: entry.defaultBranch || '',
      envName,
    });
  };

  if (environmentId) {
    const envs = projJson.environments?.environments;
    if (Array.isArray(envs)) {
      const matchedEnv = envs.find((e) => e?.id === environmentId);
      if (matchedEnv) {
        for (const item of extractResourcesArray(matchedEnv.resources)) {
          addFolder(item, matchedEnv.name || '');
        }
      }
    }
  }

  for (const item of extractResourcesArray(projJson.projectResources ?? projJson.project_resources)) {
    addFolder(item, '');
  }

  return {
    projectId: cleanId,
    projectName,
    folders,
  };
}

/**
 * Resolves the conversation's artifact (`brain/<conversationId>`) directory path.
 */
export function resolveConversationBrainDir(conversationId, options = {}) {
  const cleanId = String(conversationId || '').trim();
  if (!cleanId || cleanId.includes('/') || cleanId.includes('..')) return '';
  const appDataDirs =
    options.appDataDirs || resolveLanguageServerConnection().appDataDirs || [];
  for (const root of appDataDirs) {
    const candidate = join(root, 'brain', cleanId);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  const primaryRoot = appDataDirs[0] || join(HOME, '.gemini', 'antigravity');
  return join(primaryRoot, 'brain', cleanId);
}

/**
 * Extracts a normalized `folder_*` action from a trajectory step, or null.
 */
export function extractFolderStepAction(step) {
  if (!step) return null;
  const status = step.status || '';
  if (
    status === 'CORTEX_STEP_STATUS_ERROR' ||
    status === 'CORTEX_STEP_STATUS_FAILED' ||
    status === 'CORTEX_STEP_STATUS_CANCELED'
  ) {
    return null;
  }

  if (
    step.type === 'CORTEX_STEP_TYPE_MCP_TOOL' ||
    step.type === 'CORTEX_STEP_TYPE_GENERIC'
  ) {
    const mcpTool = step.mcpTool || step.mcp_tool;
    const toolCall =
      mcpTool?.toolCall ||
      mcpTool?.tool_call ||
      step.metadata?.toolCall ||
      step.metadata?.tool_call;
    const rawName = toolCall?.name || '';
    const match = FOLDER_TOOL_RE.exec(rawName);
    if (match) {
      const canonicalTool = match[1];
      let args = {};
      const argsJson = toolCall?.argumentsJson ?? toolCall?.arguments_json ?? '';
      if (typeof argsJson === 'string' && argsJson.trim()) {
        try {
          args = JSON.parse(argsJson);
        } catch {
          return null;
        }
      } else if (argsJson && typeof argsJson === 'object') {
        args = argsJson;
      }

      return {
        toolCallId: toolCall?.id || '',
        toolName: canonicalTool,
        args,
        createdAt: step.metadata?.createdAt || '',
      };
    }
  }

  // Fallback for CLI invocation (`folder_mcp.mjs --cli folder_register '<json>'`)
  if (
    step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND' ||
    step.type === 'CORTEX_STEP_TYPE_GENERIC'
  ) {
    const metaToolCall = step.metadata?.toolCall || step.metadata?.tool_call;
    const argsJson = metaToolCall?.argumentsJson ?? metaToolCall?.arguments_json ?? '';
    let cmdLine = '';
    if (typeof argsJson === 'string' && argsJson.includes('folder_')) {
      try {
        const parsed = JSON.parse(argsJson);
        cmdLine = parsed.CommandLine || '';
      } catch {
        return null;
      }
    }
    if (!cmdLine) return null;
    const cliMatch =
      /--cli\s+(?:[a-z0-9_]*_)?(folder_(?:register|focus|unregister|list))\s+'([^']+)'/.exec(
        cmdLine
      );
    if (!cliMatch) return null;
    try {
      const args = JSON.parse(cliMatch[2]);
      return {
        toolCallId: metaToolCall?.id || '',
        toolName: cliMatch[1],
        args,
        createdAt: step.metadata?.createdAt || '',
      };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Applies a single `folder_*` action onto the session folder state.
 */
export function applyFolderAction(state, action, stepIndex, isInheritedFromFork = false) {
  const { toolName, args, createdAt } = action;
  const rawPath = args.path || args.folder_path || args.folderPath || '';
  const folderPath = normalizeFolderPath(rawPath);

  if (toolName === 'folder_register' || toolName === 'folder_add') {
    if (!folderPath) return;
    state.unregisteredPaths.delete(folderPath);
    const prev = state.mcpEntries.get(folderPath);
    const label = String(args.label ?? args.description ?? prev?.label ?? '').trim();
    const shouldFocus = args.focus !== false;

    state.mcpEntries.set(folderPath, {
      path: folderPath,
      label,
      registeredStep: prev ? prev.registeredStep : stepIndex,
      updatedStep: stepIndex,
      updatedAt: createdAt || prev?.updatedAt || '',
      inheritedFromFork: prev ? prev.inheritedFromFork : isInheritedFromFork,
    });

    if (shouldFocus || !state.focusedPath) {
      state.focusedPath = folderPath;
      state.focusedStep = stepIndex;
    }
    return;
  }

  if (toolName === 'folder_focus') {
    if (!folderPath) return;
    state.unregisteredPaths.delete(folderPath);
    const prev = state.mcpEntries.get(folderPath);
    const label = String(args.label ?? args.description ?? prev?.label ?? '').trim();

    state.mcpEntries.set(folderPath, {
      path: folderPath,
      label,
      registeredStep: prev ? prev.registeredStep : stepIndex,
      updatedStep: stepIndex,
      updatedAt: createdAt || prev?.updatedAt || '',
      inheritedFromFork: prev ? prev.inheritedFromFork : isInheritedFromFork,
    });
    state.focusedPath = folderPath;
    state.focusedStep = stepIndex;
    return;
  }

  if (toolName === 'folder_unregister' || toolName === 'folder_remove') {
    if (!folderPath) return;
    state.mcpEntries.delete(folderPath);
    state.unregisteredPaths.add(folderPath);
    if (state.focusedPath === folderPath) {
      let nextFocus = '';
      let bestStep = -1;
      for (const item of state.mcpEntries.values()) {
        if (item.updatedStep >= bestStep) {
          bestStep = item.updatedStep;
          nextFocus = item.path;
        }
      }
      state.focusedPath = nextFocus;
      state.focusedStep = stepIndex;
    }
  }
}

/**
 * Resolves all root folders associated with a conversation (workspace URIs,
 * project folders, MCP-registered session folders, and brain/artifact directory).
 *
 * @param {string} conversationId
 * @param {?Object=} pendingAction Optional in-flight MCP action
 * @param {Object=} options Optional overrides for testing (`trajectoryData`, `projectsDirs`, `appDataDirs`)
 */
export async function getSessionFolderState(
  conversationId,
  pendingAction = null,
  options = {}
) {
  const traj =
    options.trajectoryData || (await fetchConversationTrajectory(conversationId));
  const steps = traj.steps || [];
  const metadata = traj.metadata || {};

  // Detect fork boundary step index if this conversation was forked in the client
  let forkBoundaryStep = -1;
  let parentConversationId = '';
  const parentRefs = traj.parentReferences || [];
  if (parentRefs.length > 0) {
    const lastRef = parentRefs[parentRefs.length - 1];
    parentConversationId =
      lastRef.conversationId ||
      lastRef.conversation_id ||
      lastRef.cascadeId ||
      lastRef.cascade_id ||
      '';
    const refIdx = Number(lastRef.stepIndex ?? lastRef.step_index ?? -1);
    if (Number.isFinite(refIdx) && refIdx >= 0) {
      forkBoundaryStep = refIdx;
    }
  }
  for (let i = 0; i < steps.length; i++) {
    const sysMsg = steps[i]?.systemMessage || steps[i]?.system_message;
    if (sysMsg?.eventType === 'FORK_NOTICE' || sysMsg?.event_type === 'FORK_NOTICE') {
      forkBoundaryStep = i;
    }
  }

  const foldState = {
    mcpEntries: new Map(),
    unregisteredPaths: new Set(),
    focusedPath: '',
    focusedStep: -1,
    seenToolCallIds: new Set(),
  };

  for (let i = 0; i < steps.length; i++) {
    const action = extractFolderStepAction(steps[i]);
    if (!action) continue;
    if (action.toolCallId) {
      foldState.seenToolCallIds.add(action.toolCallId);
    }
    const isInherited = forkBoundaryStep >= 0 && i <= forkBoundaryStep;
    applyFolderAction(foldState, action, i, isInherited);
  }

  if (
    pendingAction &&
    (!pendingAction.toolCallId || !foldState.seenToolCallIds.has(pendingAction.toolCallId))
  ) {
    applyFolderAction(foldState, pendingAction, steps.length, false);
  }

  // 1. Session workspace folders
  const workspacePaths = extractWorkspacePathsFromMetadata(metadata);

  // 2. Project resource folders
  const projectId = String(
    metadata.projectId || metadata.project_id || process.env.ANTIGRAVITY_PROJECT_ID || ''
  ).trim();
  const environmentId = String(
    metadata.environmentId || metadata.environment_id || ''
  ).trim();
  const projectInfo = loadProjectFolders(projectId, environmentId, options);

  // 3. Conversation brain / artifact folder
  const brainDir =
    options.includeBrainDir === false
      ? ''
      : resolveConversationBrainDir(conversationId, options);

  // Merge all candidate root folders by normalized path
  const byPath = new Map();

  const ensureEntry = (folderPath, source, extra = {}) => {
    if (!folderPath || foldState.unregisteredPaths.has(folderPath)) return null;
    let item = byPath.get(folderPath);
    if (!item) {
      item = {
        path: folderPath,
        uri: `file://${folderPath}`,
        name: basename(folderPath) || '/',
        displayPath: formatFolderDisplayPath(folderPath),
        label: '',
        sources: [],
        primarySource: source,
        inheritedFromFork: false,
        registeredStep: -1,
        updatedStep: -1,
        updatedAt: '',
        existsOnDisk: existsSync(folderPath),
      };
      byPath.set(folderPath, item);
    }
    if (!item.sources.includes(source)) {
      item.sources.push(source);
    }
    if (extra.label && !item.label) {
      item.label = extra.label;
    }
    if (extra.overrideLabel) {
      item.label = extra.overrideLabel;
    }
    if (extra.inheritedFromFork) {
      item.inheritedFromFork = true;
    }
    if (typeof extra.registeredStep === 'number' && extra.registeredStep >= 0) {
      item.registeredStep = extra.registeredStep;
    }
    if (typeof extra.updatedStep === 'number' && extra.updatedStep >= 0) {
      item.updatedStep = extra.updatedStep;
    }
    if (extra.updatedAt) {
      item.updatedAt = extra.updatedAt;
    }
    return item;
  };

  for (const wsPath of workspacePaths) {
    ensureEntry(wsPath, 'workspace');
  }

  for (const pf of projectInfo.folders) {
    ensureEntry(pf.path, 'project', {
      label: projectInfo.projectName || pf.envName || '',
    });
  }

  for (const mcpItem of foldState.mcpEntries.values()) {
    ensureEntry(mcpItem.path, 'mcp', {
      overrideLabel: mcpItem.label || undefined,
      inheritedFromFork: mcpItem.inheritedFromFork,
      registeredStep: mcpItem.registeredStep,
      updatedStep: mcpItem.updatedStep,
      updatedAt: mcpItem.updatedAt,
    });
  }

  if (brainDir) {
    ensureEntry(brainDir, 'artifact', {
      label: 'Brain & Artifacts',
    });
  }

  const allFolders = [...byPath.values()];

  // Determine effective focused root folder
  let effectiveFocusedPath = '';
  if (foldState.focusedPath && byPath.has(foldState.focusedPath)) {
    effectiveFocusedPath = foldState.focusedPath;
  } else {
    const existing = allFolders.filter((f) => f.existsOnDisk);
    const pool = existing.length > 0 ? existing : allFolders;
    if (pool.length > 0) {
      effectiveFocusedPath = pool[0].path;
    }
  }

  const sourceOrder = { workspace: 1, project: 2, mcp: 3, artifact: 4 };

  const folders = allFolders.map((item) => {
    const isMcp = item.sources.includes('mcp');
    const primarySource = item.sources.includes('workspace')
      ? 'workspace'
      : item.sources.includes('project')
      ? 'project'
      : isMcp
      ? 'mcp'
      : 'artifact';
    return {
      ...item,
      primarySource,
      isMcpRegistered: isMcp,
      isFocused: item.path === effectiveFocusedPath,
    };
  });

  folders.sort((a, b) => {
    // Keep artifact folder at the end of the selector unless it is the only folder
    const aIsArtifactOnly = a.primarySource === 'artifact' && !a.isMcpRegistered;
    const bIsArtifactOnly = b.primarySource === 'artifact' && !b.isMcpRegistered;
    if (aIsArtifactOnly !== bIsArtifactOnly) {
      return aIsArtifactOnly ? 1 : -1;
    }
    const orderA = sourceOrder[a.primarySource] || 99;
    const orderB = sourceOrder[b.primarySource] || 99;
    if (orderA !== orderB) return orderA - orderB;
    if (b.updatedStep !== a.updatedStep) return b.updatedStep - a.updatedStep;
    return a.path.localeCompare(b.path);
  });

  return {
    conversationId,
    projectId: projectInfo.projectId,
    projectName: projectInfo.projectName,
    focusedPath: effectiveFocusedPath,
    explicitFocusedPath: foldState.focusedPath,
    focusedStep: foldState.focusedStep,
    isForkedSession: forkBoundaryStep >= 0 || Boolean(parentConversationId),
    parentConversationId,
    forkBoundaryStep,
    folders,
  };
}
