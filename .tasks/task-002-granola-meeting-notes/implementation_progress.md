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

The next root rerun left three findings. The speaker-name fixture now registers its raw provider artifact before the transcript. The reprocess scenario now expects no second automatic Summary when one already exists for the meeting, while verifying that the prior run and both saved artifacts remain available; automatic superseded-run pruning and its database deletion method were removed to preserve run history. The renderer harness now captures composed-button callbacks so the stale-Summary regeneration action can be exercised through the rendered notice.

Verification for this fix:

- `pnpm run typecheck:main` — passed.
- `pnpm run typecheck:tests` — passed.
- Scoped main/test ESLint — passed with 0 errors.
- `git diff --check` — passed.
- Tests/builds/install/native rebuilds remain root-only and were not run by this agent. Rerun the seven-file focused M2 suite and `pnpm test -- test/services/meetingResults.test.ts`.

Fix commit: `2ba71bd87` (`M2: preserve meeting run history`).

The latest focused rerun found that two independent manual Summary requests were observed in the opposite order from fixture creation. Database timestamps have second-level precision and the worker uses run ID as a tie-breaker; ordering across separate meetings is not a product contract. The test now checks both manual-note values without imposing cross-meeting request order.

Verification for this adjustment:

- `pnpm run typecheck:tests` — passed.
- Scoped ESLint for `test/helpers/meetingProcessing.test.ts` — passed.
- `git diff --check` — passed.
- Root must rerun the focused tests; tests/builds/install/native rebuilds were not run by this agent.

Fix commit: `6c7ec570c` (`M2: assert independent Summary input ordering`).

## M3 — Tasks, Recap, Follow-up and formatter

Status: done

Prioritized tasks now use strict JSON validation and a single repair in the selected provider conversation, then update only the Summary's existing Action Items section under current-run, source, manual-note, transcript-projection and speaker-revision checks. Recap uses the editable built-in Action and the same serialized, revision-checked Summary mutation. Follow-up is an ordinary user request and assistant reply in the existing Chat, with one-turn meeting-only context, no tools or send behavior; existing-profile seeding adds missing Actions without replacing custom prompts. The default cleanup formatter now preserves the spoken language mix, escapes transcript data once, decodes once, and appends dictionary terms as a JSON list.

Preserved raw tracks, prior artifacts, manual Notes, the selected provider and frozen M2 prompt/model snapshot. Recap and tasks share one Summary artifact; writes serialize and reject conflicting target-section edits. Follow-up preview remains in-memory, and its live path does not include attendee data, stale Summary text, older Chat turns, or tools.

Issues: a scoped test typecheck found an incorrect test import for the task instruction; the test now imports the constant from its defining module. No unresolved implementation issues.

Verification run by this agent:

- `pnpm run typecheck:main` — passed.
- `pnpm run typecheck:renderer` — passed after the final renderer changes.
- `pnpm run typecheck:tests` — passed.
- Scoped ESLint for renderer and test files — passed; existing Node `MODULE_TYPELESS_PACKAGE_JSON` config warning only.
- Scoped ESLint for main helpers/contracts with `--no-ignore` — passed; same config warning only.
- `git diff --check` — passed before commit.
- Tests/builds/dependency installation/native rebuilds were not run; root owns them. Run the M3 plan suite plus the added stateful/action coverage: `pnpm test -- test/helpers/actionsCatalogBehavior.test.ts test/helpers/actionsIpc.test.ts test/stores/actionProcessingNoteOutput.test.ts test/components/meetingResultsPanel.test.ts test/helpers/retiredPrompts.test.ts test/cases/notes/integration/meetingSummarySections.test.ts test/cases/notes/integration/meetingActions.test.ts test/cases/ai/integration/meetingJsonRepair.test.ts test/helpers/meetingProcessing.test.ts test/helpers/chatMessageSubmissionLock.test.ts test/helpers/useChatStreamingCancellation.test.ts test/helpers/promptsCleanupFormatter.test.ts`. Then run `pnpm run typecheck:main` and `pnpm run typecheck:renderer`. The isolated-profile and controlled Russian model-quality checks were not run here.

Implementation commit: `2e0cdb78a` (`M3: add tasks, Recap, Follow-up and cleanup formatter`).

Root's focused M3 rerun exposed three stale fixture expectations and two task tests that never met the automatic Summary threshold. The Recap renderer fixture now supplies persisted `taskStatus: "zero"`, so it isolates the manual Recap action from the expected automatic task request. The task race fixtures now meet the documented 180-second/2,500-character automatic Summary threshold; short recordings correctly do not start tasks. Updated the Action icon assertion to the existing `wand-sparkles` default and the formatter assertion to the registry's actual `en` language-code fallback.

Verification for this fix:

- `pnpm run typecheck:tests` — passed.
- Scoped ESLint for the four changed test files — passed.
- `git diff --check` — passed.
- Tests/builds/install/native rebuilds remain root-only and were not run by this agent. Root should rerun: `pnpm test -- test/helpers/actionsCatalogBehavior.test.ts test/helpers/actionsIpc.test.ts test/stores/actionProcessingNoteOutput.test.ts test/components/meetingResultsPanel.test.ts test/helpers/retiredPrompts.test.ts test/cases/notes/integration/meetingSummarySections.test.ts test/cases/notes/integration/meetingActions.test.ts test/cases/ai/integration/meetingJsonRepair.test.ts test/helpers/meetingProcessing.test.ts test/helpers/chatMessageSubmissionLock.test.ts test/helpers/useChatStreamingCancellation.test.ts test/helpers/promptsCleanupFormatter.test.ts`.

M3 focused-rerun fix commit: `353598a08` (`M3: fix focused rerun fixtures`).

Root's failed-files rerun exposed a section-merge race: adding `## Recap` changed the Action Items snapshot only because `readMeetingSummarySection` included the blank-line separator before the next heading. Section snapshots now exclude trailing Markdown separators, allowing independent task and Recap writes to serialize. A mutation that was invalid in the original Summary still reports a format error; if a previously valid target becomes structurally invalid while generation is in flight, it now reports a conflict. Added coverage for Recap preserving the Action Items snapshot and for a concurrent heading change preserving the human edit and producing a conflict.

Verification for this fix:

- `pnpm run typecheck:main` — passed.
- `pnpm run typecheck:tests` — passed.
- Scoped ESLint for the changed main helpers and tests — passed (the root-level invocation ignores the main helpers, so source lint was run from `src` with `--no-ignore`).
- `git diff --check` — passed.
- Tests/builds/install/native rebuilds remain root-only and were not run by this agent. Root should rerun `pnpm test -- test/helpers/meetingProcessing.test.ts test/cases/notes/integration/meetingSummarySections.test.ts` and the failed-files M3 command as needed.

M3 concurrent section-merge fix commit: `e0487ce3c` (`M3: serialize independent Summary section edits`).
