# User journeys

These documents describe how a user goes through the current product.
Each document contains:

- A goal, as a user story.
- **Entry points** — the application and the place where the journey starts, for example `Gristmill app → Settings → Advanced` or `Terminal → gristmill`.
- **Paths** — each real path through the feature, step by step, with the visible labels and results.
- **BDD acceptance criteria** — user-visible results.
- **Related documents** — the architecture documents with the technical limits and the source code locations.

Do not put technical limits, internal contracts or source file links in a journey. Put them in the related [architecture](../../architecture/index.md) document.
The BDD criteria are review scenarios, not evidence that a runtime test passed.

## Journeys

Start and navigation:

- [onboarding.md](onboarding.md) — first launch and permissions.
- [home.md](home.md) — Home, upcoming events, recent notes and the tray.
- [settings.md](settings.md) — Settings groups and controls.

Recording and results:

- [recording.md](recording.md) — record a call, warnings, pause, stop and recovery.
- [companion.md](companion.md) — link a Google Meet or Telemost call in Chrome.
- [upload.md](upload.md) — import audio files and links.
- [meeting-results.md](meeting-results.md) — audio, transcript, Summary, cancel and retry.
- [speakers.md](speakers.md) — speaker names and the stale Summary notice.

Notes:

- [notes.md](notes.md) — write notes, use folders and search.
- [note-files.md](note-files.md) — the Markdown copy of notes on disk.

AI:

- [chat.md](chat.md) — Home and Note chat, bb agent.
- [actions.md](actions.md) — built-in and custom AI Actions, Recap.
- [providers.md](providers.md) — models for each task.
- [dictionary-snippets.md](dictionary-snippets.md) — vocabulary and reusable text.

Integrations:

- [calendars.md](calendars.md) — calendar connections and reminders.
- [gristmill-cli.md](gristmill-cli.md) — read notes from the terminal.

## Reading and verification

- Read the [product overview](../overview.md) for principles, guarantees and what is not in the product.
- Use the code locations in the related architecture documents to confirm behavior before you change it.
- For GUI or hardware checks, follow [quality steering](../../steerings/quality.md) and use an isolated profile.
- Partial or inaccessible surfaces are marked explicitly; backend operations do not imply a complete UI journey.
