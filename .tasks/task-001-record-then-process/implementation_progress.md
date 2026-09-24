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

## M2 root-test follow-up 5

Root's 50/50 run still logged Stop errors because pending-start cleanup hooks ran after the fake window had been restored; prior tests discarded the stop result. The SystemAudioInterrupted tests now register awaited cleanup before browser globals, explicitly assert successful Stop results, and assert the canceled-start Stop is a no-op. No production error handling was changed.

Verification:
- `pnpm run typecheck` — passed.
- `pnpm run lint` — passed with 0 errors and 36 warnings.
- `git diff --check` — passed.
- Tests were not run by this worker. Root rerun: `node --import tsx --test --test-concurrency=1 test/helpers/meetingCoordinatorIpc.test.js test/helpers/meetingAudioTimeline.test.js test/helpers/meetingCaptureRecovery.test.js test/stores/meetingRecordingStoreAutoEndStop.test.js test/stores/meetingRecordingStoreSystemAudioInterrupted.test.js test/helpers/windowManagerMeetingNotification.test.js`.

Follow-up commit:
- `0f6331de` — M2: assert Stop outcomes and order async test cleanup.

## M3 implementation progress

Status: done

Implemented a persisted main-process worker that resumes and claims SQLite runs after recovery and retention readiness, processes only saved configuration snapshots, prioritizes capture, retains provider responses before parsing, and persists transcript and summary artifacts as separate stages. Added the full-timeline mono WAV mixer, run list/create/retry IPC, existing Local transcription and post-Stop diarization, and summary generation through the existing provider factories and prompts.

Preserved constraints: mic/system epochs and provider responses remain separate and immutable; M3 derives one processing WAV without changing raw tracks; no request is issued while capture is active; issued remote ASR can finish and save raw JSON while normalization/summary wait; no new Self-Hosted meeting route or fallback/splitting was added; manual Notes remain unchanged and run results do not expose raw provider JSON.

Issues: the first Local transcript projection duplicated existing speaker-text merge behavior and omitted speaker labels in its text. Reused the existing `speakerMerge` helpers and added Local-path coverage. Live mic/system tail-loss remains the explicitly deferred M2 hardware check for the final verification pass.

Verification:
- `pnpm run typecheck` — passed (main, renderer, settings selectors).
- `pnpm run lint` — passed with 0 errors; 36 warnings remain in pre-existing or unrelated files, including M2's unused realtime-helper warnings after the capture cutover.
- `git diff --check` and staged diff check — passed.
- Tests were not run by this worker, per the root-only execution constraint. Root command: `node --import tsx --test --test-concurrency=1 test/helpers/meetingProcessing.test.js test/helpers/remoteTranscriptionIpc.test.js test/helpers/geminiFileTranscription.test.js test/helpers/retryTranscriptionHandler.test.js test/helpers/transcriptionRoute.test.js test/services/fileTranscriptionDiarizationWarning.test.js`.
- The mixer suite includes a real FFmpeg sample/offset/gap/duration check and skips only when FFmpeg is unavailable. Real provider calls and hardware smoke were not run by this worker.

Commit:
- `e192dd51` — M3: add durable post-stop meeting processing.

## M3 root-test follow-up

Root's focused suite passed 89/90; the FFmpeg mixer case exposed that the disk-space probe used the not-yet-created final WAV path. The mixer now checks available space on the existing containing directory, while retaining the same byte estimate and temporary-file-to-final rename. The injected test verifies the probe receives an existing directory.

Verification:
- `pnpm run typecheck` — passed (main, renderer, settings selectors).
- `pnpm run lint` — passed with 0 errors and 36 warnings.
- `git diff --check` — passed.
- Tests were not run by this worker. Root rerun: `node --import tsx --test --test-concurrency=1 test/helpers/meetingProcessing.test.js test/helpers/remoteTranscriptionIpc.test.js test/helpers/geminiFileTranscription.test.js test/helpers/retryTranscriptionHandler.test.js test/helpers/transcriptionRoute.test.js test/services/fileTranscriptionDiarizationWarning.test.js`.

## M4 implementation progress

Status: done

Added the Notes result/version panel, selected-run transcript/summary projection notifications, run-scoped speaker correction and existing-profile recognition, mixed playback/seek, and mixed/source WAV export. Added retention controls (7-day default, saved values preserved, 0 means indefinite), confirmed delete-all/note-delete safe Stop, durable retention cleanup ordering/retry, and focused retention/result regressions. Reconciled README/product/architecture/delivery/cutover/removal docs to the implemented contracts and retained chunking research as superseded history.

Preserved constraints: Note content and empty Notes remain intact; no new dashboard or Self-Hosted meeting route; selected results and corrections remain per run; raw provider results and mic/system PCM remain separate/immutable; expiry uses recording end time; audio deletion retains text/history and shared speaker profiles; Note deletion waits for active processing and prevents late publication. The main checkout's dirty README/docs were read only and were not modified. Live mic/system hardware smoke remains explicitly unverified.

Issues: final root-owned focused/full tests, build/packaged smoke, and hardware validation are pending. Typecheck initially caught the async delete-all dependency shape and duplicate Stop option fields; both were corrected. Tests/builds/installs/native rebuilds were not run by this worker.

Verification:
- `pnpm run typecheck` — passed (main, renderer, settings selectors).
- `pnpm run lint` — passed with 0 errors and 34 warnings, all in existing/unrelated files.
- `git diff --check` and English/Russian locale JSON parse — passed.
- Root focused suite: `node --import tsx --test --test-concurrency=1 test/helpers/meetingRecordingRetention.test.js test/services/meetingResults.test.js test/services/uploadNotes.test.js test/helpers/retentionSettings.test.js` — not run by this worker.
- Root integration sequence: `pnpm run typecheck`, `pnpm run lint`, `pnpm test`, `pnpm run pack`, `node scripts/smoke-electron.js` — pending. Live isolated macOS mic/system smoke and M2 tail-loss/recovery evidence remain pending.

Commits:
- `15717b7a` — M4: add Notes and retention surfaces.
- M4 verification log — pending.

## M4 root-test follow-up

Root's focused retention run found fixture defects. The retention recording helper discarded the initial run returned by finalization, and the Electron test stub lacked `BrowserWindow.getAllWindows()`, causing real deletion broadcasts to fail after files and SQLite state were already settled. The fixture now returns and asserts the persisted run/intent inputs, and the Electron stub models a process with no open windows. Managed-directory checks and the intentional unsafe-path failure case remain unchanged.

Verification:
- `pnpm run typecheck` — passed (main, renderer, settings selectors).
- `pnpm run lint` — passed with 0 errors and 36 warnings, all outside the changed files.
- `git diff --check` — passed.
- Tests were not run by this worker. Root rerun: `node --import tsx --test --test-concurrency=1 test/helpers/meetingRecordingRetention.test.js test/services/meetingResults.test.js test/services/uploadNotes.test.js test/helpers/retentionSettings.test.js`.

Commits:
- `cbc2c026` — M4: fix retention test fixtures.
- `0798ff68` — M4: record retention fixture verification.

## M4 root-test follow-up 2

Root's next retention run passed 29/32. The remaining three failures tried to attach a transcript directly to a run, but M3 persists the immutable provider response before transcript normalization. The retention fixtures now follow that persisted artifact order and verify provider-response JSON survives audio-only deletion alongside transcript text.

Verification:
- `pnpm run typecheck` — passed (main, renderer, settings selectors).
- `pnpm run lint` — passed with 0 errors and 36 warnings; no warnings on changed files.
- `git diff --check` — passed.
- Tests were not run by this worker. Root rerun: `node --import tsx --test --test-concurrency=1 test/helpers/meetingRecordingRetention.test.js test/services/meetingResults.test.js test/services/uploadNotes.test.js test/helpers/retentionSettings.test.js`.

Commit:
- `bb69d9c7` — M4: satisfy persisted transcript prerequisites.
