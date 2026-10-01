# Implementation progress

## M1 — Audio clock and mic lifecycle

Status: in progress; the first root verification failed and focused M1 corrections are committed below; root rerun is pending.

Implemented bounded renderer/native monotonic clock calibration and actual frame anchors, serialized boundary-acknowledged manual/platform mic gating, persisted intentional-mute intervals, and route-specific handling of proven empty mic audio. Updated current capture/processing documentation and added clock, worklet, IPC/store, persistence, provider-route, and native-helper coverage.

Preserved raw Ogg/Opus epochs, PCM-in-memory capture, existing supported routes, Zoom/system capture behavior, history/artifacts and historical UTC duration semantics. Gated samples are discarded before transfer, encoding, analysis, and storage; the healthy mic graph stays open through mute, while Pause/Stop release devices. The two pre-existing user-authored `activeMicRecovery.test.ts` scheduled-reacquisition regressions were retained unchanged; the intentional-gate-mute regression is additional M1 coverage.

Verification run:

- `pnpm run typecheck:main` — passed.
- `pnpm run typecheck:renderer` — passed.
- `pnpm run typecheck:tests` — passed.
- Scoped root and renderer ESLint on changed TypeScript files — passed. Main-helper ESLint reported 24 existing unused-symbol warnings in `meetingCoordinatorIpcHandlers.ts`; no errors.
- `git diff --check` — passed.

Not run here because the orchestrator owns tests and native builds: the M1 test selection from §5.1.4, `pnpm run typecheck` as a whole, `pnpm run compile:audio-tap`, and live microphone/system-audio hardware verification. Required root test command:

```sh
pnpm test -- test/helpers/activeMicRecovery.test.ts test/helpers/meetingAudioTimeline.test.ts test/helpers/meetingCaptureRecovery.test.ts test/helpers/meetingAudioParts.test.ts test/helpers/meetingProcessing.test.ts test/helpers/meetingRecordingSession.test.ts test/helpers/meetingAudioActivityMonitor.test.ts test/helpers/meetingAutoEndController.test.ts test/cases/recording/unit/meetingPcmProcessor.test.ts test/cases/recording/integration/meetingMicrophoneSelection.test.ts test/stores/meetingRecordingStoreAutoEndStop.test.ts test/cases/recording/unit/meetingClockSync.test.ts test/cases/recording/integration/meetingMicGate.test.ts test/cases/recording/integration/meetingIntentionalIntervals.test.ts test/cases/recording/native/audioTapClockProbe.test.ts
```

Also run `pnpm run typecheck` and `pnpm run compile:audio-tap` at the root. Native probe tests require the live macOS helper; hardware timing/accuracy still needs the planned M6 scenario.

Issues encountered: TypeScript and ESLint findings in the new test fixtures were corrected. No unresolved implementation blockers.

Commits: `700e64c22` — M1 implementation. The implementation entry is in this follow-up progress-log commit; both hashes are recorded in the completion report.

## M1 root verification follow-up

The root's first selected run failed: 77 ordinary tests had 63 pass and 14 fail; the native helper test failed 1/1 (16.272 s total). The command was:

```sh
pnpm test -- test/cases/recording/integration/meetingMicGate.test.ts test/cases/recording/integration/meetingMicrophoneSelection.test.ts test/cases/recording/unit/meetingClockSync.test.ts test/cases/recording/unit/meetingPcmProcessor.test.ts test/helpers/meetingAudioParts.test.ts test/helpers/meetingProcessing.test.ts test/cases/recording/native/audioTapClockProbe.test.ts
```

Root had separately passed `pnpm run typecheck` and `pnpm run compile:audio-tap` on arm64 before this follow-up. The failures were traced to queued Stop invalidating an already accepted intent, rejected stale intent/sample validation being recorded as permanent capture failure, a recovery/Stop race releasing one replacement track twice, and incomplete mock/fixture setup for the new gate, clock, source metadata and intentional-empty processing contracts.

The follow-up keeps accepted boundary commits ahead of Stop, rejects stale controls asynchronously without treating validation rejection as a capture failure, rejects stale mic samples before the write-failure handler, and makes recovery cleanup skip an already-ended track. Clock queries now require an explicit freshness timestamp, map only within measured probe bounds, and include fitted-rate residual in the uncertainty bound. Store/worklet, provider-stage, native-runtime and audio-parts fixtures now reflect their actual contracts; two source epochs from one recording remain in the combined timeline.

Follow-up verification by this implementer:

- `pnpm run typecheck:main` — passed.
- `pnpm run typecheck:renderer` — passed.
- `pnpm run typecheck:tests` — passed.
- Scoped ESLint for changed main/test TypeScript files and `src/stores/meetingRecordingStore.ts` — passed; renderer ESLint emitted only Node's existing module-typeless warning.
- `git diff --check` — passed.
- No tests, builds, installs or native commands were run by this implementer.

Root must rerun the complete M1 selection from §5.1.4:

```sh
pnpm test -- test/helpers/activeMicRecovery.test.ts test/helpers/meetingAudioTimeline.test.ts test/helpers/meetingCaptureRecovery.test.ts test/helpers/meetingAudioParts.test.ts test/helpers/meetingProcessing.test.ts test/helpers/meetingRecordingSession.test.ts test/helpers/meetingAudioActivityMonitor.test.ts test/helpers/meetingAutoEndController.test.ts test/cases/recording/unit/meetingPcmProcessor.test.ts test/cases/recording/integration/meetingMicrophoneSelection.test.ts test/stores/meetingRecordingStoreAutoEndStop.test.ts test/cases/recording/unit/meetingClockSync.test.ts test/cases/recording/integration/meetingMicGate.test.ts test/cases/recording/integration/meetingIntentionalIntervals.test.ts test/cases/recording/native/audioTapClockProbe.test.ts
pnpm run typecheck
pnpm run compile:audio-tap
```

The native probe test uses the actual macOS product version from `/usr/bin/sw_vers` when Electron Node mode lacks `process.getSystemVersion`; no product-version fallback or shim was added. Hardware timing and permission behavior remain unverified until the planned live M6 check. The two pre-existing recovery test hunks remain unchanged.

Follow-up code commit: `b07e44776` (`M1: fix clock and mic verification regressions`).

## M1 root verification follow-up — unresolved

The root's next selected rerun still failed. Its result in
`/tmp/gristmill-task004-m1-rerun.log` was 78 ordinary tests: 74 passed and 4
failed, plus the native test failed 1/1; total 9.853 s. The exact root command
was:

```sh
pnpm test -- test/cases/recording/integration/meetingMicGate.test.ts test/cases/recording/integration/meetingMicrophoneSelection.test.ts test/cases/recording/unit/meetingClockSync.test.ts test/cases/recording/unit/meetingPcmProcessor.test.ts test/helpers/meetingAudioParts.test.ts test/helpers/meetingProcessing.test.ts test/cases/recording/native/audioTapClockProbe.test.ts
```

This supersedes the earlier follow-up's claim that all fixture/runtime failures
were corrected. The root evidence was: replacement mic track stopped twice;
the worklet assertion read the mute acknowledgement instead of the second chunk;
Local intentional-empty processing was `failed` (this patch adds stage and error
code to the assertion for the next root run); the combined-parts fixture expected
a mic epoch that its second recording did not persist; and the native probe
timed out. Root separately reported `pnpm run typecheck` and
`pnpm run compile:audio-tap` passed on arm64. This implementer did not run tests,
builds, installs, or native commands.

This follow-up changes only the clear issues from that evidence: Stop cleanup now
uses the existing ended-track-aware `stopMediaStream`; the worklet test selects
PCM chunk messages before checking their frame fields; the grouped-parts fixture
expects only the second recording's actual system epoch and checks its persisted
manual-muted mic interval; Local's failed assertion exposes its stage/error
code; and the Swift probe reader consumes stdin incrementally with a bounded line
buffer and handles EOF/EINTR. The native test now launches the compiled helper
directly, avoiding Electron Node mode's unavailable `process.getSystemVersion`
without adding a product shim. Root verification is still required for each.

One contract issue remains and blocks M1 completion. In
`src/helpers/meetingClockSync.ts`, `mappingAt` rejects a requested source time
later than the last probe's `sourceEndNs` (lines 84–93). In
`src/stores/meetingRecordingStore.ts`, `frameAtRenderFrame` turns that null
mapping into an error (around lines 1442–1462); `createAudioPipeline.onFailure`
then marks `audio-clock-unavailable` and calls `stopRecording` (around lines
1470–1484). A normal renderer chunk after the latest calibration probe can
therefore stop capture. M1 explicitly says probe failures must not block PCM and
§5.1.6 says stale/uncalibrated clock evidence leaves audio running. Falling back
to renderer-local offsets would keep raw PCM but would invent alignment with the
native system track, so I removed that tentative change and left behavior
unchanged pending a clock-domain decision.

The unresolved decision is how to preserve continuous PCM while keeping cross-
track offsets truthful: (1) retain mic epochs in their renderer-frame domain,
mark cross-track alignment unknown until a fresh shared anchor exists, and define
how processing handles those intervals beside native-timed system audio; or (2)
hold mic PCM in a bounded in-memory queue until actual probes bracket the
renderer frames, and specify the queue-exhaustion outcome. No option is
implemented here. The clock solver remains strict about actual probe bounds.

Status remains in progress. The root should rerun the §5.1.4 M1 selection and
record the Local failure's new stage/error code. The direct verification command
from the latest root run is above; the broader §5.1.4 selection, typecheck,
native compile, and hardware checks remain outstanding after this correction.

Scoped checks run by this implementer after the correction:

- `pnpm run typecheck:tests` — passed.
- `pnpm run typecheck:renderer` — passed.
- `pnpm exec eslint --config eslint.config.js test/cases/recording/native/audioTapClockProbe.test.ts test/cases/recording/unit/meetingPcmProcessor.test.ts test/helpers/meetingProcessing.test.ts` — passed.
- From `src/`, `../node_modules/.bin/eslint stores/meetingRecordingStore.ts` — passed (Node emitted the repository's existing typeless-module warning).
- `git diff --check` — passed.

No tests, builds, installs, native commands, or hardware checks were run by this
implementer. The Local route's stage/error code and all four ordinary failures
remain for root verification after these focused corrections.

Correction code commit: `28bb54247` (`M1: fix probe reader and capture fixtures`).
