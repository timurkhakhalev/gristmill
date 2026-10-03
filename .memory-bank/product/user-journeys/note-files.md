# Note files: partial integration

As a Gristmill user, I want to inspect a local Markdown projection of notes.

## User journey

1. Open Settings → Notes and inspect Store note files.
2. When this preference is enabled, the notes tree exposes Show in Finder actions.
3. Use Show in Finder only when a corresponding mirror file or directory exists.

## Behavior and limits

- The renderer preference defaults to off. Its setter updates the store/localStorage.
- The current renderer does not call noteFilesSetEnabled, noteFilesSetPath, noteFilesRebuild or noteFilesPickFolder. Main starts with mirroring disabled. The toggle is not a complete user path to activate the mirror.
- Custom path selection and rebuilding exist as IPC operations, without current UI consumers. Do not describe them as available Settings controls.
- Backend default storage is the notes directory under Electron userData. A note uses a Markdown file with metadata and Summary or manual content; transcript is a separate file.
- The mirror is a projection of SQLite, not two-way synchronization. Editing a mirror file does not edit a note.
- The backend groups by folder name rather than space hierarchy. Equal folder names can share a directory; root notes use Personal.
- Disabling backend mirroring stops future operations and does not delete existing files.
- This boundary follows source wiring. It does not establish runtime success of the current toggle or Finder action.

## What to check

- Do not treat visible Finder actions as evidence that files were created.
- Before adding a complete journey, verify renderer-to-main enable/path/rebuild wiring with an isolated profile.

## BDD acceptance criteria

- Given a mirrored file already exists and the preference is enabled, when I reveal that note, then the handler can show its file in Finder.
- Given only the current renderer toggle is used, when its value changes, then the source path updates the preference without invoking the main enable operation.

## Entry points

- [SettingsPage.tsx](../../../src/components/SettingsPage.tsx) — Store note files control.
- [settingsStore.ts](../../../src/stores/settingsStore.ts) — preference setter.
- [SpacesTree.tsx](../../../src/components/notes/SpacesTree.tsx) — Finder actions.
- [noteFilesIpcHandlers.ts](../../../src/helpers/noteFilesIpcHandlers.ts) — mirror commands and reveal.
- [ipcHandlers.ts](../../../src/helpers/ipcHandlers.ts) — main mirror state.
- [markdownMirror.ts](../../../src/helpers/markdownMirror.ts) — Markdown projection.
