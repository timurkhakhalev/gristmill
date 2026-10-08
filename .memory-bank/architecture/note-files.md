# Note files mirror

This document contains the ownership, layout and failure rules of the Markdown mirror.
User paths: [Note files](../product/user-journeys/note-files.md). Write effects: [note writes](note-writes.md).

## Ownership and activation

- The ControlPanel settings store owns the configuration. MainApp triggers its hydration once. Notification and Companion documents hydrate common settings without configuring the mirror.
- The store serializes enabled and path changes through the note-files IPC bridge.
- Main becomes enabled only after directory initialization and rebuilding succeed. A failed activation leaves main disabled, and the renderer reports the error.
- Only confirmed configuration changes persist. On restart, the last confirmed preference is applied again before it becomes effective.
- Custom path selection and explicit rebuilding exist as IPC operations, without Settings controls. The store path setter applies the complete configuration through the same owner.

## Layout

- Default storage is the notes directory under Electron `userData`.
- A note uses a Markdown file with metadata and Summary or manual content. The transcript is a separate file.
- The backend groups notes by folder name. Root notes use Personal.
- Folder rename reprojects assigned notes. It does not rename a shared directory.
- Root notes stay in Personal when a real folder of that name changes or is deleted.

## Updates

- Calendar and manual meeting creation and successful processing projections update the enabled mirror automatically. This includes transcript, Summary, generated title and speaker corrections.
- The queue reads the latest persisted Note, not a captured earlier row. Empty transcripts remove their old files.
- Raw provider responses and run history stay managed artifacts outside this projection.
- The mirror is a projection of SQLite, not two-way synchronization. Editing a mirror file does not edit a note.
- Disabling mirroring stops future operations, including queued writes, and keeps existing files.
- Granola imports keep their committed counts if the mirror fails. Their result includes a projection error.

## Errors

- Initialization and rebuild errors reach the caller.
- Unsafe descendant directories and file symlinks are rejected.
- Ordinary writes after a database commit are best effort and log failures. They do not roll back SQLite.

## Code locations

- `src/components/SettingsPage.tsx` — Store note files control and errors.
- `src/stores/settingsStore.ts` — configuration owner.
- `src/components/notes/NotesTree.tsx` — Finder actions.
- `src/helpers/noteFilesIpcHandlers.ts` — mirror commands and reveal.
- `src/helpers/ipcHandlers.ts` — main mirror state.
- `src/helpers/markdownMirror.ts` — Markdown projection.
