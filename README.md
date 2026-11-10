# File Explorer (`file-explorer`)

Interactive UI plugin and MCP toolset (`folder_*`) providing both a **per-session AuxPane File Explorer** (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) and a **Global Sidebar File Explorer** (`SIDECAR_UI_ENTRYPOINT_SIDEBAR`).

## Key Features

- **Global Sidebar File Explorer (`/sidebar`, `SIDECAR_UI_ENTRYPOINT_SIDEBAR`)**:
  - **Global State**: Persisted independently of any conversation, defaulting to the user's home folder (`~`).
  - **Folder Bookmarks & Recents**: Bookmark/unbookmark frequently visited directories, rename bookmarks, and jump between bookmarked or recently visited folders from the left rail.
  - **File & Folder Operations**: Create files/folders, rename, duplicate, copy/cut/paste across directories, delete (single or multi-select), and toggle executable permissions (`chmod +x` or octal mode).
  - **File & Folder Upload / Download**: Upload multiple files (`↑ Upload`), upload entire directory trees (`↑ Folder`), or drag-and-drop files and folders directly into the explorer; download individual files directly or automatically bundle directories and multi-item selections into a `.zip` archive (`↓ Download`).
  - **Archive Compression & Extraction**: Compress selected files/folders into `.zip` or `.tar.gz` archives, preview archive contents, and extract `.zip` / `.tar.*` archives directly or into a dedicated subfolder.
  - **Sortable Table & Collapsible Inspector**: Sort by `Name`, `Size`, or `Modified` date; inspect file/folder metadata, calculate recursive directory sizes, compute SHA-256 checksums, and read inline text previews without opening an AuxPane editor tab on click.
- **Session AuxPane File Explorer (`/`, `SIDECAR_UI_ENTRYPOINT_AUX_PANE`)**:
  - Automatically populates the top clickable root-folder rows with:
    1. **Session Workspaces** (`CortexTrajectoryMetadata.workspace_uris` /
       `workspaces`)
    2. **Project Folders** (`~/.gemini/config/projects/<project_id>.json`
       `projectResources`)
    3. **Session MCP Registered Folders** (`folder_register` /
       `folder_unregister` steps in the conversation trajectory)
    4. **Conversation Brain & Artifacts** (`brain/<conversation-id>`)
- **Per-Chat Session Trajectory Metadata (`folder_*` MCP Tools)**:
  - `folder_register`: Register an additional on-premise directory for the
    current conversation (`path`, `label`).
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
    selected root folder, toggle hidden dotfiles (`.*`), copy paths, upload
    files/folders (via picker or drag-and-drop), download files or folders (as
    `.zip`), and create/rename/delete files and folders via a modal overlay.
  - Clicking any file opens it directly in the built-in File Preview (`tabType:
    'fileView'`).
