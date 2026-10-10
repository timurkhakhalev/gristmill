# Task 005 code review 1

## Findings

### medium — Local preparation remediation does not reach the processing notice

Location: `src/helpers/meetingAudioMixer.ts:466-473`; affected consumers:
`src/helpers/meetingProcessing.ts:2242-2271` and
`src/components/notes/MeetingResultsPanel.tsx:2061-2072`.

Trigger: disk admission or a later write fails, or the native helper is unavailable,
when a transcription run prepares its saved audio.

The mixer creates an actionable message and one of the new codes
`audio-preparation-disk-full` or `audio-preparation-failed`. The processing worker
stores only the code in its failed state. The existing notice does not handle either
code and displays the generic message “Your audio is saved. Processing failed; try
again.” The disk-space or installation action is lost. Retrying with the same full
disk or unavailable helper fails again without telling the user what to correct.

This leaves the explicit actionable-local-error requirement in plan sections 2 and
5.2 unmet. The issue is the new error contract's missing consumer mapping; it is
not a request for a new error surface or a general redesign of existing errors.

Correction: map these preparation failures into the existing notice with localized
local-storage/preparation guidance. In particular, the disk-full code must advise
freeing space before retry. Keep provider-error mappings unchanged. Verify the
persisted error code and visible description together; mixer-only rejection tests
do not establish the user-facing result.

Evidence: traced the real preparation calls, `failureFromUnknown`, `handleFailure`,
the stored failed state and the notice's error-code branches. The committed
admission/write-failure regressions verify mixer codes and cleanup, but no changed
processing/renderer branch consumes those codes.

### medium — Copied-fixture replay omits gap and overlap categories between epochs

Location: `test/helpers/harness/meetingMixerBenchmark.ts:381-400`, with excerpt
selection at `test/helpers/harness/meetingMixerBenchmark.ts:484-497`.

Trigger: a copied eligible source has a gap or overlap between separate epochs,
while each epoch contains a single continuous mapped range.

Every first row of an epoch is unconditionally labelled `generation`. The gap and
overlap classification only compares rows inside that same epoch. Therefore a real
inter-epoch gap or overlap never enters either category. Deduplication by category
then produces only one generation excerpt and no gap/overlap excerpts. A fixture
can pass while the category index cannot identify the discontinuities required for
the user's listening checks. The synthetic benchmark uses a separately populated
boundary list, so its passing category coverage does not catch this defect in the
copied-input path.

Correction: retain generation resets and also classify each new epoch's first
anchor against the preceding epoch's mapped end for the same source. Emit both
relevant categories where needed. Add a synthetic raw-transport replay regression
with inter-epoch gaps and overlaps and assert the published window/excerpt category
index. Keep all real fixture coordinates and reports external.

Evidence: an isolated synthetic raw-row fixture with both sources, separate epochs,
a gap and an overlap passed `productionBenchmark` in copied-fixture mode. Its
excerpt categories were exactly `generation`, `start`, `end`; both `gap` and
`overlap` were absent. This reproduction used temporary synthetic profiles and the
actual production preparation path, without application builds or real data.

## Scope and assumptions

- Reviewed the full `develop..75e3dc278` diff, including M1, M2, M2.1, M3 and the
  implementation in shared-index commit `23792c7a1`. Used `plan.md` as requirements
  and `implementation_progress.md` as the existing verification record.
- Inspected the alignment authority/provenance, mapper, native helper, decoded
  input and endpoint contracts, all layout assembly paths, disk admission,
  cancellation/child settlement, managed storage, direct processing/playback/export
  callers, build cache, resource delivery/signing hooks, test registration,
  private raw transport, replay, waveform oracle and changed documentation.
- Kept the concurrent orchestration edit in `plan.md` untouched. No production
  code, test file, history, worktree or commit was changed. Ponytail was not used.
- No additional actionable native mapping, short-input preservation, overlap/gain,
  original-file ownership or child-settlement defect was established in this scope.
  This is a review result, not proof that every possible input is correct.

## Verification

Reused the recorded M1/M2.1 focused regressions, build-cache checks, full canonical
suite, lint/typecheck/format, repeated synthetic performance runs and exact locally
signed package checks. These results were supplied evidence; this review did not
rerun or independently certify the shared builds and full suite.

Additional checks:

- `git diff --check develop..75e3dc278`: passed.
- `ELECTRON_RUN_AS_NODE=1 REQUIRE_DB_TESTS=1 NODE_ENV=test node_modules/.bin/electron --import tsx /private/tmp/task005-boundary-review.cts`:
  one synthetic reproduction passed, zero failed or skipped, confirming the
  omitted inter-epoch categories. It asserted the current defective result; this
  is reproduction evidence, not a regression-test pass for a correction.
- The initial restricted run failed because `/usr/bin/time -l` could not read its
  kernel counter. The same isolated command passed with approved counter access.
  No measurement or error check was weakened.

The temporary reproduction file was external to the repository. Its generated
profiles, audio and reports were cleaned by the test. No private fixture was read
or copied by this reviewer, and no private identifiers, measurements or hashes are
included here.

## Remaining verification limits

The provided technical replay evidence passes for eligible parts only. Rejected
parts remain preserved and uncertified. The older failed capture's packet-disorder
cause remains unknown; this task does not claim that it repaired that cause.

Human listening and purposeful microphone/system signal participation remain
unverified. The user explicitly accepted proceeding with technical reviews while
those checks remain pending. Basic isolated package mechanics have recorded
evidence, but they do not establish speech quality. Developer ID signing and
notarization were unavailable; the local package is not public-release qualified.

## Merge readiness

Request corrections for the two medium findings before technical approval. Preserve
the existing passing evidence and rerun only the affected error-notice and synthetic
copied-replay checks after correction. The accepted human/release verification
limits must remain explicit; this report does not authorize merge or installation.
