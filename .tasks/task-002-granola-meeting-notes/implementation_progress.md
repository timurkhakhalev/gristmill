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

Final teardown-fix commit hash is recorded in the follow-up progress update.
