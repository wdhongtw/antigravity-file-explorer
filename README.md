# Session File Explorer (`file-explorer`)

Interactive UI plugin and MCP toolset (`folder_*`) for browsing files across all
directories associated with a project and chat session, with native AuxPane File
Preview (`fileView`) integration.

## Key Features

- **Unified Root Folder Selector**:
  - Automatically populates the top clickable root-folder rows with:
    1. **Session Workspaces** (`CortexTrajectoryMetadata.workspace_uris` /
       `workspaces`)
    2. **Project Folders** (`~/.gemini/config/projects/<project_id>.json`
       `projectResources`)
    3. **Session MCP Registered Folders** (`folder_register` / `folder_focus` /
       `folder_unregister` steps in the conversation trajectory)
    4. **Conversation Brain & Artifacts** (`brain/<conversation-id>`)
- **Per-Chat Session Trajectory Metadata (`folder_*` MCP Tools)**:
  - `folder_register`: Register and optionally focus an additional on-premise
    directory for the current conversation (`path`, `label`, `focus`).
  - `folder_focus`: Switch the active focused root directory in the File Explorer
    UI.
  - `folder_unregister`: Remove a directory from the session's File Explorer
    root list without modifying files on disk.
  - `folder_list`: List all root folders tracked in the current session
    trajectory (including any inherited from a forked parent conversation).
- **Client-Side Session Fork Inheritance**:
  - Registered session folders are stored as `CORTEX_STEP_TYPE_MCP_TOOL` /
    `CORTEX_STEP_TYPE_GENERIC` steps in `CortexTrajectory` with zero filesystem
    marker files, so forked sessions inherit the exact folder state up to the
    fork point while keeping subsequent changes isolated.
- **Expandable Tree View, Search & Scoped File Mutations**:
  - Expand/collapse directories inline, filter/search recursively across the
    selected root folder, toggle hidden dotfiles (`.*`), copy paths, and
    create/rename/delete files and folders via an inline prompt bar.
  - Clicking any file opens it directly in the built-in File Preview (`tabType:
    'fileView'`).
