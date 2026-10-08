# Architecture

These documents describe the current implementation.
If a document and the code are different, examine the code and correct the document.
The decisions and their reasons are in the [ADRs](../adr/index.md).

- [overview.md](overview.md) — C4 levels 1 and 2: external systems, containers, code locations.
- [recording-processing.md](recording-processing.md) — recording schema, managed paths, clock alignment, run ownership, Summary, tasks, Recap, retention, deletion.
- [post-stop-processing.md](post-stop-processing.md) — pipeline rules: gate, provider routes, speaker naming, BB context, device recovery, provider limits.
- [audio-storage.md](audio-storage.md) — Ogg/Opus capture, derived WAV files, legacy PCM profiles.
- [speaker-evidence.md](speaker-evidence.md) — shared platform matcher (Zoom, Google Meet, Telemost), name priority.
- [companion.md](companion.md) — Chrome extension: channels and builds, trust model, protocol, recording lifecycle, Google Meet adapter.
- [companion-telemost.md](companion-telemost.md) — Telemost adapter: DOM markers, Leave, limits.
- [bb-integration.md](bb-integration.md) — bb route: harness selection, runtime contract, thread binding, JSON repair, CLI update.
- [note-output.md](note-output.md) — persisted Note/run scopes, provenance, freshness and consumer semantics.
- [note-writes.md](note-writes.md) — editable Note write effects, participant edits and separate calendar, processing and deletion policies.
- [app-shell.md](app-shell.md) — onboarding gate, tray startup, Home data and Settings selection.
- [chat.md](chat.md) — chat context, history, tools and save rules.
- [calendars.md](calendars.md) — calendar providers, sync lifecycle and reminders.
- [import.md](import.md) — Upload file types, URL rules and queue.
- [processing-routes.md](processing-routes.md) — task catalogs, provider routes and size limits.
- [note-files.md](note-files.md) — Markdown mirror ownership, layout and errors.
- [vocabulary.md](vocabulary.md) — Dictionary and Snippets format, limits and tools.
- [renderer-boundary.md](renderer-boundary.md) — renderer import restrictions, permitted shared helpers and selected runtime graph checks.

Read in this sequence: overview → recording-processing → post-stop-processing → the document for your task.

- [tinfoil-catalog.md](tinfoil-catalog.md) — explicit catalog effects, cache and request snapshots.
