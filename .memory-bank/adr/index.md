# Architecture Decision Records

An ADR records the reason for a decision. The code does not show this reason.
Each ADR gives the context, the decision and the consequences.
Read the related ADR before you "improve" a behavior that it describes.

To change a decision, write a new ADR with the status `Supersedes ADR-NNNN`.
Then set the status of the old ADR to `Superseded by ADR-NNNN`.
Use the [template](template.md). Name the file `NNNN-short-slug.md`.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-openwhispr-one-time-import.md) | OpenWhispr is a one-time code source. No upstream merges, no compatibility shims | Accepted, 2026-09-14 |
| [0002](0002-cleanup-scope.md) | Product boundary after the cleanup: what stays and what goes | Accepted, 2026-09-14 |
| [0003](0003-record-then-process.md) | Record only during the meeting. Do ASR and notes after Stop | Accepted, 2026-09-23 |
| [0004](0004-opus-capture.md) | Write the original tracks directly as Ogg/Opus at 32 kbit/s | Accepted, 2026-09-30 |
| [0005](0005-typescript-toolchain.md) | Native TypeScript 7 for typecheck and build. TypeScript 6 only for the Compiler API | Accepted |
| [0006](0006-remove-live-transcription.md) | Remove unused live transcription and speaker recognition. Enable diarization in new Local snapshots | Accepted, 2026-10-04 |
| [0007](0007-explicit-tinfoil-catalog.md) | Explicit Tinfoil catalog effects and request snapshots | Accepted, 2026-10-04 |
| [0008](0008-source-export-alignment.md) | Source-scoped export alignment with saved timeline duration | Accepted, 2026-10-04 |
| [0009](0009-note-output-scopes.md) | Separate persisted Note and run output scopes | Accepted, 2026-10-04 |
