# M1 implementation progress

Status: done

Implemented typed recording/run/result contracts, additive SQLite persistence, immutable mic/system PCM epoch storage, atomic result JSON publication, SQLite reopen/recovery, and durable audio/note deletion intents. Wired the new storage manager through `AudioStorageManager` and added focused storage and persistence tests.

Preserved constraints: configuration snapshots are stored before epochs and strip unknown fields/secrets; recovery counts complete frames without rewriting raw audio; recording capture state stays independent from processing state; audio deletion preserves run JSON/text; note deletion removes recording results while shared speaker profiles and existing Notes behavior remain intact. All managed paths are generated and checked in main.

Issues: test execution is pending the root-only verification gate; this worker did not run tests, builds, installs, or native rebuilds.

Verification:
- `pnpm run typecheck` — passed (main, renderer, settings selectors).
- `pnpm run lint` — passed with 12 pre-existing warnings; no warnings on M1 files.
- `git diff --check` and staged diff check — passed.
- Root to run: `node --import tsx --test --test-concurrency=1 test/helpers/meetingRecordingStorage.test.js test/helpers/meetingRecordingPersistence.test.js test/helpers/databaseLocalBehavior.test.js`.

Commits:
- `bd0d603b` — M1: add durable meeting recording storage.
