# Milestone audit — task 002, review 4

Status: blocked

Reviewed milestone commits: M1 `49d8e48c6`–`576c7202b`; M2 `394f19c63`–`2e1b17d85`; M3 `2e0cdb78a`–`8333a93a6`; M4 `9a14da5c5`–`16df60571`; M5 `51f587d23`–`bea026706`; M6 `9873d1650`–`34bbf64dd`; M7 `f4b8dfc46`, `1c5f72b44`. The earlier review reports were read as diagnostic context for the fix milestones. The current plan is self-contained; its task-local review links supply the permitted fix diagnostics.

## M1 — Durable end-of-meeting gate

M1 status: pass

The persisted 15-second final-Stop gate, Resume invalidation, current-group check and raw-track retention were not changed by M7. Previous focused and integrated tests passed; real mic/system timing remains within M4-1's unverified boundary.

## M2 — Speaker names and main Summary

M2 status: pass

M7 routes the main toolbar Summary callback to `MeetingResultsPanel.openRun("summary")`, the same route as the Results action. `createRun` sends a selected `sourceRunId`, selected transcript route and current Summary prompt/model config; the worker retains correction precedence, input exclusions and the saved Summary artifact/note projection. The former generic `PersonalNotesView` Action route, which sent calendar context and raw/live transcript, was removed. The code finding `review-3.md` M2-1 no longer reproduces. An active-capture consumer discrepancy in the Results menu is recorded under M7.

## M3 — Tasks, Recap, Follow-up and formatter

M3 status: pass

M7 did not change the selected-run tasks/Recap section mutation, strict JSON repair, existing Chat Follow-up or cleanup formatter. Toolbar generation now produces the selected-run artifact these consumers require; previous artifacts and manual notes remain on their established paths.

## M4 — Integrated journeys and documentation

M4 status: fail

Current documentation and automated integration checks remain in place. The isolated M7 app reached onboarding, but no real meeting or configured-provider interaction was observed.

### M4-1 — medium — Required isolated live journey remains unverified

- Files/surfaces: capture and recording state, Notes/Summary, Chat Follow-up, Recap, selected providers including BB; `implementation_progress.md` and the root's M7 verification record.
- Unproven requirement: M4 requires isolated macOS mic/system capture through Pause/Resume/End, the 15-second wait, short and qualifying Summaries, speaker correction, Follow-up and Recap, plus representative configured routes where available.
- Evidence: The root started an app with `--user-data-dir=/tmp/openhercules-task002-smoke-m7` and reached onboarding. Permission for a test recording is pending, so no live capture, Notes/provider journey or controlled model-quality output was performed. The root's focused/full tests, lint, typecheck and renderer build are automated evidence, not hardware/provider evidence.
- Mechanism and impact: Startup and synthetic checks cannot establish real dual-track capture, timing, provider/BB responses or the full UI transition. This repeats `review-1.md` M4-1, `review-2.md` M4-1 and `review-3.md` M4-1; the startup result is partial evidence only.

## M5 — Reviewer fixes from review-1

M5 status: pass

The six `review-1.md` code findings remain closed: manual ASR cannot bypass the current group's gate, naming and priority instructions carry the specified evidence policy, malformed participant data is visible, nonempty short transcripts explain auto ineligibility, and absent owner/deadline fields are omitted. M7 did not add a compatibility route or change those contracts.

## M6 — Reviewer fixes from review-2

M6 status: pass

The M6 fixes still preserve Summary despite optional participant corruption, suppress the empty Results notice and retain older completed-group ASR controls during a newer group's gate. M7 now also hides the toolbar and Results Summary actions when the selected saved transcript text is empty, including the `"[]"` note projection case. `review-3.md` M6-1 no longer reproduces in the owning toolbar.

## M7 — Reviewer fixes from review-3

M7 status: fail

Both requested code changes are present. The toolbar's short-transcript test asserts a selected-run `kind: "summary"` request and frozen route/prompt data; worker coverage asserts source run, corrected transcript, saved artifact and note projection. The empty-transcript renderer test mounts the owning `NoteRecordControl` and sees no Summary action. One Results-menu state introduced by the common handler remains inconsistent with capture eligibility.

### M7-1 — medium — Enabled Results Summary action silently does nothing during capture

- Files: `src/components/notes/MeetingResultsPanel.tsx:372`, `src/components/notes/MeetingResultsPanel.tsx:393-400`, `src/components/notes/MeetingResultsPanel.tsx:455-465`, `src/components/notes/MeetingResultsPanel.tsx:728-738`; `test/components/meetingResultsPanel.test.ts`.
- Violated contract: M2 forbids Summary during active capture; M7 says either visible manual Summary affordance follows the same selected-run operation and that short-transcript availability obeys capture/run eligibility. Consumer loading and unavailable states must remain coherent.
- Evidence: `summaryAction.available` becomes false while capture is preparing, recording, paused or saving. The toolbar uses that flag, but the Results `New Summary` menu item is rendered for any nonempty selected transcript and is disabled only by `summaryAction.isGenerating`. Its press calls `openRun("summary")`, which now returns immediately when `captureBlocksAsr` is true. The focused renderer cases test short and empty transcript states, not this active-capture menu state.
- Mechanism and impact: With an older selected transcript visible during a new capture, the enabled Results item accepts a click without launching a run, progress or error. The user is offered an operation that the handler silently rejects. The worker's capture protection remains intact; this is a visible state/interaction defect introduced by M7's new guard.
- Expected contract: An ineligible manual Summary action must not appear actionable; an eligible one starts the selected-run operation.

## Summary

Severity counts: critical 0; high 0; medium 2; minor 0. Overall status is blocked by M7-1 and the recurring M4-1 evidence gap. The two `review-3.md` code findings stop reproducing in their reported states.

## Verification

- Reviewer commands: read-only `git status --short --branch`, `git show --stat` and scoped M7 diff, `rg`, `sed` and `nl` on plan, progress, previous reviews, source and tests. No tests, builds, installs or native rebuilds were run by this reviewer.
- Root-supplied M7 results: `pnpm test -- test/components/meetingResultsPanel.test.ts test/helpers/meetingProcessing.test.ts` passed; `pnpm run lint` passed with 0 errors and existing warnings; `pnpm run typecheck` passed; full `pnpm test` passed across 396 files; `pnpm run build:renderer` passed; `git diff --check` passed. These were not independently rerun here.
- M7-1's active-capture Results menu state is not established by the supplied focused cases. The plan's isolated live capture/provider check remains unverified as described in M4-1.

## Unrelated failures and residual notes

No unrelated automated failure was reported. The pre-existing untracked `mockup.html` was left untouched. This reviewer wrote only `review-4.md` and made no commit.
