# Settings

As a Gristmill user, I want to configure the application and its AI tasks.

## User journey

1. Open Settings from the sidebar.
2. Select a section in General, Meetings, AI or System.
3. Change the relevant controls.
4. Confirm destructive audio actions when prompted.

## Behavior and limits

- General group: Profile, General, Notes. Meetings: Recording, Calendar. AI: Models, Providers, On-device, Dictionary. System: Privacy & Data, Advanced.
- Profile sets the user name. General sets interface language, theme, color scheme, date/time format, startup and notifications.
- Notes controls automatic titles and the Store note files preference. See [Note files](note-files.md) for its partial integration.
- Recording controls meeting companion, Chrome Companion setup, hotkey/layout, microphone and system permissions.
- Models selects models by task; Providers manages provider access; On-device manages downloaded local models. Downloading a model does not change the selected task route.
- Dictionary contains Dictionary and Snippets tabs. Calendar manages connections.
- Privacy & Data controls audio retention and removal of all audio. It is not a general erase-all-data screen. Retention defaults to seven days; lowering it and deleting all audio require confirmation.
- Advanced controls debug logging, log folder access and CLI installation. The install button is available when the CLI is not installed.
- A first untargeted opening selects General. A later opening can retain the selected section.

## What to check

- Task model selection remains stable after a local model download.
- Audio deletion and reduced retention request confirmation.

## BDD acceptance criteria

- Given a task has a selected route, when I download another local model, then the selected route stays unchanged.
- Given I lower audio retention, when I apply the change, then confirmation is required.

## Entry points

- [SettingsModal.tsx](../../../src/components/SettingsModal.tsx) — groups and selection.
- [SettingsPage.tsx](../../../src/components/SettingsPage.tsx) — section controls.
- [DeveloperSection.tsx](../../../src/components/DeveloperSection.tsx) — logs and CLI.
- [settingsStore.ts](../../../src/stores/settingsStore.ts) — preferences and defaults.
- [taskCatalog.ts](../../../src/components/settings/models/taskCatalog.ts) — task model catalog.
