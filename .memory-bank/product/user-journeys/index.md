# User journeys

These documents describe the current product from the user perspective.
Each document contains a goal, steps, behavior limits, checks, BDD criteria and source entry points.
The checks are review scenarios, not evidence that a runtime test passed.

## Journeys

- [onboarding.md](onboarding.md) — first launch and permissions.
- [home.md](home.md) — navigation, events and recent notes.
- [chat.md](chat.md) — Home and Note AI contexts.
- [settings.md](settings.md) — settings groups and controls.
- [upload.md](upload.md) — file/URL import and queue.
- [meeting-results.md](meeting-results.md) — audio, transcript, Summary and retry.
- [speakers.md](speakers.md) — corrections and stale Summary.
- [dictionary-snippets.md](dictionary-snippets.md) — vocabulary and reusable text.
- [calendars.md](calendars.md) — connections and reminders.
- [note-files.md](note-files.md) — Markdown mirror activation and local files.
- [local-api.md](local-api.md) — CLI and internal write bridge.
- [providers.md](providers.md) — task-specific processing routes.

## Reading and verification

- Read [requirements](../requirements.md) for product principles and required recovery behavior.
- Read [scope](../scope.md) for exclusions and future candidates.
- Use the source links to confirm behavior before changing it.
- For GUI or hardware checks, follow [quality steering](../../steerings/quality.md) and use an isolated profile.
- Partial or inaccessible surfaces are marked explicitly; backend operations do not imply a complete UI journey.
