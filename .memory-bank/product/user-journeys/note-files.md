# Note files

As a Gristmill user, I want to inspect a local Markdown projection of notes.

## User journey

1. Open Settings → Notes and enable Store note files.
2. Wait for the initial rebuild. The switch stays off until main confirms activation and cannot be changed while an operation is pending.
3. Use Show in Finder on a note or folder with an existing mirror.
4. If activation fails, read the error below the switch and retry after fixing the directory.

## Behavior and limits

- The settings store owns configuration. It serializes hydration and enabled/path changes through the note-files IPC bridge. Multiple settings hooks do not trigger multiple rebuilds.
- Main becomes enabled only after directory initialization and rebuilding succeed. A failed activation leaves main disabled and the renderer reports the error. Only confirmed configuration changes persist. On restart, the last confirmed preference is applied again before it becomes effective.
- Custom path selection and explicit rebuilding exist as IPC operations, without Settings controls. The store path setter applies the complete configuration through the same owner.
- Default storage is the notes directory under Electron userData. A note uses a Markdown file with metadata and Summary or manual content; transcript is a separate file.
- The mirror is a projection of SQLite, not two-way synchronization. Editing a mirror file does not edit a note.
- The backend groups by folder name rather than space hierarchy. Equal folder names share a directory; root notes use Personal. Folder rename reprojects assigned notes rather than renaming a shared directory. Root notes remain in Personal when a real folder of that name changes or is deleted.
- Disabling mirroring stops future operations, including queued writes, and keeps existing files.
- Initialization and rebuild errors reach the caller. Unsafe descendant directories and file symlinks are rejected. Ordinary writes after a database commit remain best effort and log failures; they do not roll back SQLite.

## BDD acceptance criteria

- Given a persisted enabled preference, when settings hydrate, then main rebuilds the mirror once and the renderer enables Finder actions after success.
- Given activation or a path change fails, then the switch stays off, an error is shown, and the failed configuration is not persisted.
- Given a root note and a note in a real Personal folder, when that folder is renamed or deleted, then both surviving notes keep mirrors at their current SQLite locations.

## Entry points

- [SettingsPage.tsx](../../../src/components/SettingsPage.tsx) — Store note files control and errors.
- [settingsStore.ts](../../../src/stores/settingsStore.ts) — configuration owner.
- [SpacesTree.tsx](../../../src/components/notes/SpacesTree.tsx) — Finder actions.
- [noteFilesIpcHandlers.ts](../../../src/helpers/noteFilesIpcHandlers.ts) — mirror commands and reveal.
- [ipcHandlers.ts](../../../src/helpers/ipcHandlers.ts) — main mirror state.
- [markdownMirror.ts](../../../src/helpers/markdownMirror.ts) — Markdown projection.
