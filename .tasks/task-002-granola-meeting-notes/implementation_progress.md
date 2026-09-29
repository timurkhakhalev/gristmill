# Implementation progress

## M1 — Durable end-of-meeting gate

Status: done

Finalized runs now persist a 15-second ASR not-before time; grouped Stop requests are idempotent, and resumed capture invalidates pending work. The worker rechecks finalized audio, capture state, and the current group before preparation and ASR; the Notes surface shows durable countdown/progress and has no early Transcribe control.

Preserved the original mic/system tracks, previous artifacts, no capture-time provider work, and Pause's existing `suppressProcessing` cancellation path. Short usable recordings remain eligible for ASR.

Issues: the first test typecheck found a nullable deadline assertion; the test now asserts the persisted deadline before parsing it. No other implementation issues found.

Root's M1 focused run exposed two test assumptions, with no product-code regression: the renderer harness does not interpolate i18n placeholders, and the missing-key test expected provider validation before the persisted gate elapsed. The assertions now check the visible waiting notice/no-bypass behavior, and the config test advances its controlled clock to the persisted deadline before asserting the blocked provider state. Root should rerun the focused suite.

Verification:

- `pnpm run typecheck:main` — passed.
- `pnpm run typecheck:renderer` — passed.
- `pnpm run typecheck:tests` — passed after adding restart coverage.
- Scoped main/test ESLint — 0 errors; 27 existing unused-symbol warnings in `ipcHandlers.ts` and `meetingCoordinatorIpcHandlers.ts`.
- Scoped renderer ESLint — passed; Node emitted the existing `MODULE_TYPELESS_PACKAGE_JSON` config warning.
- `git diff --check` — passed.
- Required focused tests remain unrun by this agent; root integrator owns test execution. Run: `pnpm test -- test/helpers/meetingProcessing.test.ts test/stores/meetingRecordingStoreAutoEndStop.test.ts test/components/meetingResultsPanel.test.ts`.
- Isolated live-profile/hardware check was not run here.

Commits: `49d8e48c6` (M1 implementation). This progress-record update is a separate M1 log commit.

M1 regression-fix commit: `5ec61f8d5` (`M1: fix gate regression test assumptions`).

Root's rerun then exposed a renderer unmount failure because the test browser supplies `setTimeout`/`clearTimeout` but not `clearInterval`. The live and mock countdowns now use one-second timeouts that reschedule from state changes, so the same timer APIs drive countdown and cleanup. Renderer typecheck, scoped ESLint, and `git diff --check` pass; root should rerun the focused tests.

Timer-fix commit: `ef9649b92` (`M1: clean up countdown timers on unmount`).

The next root renderer rerun reached `NoteNotices.ElapsedClock`, which uses the standard `clearInterval` API while the renderer harness stubs `setInterval` without its matching cleanup method. The MeetingResultsPanel test now supplies a no-op `clearInterval` for that stub only; NoteNotices and its production timer behavior are unchanged.

Harness-fix commit: `16421a5bc` (`M1: stub interval cleanup in renderer test`).

Two hook-order-only teardown attempts (`901a1a3c7`, `a0226e46d`) did not fix the renderer failure. The test cleanup now captures the mounted browser/DOM and React globals, temporarily restores them around `root.unmount()`, then restores the values present before cleanup in `finally`; it no longer depends on hook order. No product code changed. `pnpm run typecheck:tests`, scoped ESLint, and `git diff --check` pass. Tests remain root-only and were not run here.

Final teardown-fix commit: `3c6b80954` (`M1: preserve renderer globals for unmount`).

## M2 — Speaker names and main Summary

Status: done

Added a durable per-run source snapshot for the selected transcript, corrected full segments, manual-note revision, speaker-correction revision, and frozen Detailed Notes prompt/model settings. Unknown speakers are named through the saved provider route with strict JSON validation and one same-conversation repair; voice matches stay preferred, persisted model provenance drives the live badge, and atomic revision checks keep late model output from replacing user corrections. Summary now uses the same corrected segment projection for automatic and manual runs, applies the inclusive 180-second and 2,500 spoken-character automatic thresholds, preserves a previous saved Summary while a manual replacement is in progress, and writes revision metadata with the selected Markdown artifact.

Preserved raw audio, manual note bodies, selected-route-only processing, no provider work during capture, no segment truncation, and saved prior Summary artifacts during manual regeneration. Calendar participants are naming candidates only; names are never derived from email. Summary input contains only the title hint, manual notes, and complete corrected segments. No new tabs, fallback route, voice-profile enrollment, Recap, priorities, or Follow-up behavior was added.

Issues: the old short fixtures correctly became ineligible for automatic Summary after the threshold change; summary-focused tests now use qualifying fixtures, while explicit manual Summary tests verify the bypass. Model naming and Summary failures remain independent so a naming error does not block Summary. The renderer can keep displaying the source run's saved Summary while a manual Summary run is pending or generating.

Verification run by this agent:

- `pnpm run typecheck:main` — passed.
- `pnpm run typecheck:renderer` — passed.
- `pnpm run typecheck:tests` — passed.
- Scoped main/test ESLint — 0 errors; 4 existing unused-symbol warnings in `ipcHandlers.ts` and `test/services/meetingResults.test.ts`.
- Scoped renderer ESLint — passed; Node emitted the existing `MODULE_TYPELESS_PACKAGE_JSON` config warning.
- `git diff --check` — passed.
- Tests/builds/install/native rebuilds were not run by this agent; root owns those checks. Run the plan's focused suite: `pnpm test -- test/helpers/meetingProcessing.test.ts test/helpers/speakerIpc.test.ts test/helpers/speakerAssignmentPolicy.test.ts test/helpers/speakerRetroactiveMapping.test.ts test/stores/actionProcessingNoteOutput.test.ts test/components/meetingResultsPanel.test.ts test/cases/ai/integration/meetingJsonRepair.test.ts`. Also run `pnpm test -- test/services/meetingResults.test.ts` for the voice-provenance assertion updated in that existing test.
- The isolated-profile Russian prompt-quality check was not run here; root should record the controlled transcript outputs and compare live UI to committed previews.

Implementation commit: `394f19c63` (`M2: add speaker names and meeting Summary`). This progress-record update is a separate M2 log commit.

Root's focused rerun exposed two integration regressions and fixture mismatches. Group-version invalidation now applies to automatic `initial` runs; explicit manual reprocess runs can summarize their selected audio parts even when those parts span session groups. Renderer fixtures now supply the persisted Detailed Notes action before snapshotting, and processing fixtures satisfy the transcript/raw-response dependency, Summary thresholds, and canonical speaker projection. The service fixture marks the M1 delay elapsed so it exercises downstream processing rather than gate timing.

Verification for this fix:

- `pnpm run typecheck:main` — passed.
- `pnpm run typecheck:renderer` — passed.
- `pnpm run typecheck:tests` — passed.
- Scoped main/test ESLint — 0 errors; one pre-existing unused `recording` warning in `test/services/meetingResults.test.ts`.
- Scoped renderer ESLint — passed; Node emitted the existing `MODULE_TYPELESS_PACKAGE_JSON` config warning.
- `git diff --check` — passed.
- Tests/builds/install/native rebuilds remain root-only and were not run by this agent. Rerun the focused command from the plan and `pnpm test -- test/services/meetingResults.test.ts`.

Fix commit: `1d2563337` (`M2: fix selected run and fixture regressions`).
