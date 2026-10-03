# Milestone audit — task 002, review 2

Status: blocked

Reviewed milestone commits: M1 `49d8e48c6`–`576c7202b`; M2 `394f19c63`–`2e1b17d85`; M3 `2e0cdb78a`–`8333a93a6`; M4 `9a14da5c5`–`16df60571`; M5 `51f587d23`, `0d3cca9c2`, `d733f5f39`, `c4b5f9865`, `8e790528e`, `bea026706`. The final M5 product tree is at `bea026706`; the task-local plan's orchestration table has an uncommitted root update and was read without editing. I read `review-1.md` and `implementation_progress.md` before auditing the final code. The plan remains self-contained.

## M1 — Durable end-of-meeting gate

M1 status: pass

The original finalized-run timer, current-group checks, Resume invalidation, and preserved audio/history paths remain. M5 closes `review-1.md` M1-1 for the live controls: recording, Pause and a pending gate disable all three manual ASR entries, with an `openRun` guard; the worker rejects active capture and a pending overlapping gate. Root reports the focused controlled-clock tests passing. A separate M5 restriction across older recording groups is recorded below.

## M2 — Speaker names and main Summary

M2 status: fail

The revised naming instruction explicitly limits names to self-introduction or addressed-and-answered evidence and rejects incidental mentions (`review-1.md` M2-1 resolved). The default Detailed Notes prompt now omits unstated owner/date fields (M2-4 resolved). The live short-transcript notice is visible in raw and Summary views, and the owning `NoteRecordControl` manual Summary callback was checked (M2-2 resolved for a nonempty ready transcript). The participant parser no longer silently converts malformed stored data to `[]` (M2-3 resolved), but its new failure path reverses the earlier naming-failure independence guarantee.

### M5-1 — high — Calendar candidate corruption now prevents Summary

- Files: `src/helpers/meetingProcessing.ts:795-808`, `src/helpers/meetingProcessing.ts:833-839`, `src/helpers/meetingProcessing.ts:931-949`, `src/helpers/meetingProcessing.ts:999-1024`, `test/helpers/meetingProcessing.test.ts:937-989`.
- Violated contract: M2 requires a naming error to leave a ready transcript and Summary path available; M5 must preserve that earlier guarantee while making corrupt participant data visible.
- Evidence: The snapshot parses `note.participants` before either automatic or manual Summary can proceed. Invalid JSON throws `calendar-participants-invalid`, so the run fails before Summary generation. If participant data becomes invalid during naming, M5 explicitly rethrows that error from `nameUnknownSpeakers`; the new test asserts `summaryCalls === 0` in both cases. The failure is visible, so the exact silent fallback reported in `review-1.md` M2-3 has stopped reproducing.
- Mechanism and impact: Calendar participants are optional naming candidates and are excluded from Summary input. A malformed candidate field now blocks Summary itself, including a manual request on an otherwise ready transcript, until that stored field changes. This is an overcorrection of the M2-3 finding and a regression of M2's error independence.

### M5-2 — medium — Empty transcript receives a misleading manual Summary promise

- Files: `src/components/notes/MeetingResultsPanel.tsx:350-362`, `src/components/notes/MeetingResultsPanel.tsx:617-624`, `src/helpers/meetingProcessing.ts:820-823`, `src/helpers/meetingProcessing.ts:1587-1593`.
- Violated contract: Empty/short processing states must not imply a fabricated success, and manual Summary is available on a ready transcript, not an empty one.
- Evidence: The new live notice checks duration/character thresholds but not whether the transcript has text. A completed run with a saved empty transcript has zero characters and therefore shows “You can create a Summary manually now.” The worker's manual Summary path immediately completes without a Summary when `transcript.text.trim()` is empty. The M5 renderer regression covers a nonempty short transcript only (`test/components/meetingResultsPanel.test.ts:489`).
- Mechanism and impact: After an ASR result with no speech, the UI presents an action as capable of producing a Summary even though the processing contract cannot produce one. This is a new empty-state regression from the M2-2 notice fix.

## M3 — Tasks, Recap, Follow-up and formatter

M3 status: pass

The task instruction now defines HIGH, MEDIUM and LOW exactly as the plan requires, excludes inferred priority from impact or today's date, and preserves spoken relative deadlines (`review-1.md` M3-1 resolved). The existing strict JSON repair, selected-route use, serialized one-Markdown task/Recap writes, editable Actions, Chat Follow-up and cleanup path were not changed by M5. The prompt regression is a static instruction assertion; real model-quality checks remain part of the M4 evidence gap.

## M4 — Integrated journeys and documentation

M4 status: fail

Current docs and the M1–M3 automated journey remain in place. The root reports an M5 seven-file focused suite, `pnpm run lint`, `pnpm run typecheck`, the full `pnpm test`, and renderer build passing. The required isolated live journey is still unverified.

### M4-1 — medium — Isolated live journey remains unverified

- Files/surfaces: capture and recording state, Notes/Summary, Chat Follow-up, Recap, selected providers including BB; task `implementation_progress.md` and the root's M5 verification record.
- Unproven requirement: M4 requires an isolated macOS mic/system capture journey through Pause/Resume/End, 15-second wait, short and qualifying Summaries, speaker correction, Follow-up and Recap, with representative configured providers where available.
- Evidence: The root launched Electron with an explicit isolated `--user-data-dir` at `/tmp/openhercules-task002-smoke-rFdHjr`; it started and initialized dependencies with zero isolated environment variables. macOS CUA targeted a different, already-running user dev Electron window, so no capture, Notes or provider interaction was safely performed in the isolated process. Startup is partial evidence only. The progress log also records live hardware, provider/BB and controlled model-quality checks as unverified.
- Mechanism and impact: Automated fixtures and process startup cannot prove real mic/system tracks, timing, selected provider replies or the complete live UI transition. This is the same outstanding finding as `review-1.md` M4-1.

## M5 — Reviewer fixes from review-1

M5 status: fail

All six named `review-1.md` code findings have direct changes and focused regressions. The previously passing Summary failure independence was overcorrected, the new notice mishandles empty transcripts, and the manual gate restriction reaches older groups on the same note. M4-1 was accurately reported as incomplete; the isolated process startup was not presented as a passed live journey.

### M5-3 — medium — A new group's wait disables ASR for older completed groups

- Files: `src/components/notes/MeetingResultsPanel.tsx:254-266`, `src/components/notes/MeetingResultsPanel.tsx:336-349`, `src/components/notes/MeetingResultsPanel.tsx:598-609`.
- Violated contract: M5 fixes the current meeting's early-ASR control without broadening restrictions on previously completed recording groups and their manual reprocess flow.
- Evidence: The panel supports multiple `groupId` values for one note, but `latestStopDeadline` takes the maximum `endedAt + 15 seconds` over **all** recordings on the note. That single value disables every per-part ASR entry and the whole-meeting control. The new renderer tests cover one group in recording/paused/waiting states, not selection of an older completed group after a later group's Stop.
- Mechanism and impact: During the 15 seconds after a new group's Stop, the user cannot manually reprocess an older part whose own gate passed long ago. This temporary restriction is unrelated to the selected older run and is a broader UI behavior than the M1-1 fix requires.

## Summary

Severity counts: critical 0; high 1; medium 3; minor 0. Overall status is blocked. The six `review-1.md` code findings no longer reproduce in their reported form; M4-1 persists, and M5 introduced the three concrete issues above.

## Verification

- Reviewer read-only commands: `git status --short --branch`, `git log --oneline --no-decorate -14`, `git diff --stat adfa8157d..HEAD`, `git show --format=medium --stat` and source/test diffs for M5 implementation commits, plus scoped `rg`, `sed`, and `nl` reads. These confirmed the cited final-tree conditions and test coverage. No test, build, install or native rebuild was run by this reviewer.
- Root-supplied automated results: `pnpm test -- test/helpers/meetingProcessing.test.ts test/components/meetingResultsPanel.test.ts test/services/meetingResults.test.ts test/stores/meetingRecordingStoreAutoEndStop.test.ts test/cases/ai/integration/meetingJsonRepair.test.ts test/cases/notes/integration/meetingSummarySections.test.ts test/locales/translationCoverage.test.ts` passed; `pnpm run lint` passed; `pnpm run typecheck` passed; `pnpm test` passed; renderer build passed. M5 progress records `git diff --check` passing. These results were not independently rerun here.
- Isolated Electron startup occurred as described under M4-1. Live hardware, UI journey, configured provider/BB responses and controlled prompt-quality outputs remain unverified.

## Unrelated failures and residual notes

No unrelated automated failures were reported. The pre-existing untracked `mockup.html` and root's uncommitted orchestration update to `plan.md` were left untouched. This reviewer wrote only `review-2.md` and made no commits.
