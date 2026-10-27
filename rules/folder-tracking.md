# Session Folder Tracking (`folder_*`)

When working with additional on-premise directories, scratch folders, or external repositories during a conversation, keep the session's File Explorer root folders synchronized using the `folder_*` MCP tools:

- **Registering an additional folder**: Call `folder_register` with `path`, optional concise `label`, and `focus` (defaults to `true`) so the user can browse it in the File Explorer panel.
- **Switching focus between root folders**: Call `folder_focus` with `path` to switch the active root folder in the File Explorer UI.
- **Unregistering a folder**: Call `folder_unregister` with `path` when the directory is no longer needed in the session's File Explorer.
- **Listing session folders**: Call `folder_list` to inspect all root folders associated with the current session (session workspaces, project folders, MCP-registered folders, and brain/artifact directory, including folders inherited from a forked parent conversation).
