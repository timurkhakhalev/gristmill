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
- `52714ef9` — M1: record implementation verification status.

## M1 verification follow-up

Root's focused run found two issues. The audio deletion test incorrectly expected ASR reprocessing after audio removal; it now verifies that ASR retry is blocked while transcript-backed summary work remains available. The recovery test supplied an odd-length PCM buffer to the append API; it now writes whole frames. Recovery also now always marks an open recording found at startup as incomplete, even when all recovered bytes are complete frames.

Follow-up verification:
- `pnpm run typecheck` — passed.
- `pnpm run lint` — passed with 12 pre-existing warnings; no warnings on M1 files.
- Tests remain root-only and were not rerun by this worker.

Follow-up commits:
- `0e0f08fd` — M1: correct recovery and deleted-audio expectations.

## M2 implementation progress

Status: done

Implemented local capture with a pre-capture settings snapshot, main-owned immutable mic/system raw writes, bounded per-source renderer queues, ack-after-write, epoch offsets, and explicit flush/drain before finalization. Removed live meeting transcript publication from the capture flow, added Notes/tray capture states, and added safe quit confirmation that leaves capture and hotkeys active when canceled.

Preserved constraints: recording is independent of network/provider availability; raw mic and system audio remain separate and are written before any processing; source restarts retain gaps; missing or failed sources finalize incomplete; native system Stop waits for tap close; note text and existing transcript remain untouched.

Issues: native tap output is main-owned and does not have a renderer sequence number. Finalization now relies on its awaited process close for that source, while still checking renderer sequence numbers; a regression case also covers stdout chunks larger than 100 ms. The code commit is complete; tests and macOS hardware smoke remain root-only verification gates.

Verification:
- `pnpm run typecheck` — passed (main, renderer, settings selectors).
- `pnpm run lint` — passed with 0 errors; 36 warnings remain, including unreachable legacy meeting helpers exposed by the capture cutover and unrelated existing warnings.
- `git diff --check` and staged diff check — passed.
- Tests were not run by this worker, per the root-only execution constraint.
- Root focused command, including added quit-flow coverage: `node --import tsx --test --test-concurrency=1 test/helpers/meetingCoordinatorIpc.test.js test/helpers/meetingAudioTimeline.test.js test/helpers/meetingCaptureRecovery.test.js test/stores/meetingRecordingStoreAutoEndStop.test.js test/stores/meetingRecordingStoreSystemAudioInterrupted.test.js test/helpers/windowManagerMeetingNotification.test.js`.
- Root hardware smoke: use an isolated macOS arm64 user-data profile; record known continuous signals to mic and system audio offline; verify hide/reopen, Stop mid-speech, quit/cancel, device restart, and process kills at several points; compare recovered tails and durations against the reference and record bytes/durations/loss. Normal Stop must have no tail loss and each crash-recovered track must lose at most 1 second.

Commits:
- `9028b992` — M2: implement record-first capture and safe Stop.

## M2 root-test follow-up

Root's focused run reported 20 failures: four IPC assertion issues and sixteen Vite import failures. IPC tests now follow the generated recording ID and wrap synchronous handler throws in a promise assertion. The Vite failure came from `secretKeys.ts` exporting its already-named ESM data with an unconditional CommonJS `module.exports`; that redundant export is removed, keeping the settings snapshot in the renderer where current user settings live while main validates and persists it before capture.

Verification:
- `pnpm run typecheck` — passed.
- `pnpm run lint` — passed with 0 errors; 36 warnings.
- `git diff --check` — passed.
- Root tests were not run by this worker. Rerun: `node --import tsx --test --test-concurrency=1 test/helpers/meetingCoordinatorIpc.test.js test/helpers/meetingAudioTimeline.test.js test/helpers/meetingCaptureRecovery.test.js test/stores/meetingRecordingStoreAutoEndStop.test.js test/stores/meetingRecordingStoreSystemAudioInterrupted.test.js test/helpers/windowManagerMeetingNotification.test.js`.

Follow-up commit:
- `58ef1f5c` — M2: fix capture boundary and IPC assertions.

## M2 root-test follow-up 2

Root's rerun passed all IPC cases but the 16 renderer store cases failed while importing `meetingAudioTimeline.ts`, whose CommonJS footer is still required by the main-build test. The renderer now imports frame-offset math from a small ESM-only utility; the timeline helper re-exports it and retains its existing CommonJS shape for main.

Verification:
- `pnpm run typecheck` — passed.
- `pnpm run lint` — passed with 0 errors and 36 warnings.
- `git diff --check` — passed.
- Renderer-imported meeting helpers/config were checked for CommonJS footers; none remain on the renderer path. The timeline's footer remains for main-build consumers.
- Tests were not run by this worker. Root rerun: `node --import tsx --test --test-concurrency=1 test/helpers/meetingCoordinatorIpc.test.js test/helpers/meetingAudioTimeline.test.js test/helpers/meetingCaptureRecovery.test.js test/stores/meetingRecordingStoreAutoEndStop.test.js test/stores/meetingRecordingStoreSystemAudioInterrupted.test.js test/helpers/windowManagerMeetingNotification.test.js`.

Follow-up commit:
- `30ce4434` — M2: keep meeting timeline renderer import ESM-safe.

## M2 root-test follow-up 3

Root's next focused run passed 41/50; the remaining nine store failures came from outdated mocks, not capture behavior. The shared fake AudioContext now reports the requested sample rate, and successful mocked starts in the mic-only fallback and retry cases now include the durable recording ID and origin required by the IPC contract. Production 24 kHz validation and raw capture are unchanged.

Verification:
- `pnpm run typecheck` — passed.
- `pnpm run lint` — passed with 0 errors and 36 warnings.
- `git diff --check` — passed.
- Tests were not run by this worker. Root rerun: `node --import tsx --test --test-concurrency=1 test/helpers/meetingCoordinatorIpc.test.js test/helpers/meetingAudioTimeline.test.js test/helpers/meetingCaptureRecovery.test.js test/stores/meetingRecordingStoreAutoEndStop.test.js test/stores/meetingRecordingStoreSystemAudioInterrupted.test.js test/helpers/windowManagerMeetingNotification.test.js`.

Follow-up commit:
- `b7901205` — M2: align capture store mocks with durable start contract.

## M2 root-test follow-up 4

Root's rerun passed 49/51. The last two failures were caused by test windows that supplied `setTimeout` but not `clearTimeout`, so the production flush-barrier cleanup threw while settling. The shared browser harness now supplies both real Node timer methods; affected tests use those shared methods, and the store cleanup hook explicitly awaits Stop.

Verification:
- `pnpm run typecheck` — passed.
- `pnpm run lint` — passed with 0 errors and 36 warnings.
- `git diff --check` — passed.
- Tests were not run by this worker. Root rerun: `node --import tsx --test --test-concurrency=1 test/helpers/meetingCoordinatorIpc.test.js test/helpers/meetingAudioTimeline.test.js test/helpers/meetingCaptureRecovery.test.js test/stores/meetingRecordingStoreAutoEndStop.test.js test/stores/meetingRecordingStoreSystemAudioInterrupted.test.js test/helpers/windowManagerMeetingNotification.test.js`.

Follow-up commit:
- `beda40d5` — M2: provide shared browser timer cleanup in store tests.
