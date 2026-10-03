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

Read in this sequence: overview → recording-processing → post-stop-processing → the document for your task.
