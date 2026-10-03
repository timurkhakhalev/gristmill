# Milestone audit — task 002

Status: blocked

Reviewed milestone commits: M1 `49d8e48c6`–`576c7202b`; M2 `394f19c63`–`2e1b17d85`; M3 `2e0cdb78a`–`8333a93a6`; M4 `9a14da5c5`–`16df60571`. I inspected the milestone implementation commits and the final tree at `adfa8157d`; intervening progress and fix commits are included in each milestone's orchestration list. No earlier `review-*.md` existed.

The plan is self-contained for implementation. The fixed cutover, preserved-data, selected-provider, and one-Markdown contracts were used for this audit.

## M1 — Durable end-of-meeting gate

M1 status: fail

Final Stop persists a deadline; the worker checks elapsed time, finalized audio, inactive capture and group membership before gated prepare/ASR. Resume cancels pending group work, and the supplied controlled-clock tests passed. A live manual route remains outside the gate.

### M1-1 — high — Manual Transcribe can process a paused meeting

- Files: `src/components/notes/MeetingResultsPanel.tsx:575-588`, `src/helpers/meetingProcessing.ts:418-476`, `src/stores/meetingRecordingStore.ts:1490-1505`, `src/helpers/database.ts:1339-1410`.
- Violated contract: Pause must not start ASR; a manual control cannot bypass the final Stop plus 15-second gate.
- Evidence: The live audio popover exposes both per-part ASR and whole-meeting Transcribe whenever finalized audio exists, without a paused-state restriction. Those controls create `reprocess` runs without `gateAfterStop`. `createRun` blocks only when an active gated run overlaps the sources; Pause suppresses/cancels initial processing, leaving no active gate. An ungated run is persisted with `retryAt: null` and can be claimed as soon as capture becomes inactive.
- Mechanism and impact: After Pause, selecting Transcribe can start prepare/ASR before End. If selected while capture is active, the queued ungated run can start on Pause. This breaks the user-visible capture state and the hard 15-second launch rule. The M1 test at `test/helpers/meetingProcessing.test.ts:267-350` covers a pending gate and Resume, but not this paused, ungated control path.

## M2 — Speaker names and main Summary

M2 status: fail

The final tree saves run-scoped source and prompt snapshots, retains source/model/user provenance, uses revision checks for late names, applies inclusive automatic Summary thresholds, and keeps old Summary visible during manual regeneration. Four contract gaps remain in its prompts and live consumer state.

### M2-1 — high — Naming prompt omits the required evidence rule

- Files: `src/helpers/meetingSpeakerNaming.ts:30`, `src/helpers/meetingProcessing.ts:958-1009`.
- Violated contract: A model name requires a self-introduction or an unambiguous addressed-and-answered exchange; incidental name mentions are insufficient.
- Evidence: The actual instruction asks only for “clear evidence” and unique identity. It does not state the two permitted evidence forms or explicitly reject an incidental name mention. The application validates JSON shape, IDs and correction revision, but cannot validate semantic evidence. The planned controlled Russian prompt-quality cases were not recorded in `implementation_progress.md`.
- Mechanism and impact: A valid JSON name inferred from an incidental mention can be applied automatically, displayed with model provenance and used in Summary. The plan made the narrow evidence rule the protection against that outcome.

### M2-2 — high — Short-meeting ineligibility notice exists only in Debug

- Files: `src/components/notes/MeetingResultsPanel.tsx:665-671`, `src/components/notes/NoteEditor.tsx:320-329`.
- Violated contract: A short ready transcript must show the previewed automatic-Summary ineligibility notice while retaining manual Summary access.
- Evidence: `autoSummarySkipped` is rendered only behind `mock?.autoSummarySkipped`; no live branch computes or displays the 180-second/2,500-character reason. The manual Summary affordance exists in `NoteEditor`, so the missing notice is confined to the live explanation state.
- Mechanism and impact: When automatic Summary completes without output because either threshold is unmet, the live Summary tab is empty without telling the user why. The Debug preview does show that explanation, so the integrated UI diverges from the accepted consumer contract.

### M2-3 — high — Invalid participant data is silently treated as absent

- Files: `src/helpers/meetingProcessing.ts:1703-1725`, `src/helpers/meetingProcessing.ts:896-936`.
- Violated contract: The task forbids unrequested tolerant/fallback behavior and requires the run snapshot to reflect its source data accurately.
- Evidence: `participantCandidates` raises `calendar-participants-invalid` for malformed JSON or unexpected structure, but the newly introduced `availableParticipantCandidates` catches that failure and returns `[]`. Snapshot creation then persists an empty participant list without recording a source-data error. The plan allows null or unavailable participant fields; it does not authorize interpreting malformed stored participant data as a verified empty list.
- Mechanism and impact: Corrupt participant data becomes indistinguishable from no invitees in the naming input and later source-revision checks. A source-integrity failure is hidden while automatic naming proceeds.

### M2-4 — medium — Default Summary prompt adds absent owner/deadline placeholders

- File: `src/helpers/builtinActions.ts:20-26`.
- Violated contract: Owner and deadline should appear only when stated by the source; the default Summary should not add unsupported fields or boilerplate.
- Evidence: The new Detailed Notes prompt says to include owner and due date only when stated, then directs the model to say “Owner not specified” or “Due date not specified” otherwise.
- Mechanism and impact: For a supported action without an assigned owner or date, the default instruction produces owner/date placeholders that the plan says to omit. This affects new automatic and manual Summary generations that use the built-in instruction.

## M3 — Tasks, Recap, Follow-up and formatter

M3 status: fail

Tasks and Recap validate strict JSON, serialize selected-Markdown mutations, retain prior Summary on failure, and use the selected text route. Follow-up remains an ordinary message in the existing Chat; the formatter uses the existing cleanup route. The task-priority instruction changes the specified classification policy.

### M3-1 — high — Task prompt permits priority inference from impact

- File: `src/helpers/meetingSummarySections.ts:18-24`.
- Violated contract: HIGH requires explicitly urgent, time-critical or blocking agreed work; MEDIUM is a concrete next step without exceptional urgency; LOW requires explicitly deferred or low-priority agreed/requested work.
- Evidence: The sent instruction says “Prioritize by supported urgency and impact” and never defines the three required categories. `validateMeetingTasks` checks schema and duplicates only, as planned, so no later step can enforce the omitted semantic rule.
- Mechanism and impact: The model can mark a high-impact but nonurgent action HIGH, or assign LOW based on perceived low impact, despite the narrower fixed policy. The resulting priorities are saved into the one Summary Markdown.

## M4 — Integrated journeys and documentation

M4 status: fail

The five current documents describe the shipped pipeline and distinguish automated evidence from live checks. M4 serialized overlapping BB Actions on their run thread and added a regression case. Integrated automated checks passed according to the root integrator; the required isolated live journey remains unverified, and the M1–M3 findings remain visible in its consumers.

### M4-1 — medium — Required isolated live journey has no evidence

- Files: `implementation_progress.md` (M4 verification record); affected capture, Notes, Chat and selected-provider surfaces.
- Unproven requirement: The M4 verification contract calls for isolated macOS mic/system capture, Pause/Resume/End, the 15-second wait, short and qualifying meetings, speaker correction, Follow-up and Recap, plus representative configured provider routes including BB when available.
- Evidence: `implementation_progress.md` explicitly records these checks as unverified. The root reports focused suites, lint, typecheck and the full `pnpm test` passing, but no isolated-profile hardware or configured-provider smoke output was supplied.
- Mechanism and impact: Automated synthetic and renderer fixtures cannot establish real capture tracks, provider/BB responses or the complete live UI timing. M4's end-to-end acceptance remains unproven on those boundaries.

## Summary

Severity counts: critical 0; high 5; medium 2; minor 0. Overall status is blocked by the scoped findings above. No prior review finding references apply.

## Verification

- Reviewer read-only commands: `git status --short --branch`; `git diff --stat 2a1aa0e48..HEAD`; `git log --oneline --no-decorate 2a1aa0e48..HEAD`; `git show --format=medium --stat --no-renames` for milestone implementation commits; scoped `rg`, `sed`, and `nl` source/test reads. These confirmed commit coverage and the cited final-tree paths.
- Root integrator supplied results for the final tree: milestone-focused M1/M2/M3/M4 tests passed; `pnpm run lint` passed with warnings only; `pnpm run typecheck` passed; `pnpm test` passed; `git diff --check` passed. Exact focused commands are recorded in `plan.md` and `implementation_progress.md`; this reviewer did not rerun them.
- Tests, builds, installs and native rebuilds were not run by this reviewer. The manual M1–M4 isolated-profile and prompt-quality checks remain unverified.

## Unrelated failures and residual notes

No unrelated failing automated checks were reported. The untracked task-local `mockup.html` was left untouched. No product code, plan, progress log or historical task file was edited during this audit.
