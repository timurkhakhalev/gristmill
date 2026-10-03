# Milestone audit — task 002, review 5

Status: blocked

Reviewed milestone commits: M1 `49d8e48c6`–`576c7202b`; M2 `394f19c63`–`2e1b17d85`; M3 `2e0cdb78a`–`8333a93a6`; M4 `9a14da5c5`–`16df60571`; M5 `51f587d23`–`bea026706`; M6 `9873d1650`–`34bbf64dd`; M7 `f4b8dfc46`, `1c5f72b44`; M8 `eb3fac552`, `473b59794`. I read the current self-contained `plan.md`, `implementation_progress.md` and prior review reports; prior reports supplied diagnostic context for the fix milestones.

## M1 — Durable end-of-meeting gate

M1 status: pass

The persisted final-Stop 15-second gate, Resume invalidation, current-group eligibility, retry state and raw-track retention are unchanged by M8. The root's automated checks passed; real mic/system timing remains under M4-1.

## M2 — Speaker names and main Summary

M2 status: pass

M8 changes no worker, naming, prompt, snapshot or persistence code. Manual Summary still uses M7's selected transcript run, corrected speaker projection, manual notes and saved run artifact/note projection. Automatic duration/text thresholds and the selected provider route remain intact in the inspected path.

## M3 — Tasks, Recap, Follow-up and formatter

M3 status: pass

M8 leaves the one selected-run Markdown, revision-checked tasks/Recap mutations, existing Chat Follow-up, editable Actions, JSON repair and cleanup formatter untouched. The common Summary artifact that these consumers use remains the M7 path.

## M4 — Integrated journeys and documentation

M4 status: fail

Current documentation and integrated automated checks remain in place. The isolated app startup reached onboarding only; the plan's real capture and configured-provider journey has not been observed.

### M4-1 — medium — Required isolated live journey remains unverified

- Files/surfaces: capture and recording state, Notes/Summary, Chat Follow-up, Recap, selected providers including BB; `implementation_progress.md` and the root's M8 verification record.
- Unproven requirement: M4 calls for isolated macOS mic/system capture with Pause/Resume/End and the 15-second wait, short and qualifying Summaries, speaker correction, Follow-up and Recap, plus representative configured provider routes where available.
- Evidence: The root reports an isolated app starting to onboarding, but permission for a test recording is pending. No live mic/system capture, Notes/provider journey or controlled model-quality output was performed. Focused/full tests, lint and typecheck passed; these exercise automated boundaries only.
- Mechanism and impact: Startup and synthetic tests do not prove the real dual tracks, gate timing, provider/BB responses or complete UI states. This is the same unresolved evidence gap as `review-1.md` M4-1, `review-2.md` M4-1, `review-3.md` M4-1 and `review-4.md` M4-1. Startup remains partial evidence.

## M5 — Reviewer fixes from review-1

M5 status: pass

M8 does not affect the six closed code findings: current-group manual ASR gating, evidence-based naming and priority instructions, visible corrupt participant error, short nonempty transcript notice, and omission of absent owner/deadline fields. No fallback or compatibility route was introduced.

## M6 — Reviewer fixes from review-2

M6 status: pass

M8 leaves Summary independent of optional participant corruption, keeps the empty-transcript notice suppressed, and does not change older completed-group ASR controls. Both manual Summary affordances still require nonempty selected transcript text, so the `"[]"` note projection does not revive an empty-transcript action.

## M7 — Reviewer fixes from review-3

M7 status: pass

The main toolbar and Results action continue to invoke the same `openRun("summary")` selected-run request. The removed generic Action route has not returned. The existing short-transcript and empty-transcript renderer regressions, and worker artifact/projection assertions, passed in the root's focused and full suites. M8 closes the capture-state Results discrepancy reported as `review-4.md` M7-1.

## M8 — Reviewer fix from review-4

M8 status: pass

`MeetingResultsPanel` now disables the Results `New Summary` item whenever `captureBlocksAsr` is true. That matches the toolbar's eligibility and the common handler's guard for preparing, recording, paused and saving phases. The new renderer case checks each phase with an older selected transcript, then changes to idle and confirms an enabled `kind: "summary"` request with that run's `sourceRunId`. It does not change the selected-run operation or worker protection. `review-4.md` M7-1 no longer reproduces. I found no new concrete M8 defect.

## Summary

Severity counts: critical 0; high 0; medium 1; minor 0. Overall status is blocked only by the recurring M4-1 live-verification gap; M8's code finding is closed.

## Verification

- Reviewer read-only commands: `git status --short --branch`, scoped `git show` of M8 commits, and `rg`, `sed` and `nl` reads of the current plan, progress, previous review, source and renderer tests. I ran no tests, builds, installs or native rebuilds.
- Root-supplied M8 results: `pnpm test -- test/components/meetingResultsPanel.test.ts test/helpers/meetingProcessing.test.ts` passed; `pnpm run lint` passed with 0 errors and pre-existing warnings; `pnpm run typecheck` passed; full `pnpm test` passed across 396 files; `git diff --check` passed. These were not independently rerun here.
- The M4 isolated live capture/provider verification remains unperformed as described above.

## Unrelated failures and residual notes

No unrelated automated failures were reported. The pre-existing untracked `mockup.html` was left untouched. This reviewer wrote only `review-5.md` and made no commit.
