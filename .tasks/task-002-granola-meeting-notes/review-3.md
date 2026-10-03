# Milestone audit — task 002, review 3

Status: blocked

Reviewed milestone commits: M1 `49d8e48c6`–`576c7202b`; M2 `394f19c63`–`2e1b17d85`; M3 `2e0cdb78a`–`8333a93a6`; M4 `9a14da5c5`–`16df60571`; M5 `51f587d23`–`bea026706`; M6 `9873d1650`, `71389b117`, `a38587ca5`, `34bbf64dd`. I read the current `plan.md`, `implementation_progress.md`, `review-1.md` and `review-2.md`, then inspected the M6 commits and final source. The plan is self-contained; its task-local prior review links are the permitted diagnostic inputs for fix milestones.

## M1 — Durable end-of-meeting gate

M1 status: pass

The finalized-run deadline, capture/current-group checks, Resume invalidation and raw-track preservation remain in place. M6 keeps the current group's pending ASR gated while allowing an older completed group's per-part reprocess control. The root's focused and full tests passed; live mic/system timing remains under M4-1.

## M2 — Speaker names and main Summary

M2 status: fail

M6 now records malformed optional calendar participants as a persisted naming error and lets both eligible automatic and ready manual worker Summary runs continue. Its tests cover initial corruption and corruption during the naming response, so `review-2.md` M5-1 no longer reproduces in the worker. The narrow naming prompt, correction precedence, thresholds and saved selected-run path remain. A separate visible manual Summary control still uses a different Action pipeline.

### M2-1 — high — Main manual Summary control bypasses the run-scoped Summary contract

- Files: `src/components/notes/NoteEditor.tsx:908-922`, `src/components/notes/PersonalNotesView.tsx:469-530`, `src/utils/llmTranscript.ts:39-77`, `src/stores/actionProcessingStore.ts:175-207`, `src/components/notes/MeetingResultsPanel.tsx:453-487`.
- Violated contract: M2 requires manual and automatic Summary generation to use the same selected-run corrected-segment/manual-note snapshot, exclude calendar attendees/email, freeze prompt/model per run, and save one Markdown Summary as a selected-run artifact and note projection. M3 tasks/Recap consume that saved artifact.
- Evidence: The visible `NoteRecordControl` Summary button calls `PersonalNotesView.generateSummary`, which invokes generic `runNoteAction`. That path builds `## Meeting Context` from calendar participants, formats the note's raw/live transcript independently of the selected run, calls `runAction`, and updates `note.enhanced_content` directly. It does not create a `kind: "summary"` processing run or save a Summary artifact. The separate Results popover `New Summary` does create a run through `meetingProcessingCreateRun`; these are two live manual paths with different contracts. M6's short-transcript renderer check confirms the toolbar callback exists but does not inspect its payload or persisted result.
- Mechanism and impact: A user choosing the main toolbar Summary can send invitee names/emails as meeting context, lose the selected speaker/run projection, and receive note text that is not the saved Summary consumed by tasks and Recap. Regeneration and run reselection can then show a different Summary from the one that Action produced. This violates the hard single-path and input-exclusion decisions even though the worker's manual path passes its tests.

## M3 — Tasks, Recap, Follow-up and formatter

M3 status: fail

The selected-run tasks/Recap mutation, strict JSON repair, existing Chat Follow-up, and cleanup formatter remain unchanged and pass the supplied tests. M2-1 leaves the toolbar-generated manual Summary outside that selected-run artifact, so tasks and Recap cannot use the Summary produced by that user-facing path. No additional M3-specific defect was found.

## M4 — Integrated journeys and documentation

M4 status: fail

Current documents and automated integration evidence remain in place. An isolated Electron profile started, but no isolated window interaction or real capture/provider journey was observed.

### M4-1 — medium — Required isolated live journey remains unverified

- Files/surfaces: capture and recording state, Notes/Summary, Chat Follow-up, Recap and selected providers including BB; `implementation_progress.md` and the root's M6 verification record.
- Unproven requirement: M4 calls for isolated macOS mic/system capture through Pause/Resume/End, 15-second wait, short and qualifying Summaries, speaker edit, Follow-up and Recap, plus representative configured provider routes where available.
- Evidence: The root started an Electron process with an explicit isolated `--user-data-dir`, but macOS CUA selected a different, already-running user development window. No safe live capture, Notes or provider interaction occurred in the isolated process. A uniquely targetable packaged Dev app would require packaging/native rebuild while existing user apps are running, which the repository quality steering prohibits. Root reports passing automated checks, but no hardware/provider smoke or controlled model-quality output.
- Mechanism and impact: Startup and synthetic tests cannot prove the real audio tracks, timing, provider/BB responses or complete live UI states. This is the same outstanding finding as `review-1.md` M4-1 and `review-2.md` M4-1; startup remains partial evidence only.

## M5 — Reviewer fixes from review-1

M5 status: pass

The six original `review-1.md` code findings remain closed in their reported routes: no paused or active manual ASR control, exact naming/priority instructions, visible nonempty short-transcript notice, visible malformed-participant naming error and omitted absent owner/date fields. M6 did not reintroduce a silent empty-candidate fallback or remove the prior selected-run protections.

## M6 — Reviewer fixes from review-2

M6 status: fail

`review-2.md` M5-1 is resolved: participant corruption is stored as `speakerNamingErrorCode`, model naming is skipped, and worker Summary can complete. M5-3 is resolved: per-group deadlines leave old completed parts available, while a whole-note request including the new gated group stays disabled. M5-2 is resolved in the Results notice, which now requires nonempty transcript text, but the owning toolbar still offers Summary for an empty saved projection.

### M6-1 — medium — Empty transcript still exposes the manual Summary button

- Files: `src/helpers/meetingProcessing.ts:1611-1617`, `src/components/notes/NoteEditor.tsx:270-286`, `src/components/notes/NoteEditor.tsx:908-922`, `src/components/notes/NoteRecordControl.tsx:61-77`, `test/components/meetingResultsPanel.test.ts` (empty-transcript case).
- Violated contract: M6 requires an empty transcript not to promise manual Summary; M2 allows manual Summary on a ready transcript, not an empty result. This is the remaining consumer form of `review-2.md` M5-2.
- Evidence: Empty ASR output is projected to the string `"[]"`. `NoteEditor` sets `hasMeetingTranscript` from `!!note.transcript`, so that nonempty JSON string still enables `showSummaryAction` and renders the Summary button. M6's empty-transcript test mounts `MeetingResultsPanel` alone and checks only that the notice text is gone; it does not render the owning `NoteRecordControl`. The worker Summary path completes without an artifact when transcript text is empty.
- Mechanism and impact: For a recording with no transcribed speech, the live toolbar still invites manual Summary generation despite no ready transcript. Its callback follows the separate generic Action route described in M2-1, so the user can obtain a note enhancement from `"[]"` or manual notes rather than a grounded selected-run Summary. The Results notice no longer makes this promise, but the visible button does.

## Summary

Severity counts: critical 0; high 1; medium 2; minor 0. Overall status is blocked. M6's worker, notice and group-gate fixes address the three `review-2.md` code routes, but the owning empty-state control remains exposed; M4-1 persists, and the separate manual Summary path violates M2/M3.

## Verification

- Reviewer read-only commands: `git status --short --branch`, `git log --oneline --no-decorate`, `git show --format=medium --stat` and source/test diffs for M6 commits, plus scoped `rg`, `sed` and `nl` reads. I did not run tests, builds, installs or native rebuilds.
- Root-supplied results: `pnpm test -- test/helpers/meetingProcessing.test.ts test/components/meetingResultsPanel.test.ts` passed; `pnpm run lint` passed; `pnpm run typecheck` passed; full `pnpm test` passed. M6 progress records scoped typechecks/ESLint, locale-key audit and `git diff --check` passing. These were not independently rerun here.
- The isolated Electron process startup is partial evidence only. Live capture, Notes/provider interaction, BB behavior and controlled prompt-quality outputs remain unverified as described in M4-1.

## Unrelated failures and residual notes

No unrelated automated failures were reported. The root's uncommitted orchestration update in `plan.md` and the pre-existing untracked `mockup.html` were left untouched. This reviewer wrote only `review-3.md` and made no commits.
