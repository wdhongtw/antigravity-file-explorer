---
trigger: always_on
---

# Session Folder Tracking (`folder_*`)

Keep the session's File Explorer root folders synchronized with the `folder_*` MCP tools whenever work spans directories outside the default workspace:

- **Proactive registration**: Call `folder_register` when creating, inspecting, or modifying files in an additional on-premise directory, external repository, git worktree, or scratch folder so the user can browse it immediately in the File Explorer panel.
- **Root-level granularity**: Register the logical project or directory root rather than individual files or deep leaf subdirectories.
- **Cleanup & lifecycle**: Call `folder_unregister` when a temporary or scratch directory is no longer relevant to the conversation (unregistering removes session tracking metadata only and never modifies files on disk). Call `folder_list` to verify active root folders, including roots inherited from a forked parent conversation.
- **Interactive AuxPane link**: Surface a clickable `[Open File Explorer](sidecar://file-explorer/explorer_ui/)` pill in chat when directing the user to browse, upload, download, or inspect files in the session File Explorer panel.
