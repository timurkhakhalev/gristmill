# Implementation progress

## M1 — Audio clock and mic lifecycle

Historical M1 handoff follows. Root subsequently completed the clock correction and M2/M3; current implementation and verification entries are appended below.

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

Rerun the complete M1 selection from §5.1.4:

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

## M1 root correction rerun — two fixture assertions corrected

Root rebuilt the Swift helper successfully and reran the selected correction
set. `/tmp/gristmill-task004-m1-correction.log` records 78 ordinary tests with
76 passing and 2 failing, the genuine direct native probe passing 1/1 (1.270 s
native phase), and 7.610 s total. The command was:

```sh
pnpm test -- test/cases/recording/integration/meetingMicGate.test.ts test/cases/recording/integration/meetingMicrophoneSelection.test.ts test/cases/recording/unit/meetingClockSync.test.ts test/cases/recording/unit/meetingPcmProcessor.test.ts test/helpers/meetingAudioParts.test.ts test/helpers/meetingProcessing.test.ts test/cases/recording/native/audioTapClockProbe.test.ts
```

The worklet resets its chunk sequence when unmute starts a new encoded epoch
(`meetingRecordingStore.ts`, `_sequence = 0` in the `set-gate` handler). The
tail is sequence 1 in epoch 1, so the test now asserts the flush tail's epoch,
generation, sequence, sample offset, frame anchor and payload size, and expects
`flush-complete.lastSequence` to be 1. This keeps the tail assertions while
matching the per-epoch sequence contract. Local mono paths use the canonical
`${runId}.wav` name (no `-mono` suffix); the fixture now compares the transcriber
input to `getDerivedAudioPath(recording.id, run.id, "mono")` directly.

Only these two test files changed for the correction. Scoped `pnpm run
typecheck:tests` and ESLint on both changed tests passed; no tests, builds,
installs, or native commands were run by this implementer. Rerun the
selection above and the full §5.1.4 M1 verification. M1 stays in progress: the
capture-clock behavior and user clock-domain decision logged above remain
unresolved and no clock architecture was changed.

Correction code commit: `761c58238` (`M1: correct epoch and mono fixture assertions`).

## M1 expanded-consumer fixture corrections

Root ran the expanded 20-file M1 selection recorded in
`/tmp/gristmill-task004-m1-verification.log`: 201 ordinary tests, 197 passed and
4 failed; the genuine native probe passed 1/1; total 10.344 s. The two failures
in `audioTapManagerWarnings.test.ts` sent raw stdout bytes without the paired
typed `pcm` frame metadata now required by `AudioTapManager`; without metadata,
the manager correctly retains bytes until their frame ranges are known. The two
failures in `meetingCoordinatorIpc.test.ts` sent packets without required
`frameStart` and `sourceGeneration`; schema validation correctly rejected these
before storage, so the disk-full test never reached its failing writer.

The audio-tap fixtures now pair each two-byte mono PCM sample with a one-frame
metadata message, assert the resulting frame starts and byte order, and verify a
malformed clock warning does not prevent correctly framed PCM delivery or
produce an error. The IPC fixtures now provide valid generation-1 frame anchors;
the raw-write acknowledgement and disk-full rejection assertions remain intact.
No production code or clock behavior changed.

Root should first rerun the failed files:

```sh
pnpm test -- test/helpers/audioTapManagerWarnings.test.ts
pnpm test -- test/helpers/meetingCoordinatorIpc.test.ts
```

Then rerun the full M1 consumer selection:

```sh
pnpm test -- --verbose test/helpers/activeMicRecovery.test.ts test/helpers/meetingAudioTimeline.test.ts test/helpers/meetingCaptureRecovery.test.ts test/helpers/meetingAudioParts.test.ts test/helpers/meetingProcessing.test.ts test/helpers/meetingRecordingSession.test.ts test/helpers/meetingAudioActivityMonitor.test.ts test/helpers/meetingAutoEndController.test.ts test/cases/recording/unit/meetingPcmProcessor.test.ts test/cases/recording/integration/meetingMicrophoneSelection.test.ts test/stores/meetingRecordingStoreAutoEndStop.test.ts test/cases/recording/unit/meetingClockSync.test.ts test/cases/recording/integration/meetingMicGate.test.ts test/cases/recording/integration/meetingIntentionalIntervals.test.ts test/cases/recording/native/audioTapClockProbe.test.ts test/helpers/meetingCoordinatorIpc.test.ts test/helpers/meetingStreamingWiring.test.ts test/helpers/audioTapManagerWarnings.test.ts test/helpers/meetingCoordinatorBridge.test.ts test/cases/recording/integration/meetingOpus.test.ts
```

Scoped `pnpm run typecheck:tests`, ESLint on both changed files, and
`git diff --check` passed for this correction. This implementer did not run
tests, builds, installs, or native commands. M1 remains in progress and blocked
on the user clock-domain decision documented above; do not start M2.

Correction code commit: `5c75a8594` (`M1: update audio packet fixtures`).

## Root verification after consumer corrections

The final 20-file M1/direct-consumer command recorded above passed: 201 ordinary
tests plus 1 genuine native helper test, 0 failures, 0 skips. Total wall time
10.186 s (prepare 59 ms, main build 755 ms, ordinary 8.949 s, native 422 ms).
Failing-only reruns passed before this combined selection. The latest Swift
helper compiled successfully on arm64 with `pnpm run compile:audio-tap`.
Root reran `pnpm run typecheck` successfully (all four targets).
No full-suite/package/Meet/hardware acceptance is claimed.

M1 remains in progress and blocked pending the clock-domain decision described
above. Passing tests do not cover continuous native-backed mic capture between
strict clock probe bounds. M2-M6 and milestone/code review have not started.
The root requested the user decision before changing that contract.


## Clock contract resolution — 2026-10-01

The user asked the planning thread to inspect `task-004 act` and resolve the
contract independently. The planner traced `MeetingClockSync.mappingAt`,
`meetingRecordingStore.createCapturePipeline`/`createAudioPipeline` and
`meetingCaptureSession.appendSamples`. Two defects are identified: timestamps
past the last probe stop capture, and per-chunk recalibration can violate exact
sample continuity even when a clock mapping is available.

Decision: plan.md §5.1.7 is the binding M1 correction contract. Raw source-frame
continuity does not depend on cross-source calibration. Fresh bounded alignment
is allowed between probes; unknown alignment remains durable and does not stop
capture. Prepare refuses unresolved alignment through its existing error/retry
flow. The section includes the deterministic initial envelope, affected contracts,
regression cases and M6 measurement requirements. No additional user clock choice
is pending. The previous entries asking for that choice are superseded.

Plan Simplification and Planning Artifact Review passed the revised contract.
This is a documentation/decision correction only: application code was not fixed
or tested in this planning turn. The previously recorded 202-test pass does not
prove these new cases. Keep M1 in progress; implement §5.1.7 and pass its required
verification before proceeding to M2.

## 2026-10-01 — direct implementation of the clock correction

User superseded the PlanAct execution workflow: root writes code and runs checks
in this thread; no delegation or repeated draft/plan review gates.

Implemented source-local packet continuity independently of persisted bounded
alignment. Renderer capture continues with unknown alignment. Main saves raw
Opus and alignment segments separately; prepare rejects uncovered/high-uncertainty
ranges with `audio-alignment-unavailable` before provider calls, including retry.
Late calibration can cover prior frames within the same continuous generation.
The solver enforces two probes/250 ms, a finite feasible rate/offset region,
five-second freshness/continuation, and no freshness renewal from rejected probes.

Mute intervals retain source-generation coordinates even without alignment.
Mute held for an entire capture has an explicit main-owned intentional-empty
proof; a partial recording cannot inherit another part's mute proof. Repeated
open-gate commands no longer reset packet sequence or drop a buffered tail.
Recovery preserves nullable alignment; old persisted timeline offsets survive
schema migration. Raw source audio and previous artifacts are not rewritten.

Verification (root, sequential canonical runner):
- `pnpm test --domain recording --kind unit --kind integration`: 117 files passed,
  26.6 s including main build. Earlier failures were repaired and rerun focused.
- `pnpm test --domain recording --kind types`: one stale positive dependency
  fixture failed; repaired and `pnpm test test/scripts/type-probes/meeting-coordinator.test.ts test/helpers/meetingProcessing.test.ts` passed.
- `pnpm run typecheck`: passed main, renderer, settings selectors and tests.
- `pnpm run lint`: passed with existing warnings, no errors.
- Added real SQLite/Opus reopen, late/absent alignment, historical migration,
  uncertainty bounds, provider refusal/retry and gate-tail regressions.
- After nullable recovery metadata cleanup, storage/persistence/alignment focused
  checks passed again. Full suite and hardware/packaged verification remain M6.

Next: common platform evidence/provenance (M2), then browser transport, binding,
controls and integrated verification. No claim of real Meet/hardware validation.

## 2026-10-01 — common platform evidence implemented directly (M2)

Replaced Zoom-specific observation/decision persistence and matcher APIs with a
single platform path. Zoom AX remains its adapter; Meet uses the same matcher
with a 0.3 s initial indicator delay, explicit active-set and bounded-clock guards.
Atomic migration preserves historical Zoom identities, decisions and correction
revisions; injected failure rolls back the table rename and payload changes.

Corrections, saved projections, Note transcript, Results badges/tooltips, CLI and
LLM material carry the concrete platform. User/voice precedence is unchanged;
manual rename removes platform provenance. Audio expiry preserves names and
observations; Note deletion cascades them. Profile backup/restore requirements
for develop downgrade are documented without adding a backup subsystem.

Verification: the 12-file M2 selection in plan §5.2.4 passed in 7.7 s, including
native collector lifecycle tests (fake helper, not live Zoom/Meet). New Meet
matching, migration rollback/reopen, retention, Note/CLI/LLM and Results tests
passed. Results were additionally checked in both raw and enhanced view after
manual rename. `pnpm run typecheck` and `pnpm run lint` passed; lint retains
existing warnings. Real browser/hardware quality is still unverified.

Next: M3 bounded Native Messaging transport and Dev-only extension/installer.

## 2026-10-01 — Dev browser transport (M3)

Implemented strict 64 KiB framing, a bundled native host, private per-profile
socket authentication and main-assigned connection identities. The MV3 worker
accepts only top-frame Meet documents, derives identities from Chrome metadata,
rejects stale connections and defers updates while recording. Dev installer
validates ownership before changing manifests and handles quoted/relocated paths.
Production identity remains out of scope.

Verification: five transport/worker/installer test files passed (2.6 s, including
main build); full typecheck and lint passed (existing warnings only).
`pnpm run build:companion` produced the Dev extension. Native-host tests execute
real subprocess/socket framing against temporary profiles; no user's Chrome
registration was changed. Application wiring and real Meet remain next.


## 2026-10-01 — Meet binding and recording UI integrated directly (M4/M5)

Root implemented the content adapter, scoped main binding, native clock probes,
continued speaker evidence, initial mic gate, explicit late selection, sticky
heuristic suppression, positive Leave/Restart, five-minute reminder and settings.
Added universal manual mute in Note and pill, Pause/Resume/Restart intent,
Dev setup/removal and all 11 desktop locales. The integration preference is owned
and persisted once in main, exposed through the typed bridge to its Settings
control; no independently persisted renderer flag is introduced.

Fixed additional consumer defects discovered during integration: lifecycle had
omitted the final microphone boundary; Zoom Accessibility failure discarded
native clock anchors; device unmute could cancel Meet mute. Native tail anchors
now drain before optional evidence shuts down. Restart cards require successful
ready capture, not an incomplete drain. Native snapshots preserve paused state.

Focused checks passed: scoped Stop/lifecycle, binding/reload/profile isolation,
clock evidence, auto-end arbitration, metadata persistence and locale coverage.
A real isolated Electron renderer passed sanitized RU/EN DOM fixtures, including
unknown UI, multi-active, Companion mode and positive Leave. Full typecheck and
lint passed, and the extension build passed. Initial recording-domain run exposed
two metadata error-code regressions; their focused retry passed after preserving
specific write/overflow/tail diagnostics.

Full-suite and package/runtime verification are running next. No live Meet or
hardware accuracy claim is made from synthetic DOM, clock or device tests.


## 2026-10-01 — Integrated checks and packaged smoke

Continued implementation directly in this thread, without PlanAct delegation.
Added scoped popup manual mute and context health, rejected page/profile/stale
commands, cleared binding after failed Start and caught auto-end claim failures.

Final `pnpm test`: all 425 files passed in 79.700 s. Full typecheck and lint passed
(three existing lint warnings). `pnpm run pack` passed and produced the unsigned
local arm64 app. Isolated packaged smoke passed manual mute, Pause/Resume, raw
system continuity, native-host handshake, synthetic binding/mute, confirmed
Leave/Restart and explicit late rebind. Captures finalized ready; processing
reached ASR and reported missing credentials accurately.

See `docs/google-meet-companion-verification.md` for evidence and limits. Actual
Chrome/Meet DOM, speaker indicator accuracy, hardware matrix and onset measurement
remain unverified. Do not treat automated/package checks as full issue acceptance.
