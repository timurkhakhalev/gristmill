# M7b settings and notes integration manifest

This manifest records the shared cleanup that remains for M7 after the local
settings and notes surfaces were cut over. No shared files are changed by M7b.

## Shared imports and calls to remove or rewire

- `src/components/ui/PromptStudio.tsx`: remove `usePolicySnapshot` and
  `selectPolicyEffectiveSettings`; read the raw local settings store.
- `src/components/notes/NoteRecordControl.tsx`: remove managed-policy tooltip
  and any policy-based disabled state. Meeting capture remains available.
- `src/components/notes/UploadAudioView.tsx`: M6-owned; remove remaining team
  folder assumptions and direct cloud-account gating while preserving upload,
  calendar metadata, and provider API-key paths.
- `src/stores/meetingRecordingStore.ts`: retain meeting recording and speaker
  detection, but remove policy/managed checks from recording start/stop.
- `src/components/onboarding/*`, `src/App.jsx`, `src/components/ControlPanel*`,
  `src/components/controlPanelNav.ts`: remove account, workspace, policy, and
  dictation settings navigation in the M7 shell cutover.

## IPC and type surface

- Keep local note/folder, dictionary, snippets, model-list, retention, upload,
  calendar, and direct-provider IPC methods.
- Remove cloud sync, invitation, workspace, share/conflict, managed-policy,
  and cloud backup IPC calls once their remaining shared consumers are removed.
- Remove corresponding cloud/share/workspace fields from shared electron types
  only after all M7/M6 consumers are cut over; do not remove direct provider
  credentials, calendar OAuth fields, or local note metadata.

## Settings and schema

- `settingsStore` now writes dictionary and snippets to local storage/SQLite
  only; `SyncService` is no longer called by those setters.
- Keep `customDictionary`, `snippets`, direct provider API keys, Bedrock/Azure/
  Vertex credentials, local/self-hosted routing, calendar accounts, retention,
  and note-file preferences.
- Remove account, billing, workspace, managed policy, cloud backup, cloud
  identity, and cloud engagement preferences after shared readers are removed.
- No database migration is required for local notes, folders, dictionary,
  snippets, or calendar data. M7 should separately remove obsolete cloud
  columns/tables only after a database/schema inventory confirms no retained
  reader.

## Translation keys

The local UI no longer reads account, billing, workspace, team invitation,
managed-policy, cloud-sync, sharing/conflict, or dictation-settings keys from
the owned surfaces. M7 may remove their now-unreferenced `settings*`,
`workspaces*`, `team*`, `sharing*`, `conflict*`, and managed-policy keys after
searching the complete source tree. Keep notes/folders/editor/action,
meeting/upload/provider, dictionary/snippets, calendar, privacy, and local
retention keys.
