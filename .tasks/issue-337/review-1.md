# Issue 337 milestone audit

Status: blocked

## Reviewed milestone commits

- M1: `570cb3ca1` (implementation), `9980c202a` (verification evidence).
- M2: `47f100885` (implementation), `2558bfb34` (verification evidence).

Reviewed `plan.md`, `implementation_progress.md`, the milestone diffs, affected source and tests, and the recorded final verification logs. No earlier `review-*.md` report exists. This report is the milestone contract audit; it does not replace the parallel universal code review.

## M1 status: fail

The stable-ID cutover, atomic contact mutations, in-place voice-profile migration, correction membership checks, and first-processing freeze are present. The imported-Summary preservation requirement is not satisfied.

### Acceptance evidence

1. **Stable identities and optional attributes:** `contactIdentityMigration.ts` creates integer contact IDs; `database.ts` materializes normalized-email ingress and creates separate name-only contacts. `contactPersistence.test.ts` verifies separate equal-name contacts and reopening.
2. **Telegram normalization and conflicts:** the shared `contactIdentity.ts` normalizer covers the agreed input forms and rejects unsupported forms. SQLite uniqueness uses `COLLATE NOCASE`; canonical mutations return typed conflicts before writes. Unit, persistence and IPC/bridge tests cover these outcomes, case-only edits and clearing/reuse.
3. **Migration and persisted history:** the conversion is transactional, retains the `speaker_profiles` table, populates contact references, drops its old email column in place, and checks foreign keys before commit. Migration tests verify unchanged profile IDs, embeddings, sample counts, mapping/correction references and revisions; malformed participant entries, rollback and reopening are covered. Historical local Summary/LLM metadata is retained. Imported Summary handling has the gap below.
4. **Consumer cutover:** contact mutations, profile caches and run-correction requests use IDs. Current People/calendar upserts preserve existing IDs, learned names and Telegram fields. The recorded compiler, consumer and full-suite runs pass. The remaining legacy mention reader is explicitly authorized by the plan and remains read-only.
5. **Correction membership:** worker and database validation use the owning note's contact IDs before correction/name writes. Tests exercise name-only selection, another note's contact, reopen and preserved Summary text; voice-profile selection remains separate.
6. **Frozen processing context:** `meetingProcessing.test.ts` proves learned names saved after materialization enter the first request, including a name-only participant. Failure, cancellation, retry, restart, later runs, history cleanup and freeze rollback are covered. CLI/export use snapshot fields. Imported meetings containing a Summary are not covered by those guarantees.

### R1 — high — M1, with M2 documentation impact: imported Summaries do not start with frozen participant context

**Files:** `src/helpers/granolaImport.ts:530`, `src/helpers/database.ts:4170`, `src/helpers/contactIdentityMigration.ts:129`, `.memory-bank/architecture/note-writes.md:37`, and the import/migration/processing tests.

**Violated requirement:** M1 storage scope explicitly says, “Imported notes that already contain a Summary also start frozen.” M1 AC6 requires processed/imported historical meetings to remain frozen; its verification explicitly includes imported summaries remaining frozen. This is also a cross-milestone invariant for M2's documentation and historical-context guarantees.

**Evidence:**

- The Granola parser reads a distinct `summary` field and combines it with `userNotes` into `content` at lines 530–531. The emitted import row at lines 567–574 has no Summary/freeze metadata.
- `DatabaseManager.importNotes` inserts `content`, transcript and materialized participants, but does not set `participant_context_frozen`. The fresh column default is `0`.
- Migration marks a note frozen only when `enhanced_content` is nonempty or an LLM source snapshot exists. A historical Granola Summary stored in ordinary `content` satisfies neither condition.
- `freezeParticipantContext` then refreshes a provisional roster from current contacts before setting the flag. Thus both a newly imported Summary and a prior Granola import can receive later live names/emails at their next processing boundary.
- The migration test's saved Summary fixture uses `enhanced_content`; the added processing tests do not exercise an imported Summary. The passing suite therefore does not establish the named import invariant.
- The progress record acknowledges the lost distinction. The permanent documentation states that imported content without saved Summary metadata retains the normal first-processing boundary, narrowing the plan's promise without a recorded planning decision.

**How it occurs and why it matters:** import a CSV with a Summary and participant, then change that shared contact before processing the imported note. Its flag remains `0`, so the next freeze replaces historical participant name/email fields with the later contact values. An old imported Summary also remains provisional after migration. Historical meeting context, CLI/export participant projections after that freeze, and later AI input can therefore change despite the explicit imported-Summary preservation requirement. The saved Summary text itself is not rewritten by this path.

**Expected contract:** a meeting that already contains an imported Summary begins with frozen participant context; the learned-name refresh at first processing applies to provisional meetings.

No earlier matching finding exists.

## M2 status: fail

The participant forms, conflict selection, shared-card refresh, Telegram opening, name-only correction and ID/legacy mention journeys match the planned interaction scope. R1 leaves the inherited historical-context contract incomplete, and the delivered note-write documentation records that narrower behavior.

### Acceptance evidence

1. **Create/reuse/correct without email:** the create form accepts a required name with nullable optional fields; selection uses IDs. Mounted tests and the recorded clean disposable-profile smoke demonstrate creation/reuse, and processing/runtime evidence demonstrates name-only correction.
2. **Telegram edit/clear/conflict:** renderer and main share normalization. Mounted tests cover invalid link input and retained drafts; persistence and smoke evidence cover case-insensitive conflict, clearing and reuse with one displayed `@`.
3. **External opening:** cards construct an escaped HTTPS `t.me` URL and call `externalLinks.ts`; the mounted test asserts the helper invocation. Absent Telegram has an add affordance and no open action.
4. **Stable associations and current cards:** confirmed mutations invalidate shared ID profiles. Mounted tests establish no note writes during contact edits; persistence/processing tests and restart smoke establish stable IDs and frozen ordinary meeting snapshots. R1 is the imported-Summary exception.
5. **Keyboard/pending/error lifecycle:** the shared form prevents duplicate submissions, disables pending controls, retains failed drafts, supports submit/Escape, and retains a successfully created contact for participant-add retries. Mounted behavior tests and smoke evidence cover these paths.
6. **Documentation and integrated regression:** the five planned permanent documents and all existing locales were updated, and recorded integrated checks pass. The documented import exception described in R1 does not fulfill the planned invariant.
7. **Email conflicts:** create-time conflict requires explicit existing-contact selection; cancel retains input and already-added selection is disabled. Edit-time conflict retains the original saved contact and offers no transfer/merge action. Mounted and database tests cover these outcomes.
8. **ID mentions and equal names:** suggestions deduplicate by contact ID, chips resolve profiles by ID, new unbound insertion stays plain text, and owner tagging rejects ambiguous names. Tests cover separate equal-name selections, positive IDs and neutral unbound presentation; the runtime smoke supplies actual editor/restart evidence.
9. **Legacy mention exception:** raw href/label attributes are retained; the scoped resolver prefers unique snapshot email matches, otherwise uses a batched exact current-contact read. Ambiguous/missing/malformed links stay neutral. Tests cover resolution without writes and rejection of stale responses after contact edits; runtime evidence covers actual editor round-trip and unchanged stored content.

No separate M2 interaction issue is raised. R1 is counted once.

## Summary

| Severity | Count |
| --- | ---: |
| critical | 0 |
| high | 1 |
| medium | 0 |
| minor | 0 |

## Verification commands and results

Cited the implementation evidence rather than duplicating shared-output test/build runs. The plan explicitly requests one integrated full suite, followed by bounded checks for later affected behavior. The full suite preceded the last bounded UI/mention refinement; the final focused selection, lint, typechecks and bundle cover that refinement. No claim is made that the full suite ran after those final source edits.

- `pnpm test --verbose` — recorded full canonical suite: **3,534 passed, 0 failed, 0 skipped**, 143.595 seconds. Inspected `/tmp/gristmill-337-full-suite-final.log`: ordinary 3,268, serial/native 66, compiler probes 200.
- `pnpm test --verbose test/cases/notes/integration/contactMentionJourney.test.ts test/cases/notes/integration/contactParticipantJourney.test.ts test/components/meetingResultsPanel.test.ts` — recorded final bounded run: **72 passed, 0 failed, 0 skipped**, 4.065 seconds. Inspected `/tmp/gristmill-337-final-focused.log`.
- The complete M1 consumer command in `implementation_progress.md` — recorded **382 passed, 0 failed, 0 skipped**, 14.907 seconds. Subsequent focused additions cover correction contracts, snapshot failure/retry/history cleanup and cancellation/new runs; their counts overlap.
- `pnpm run lint` — recorded pass after final source edits; inspected `/tmp/gristmill-337-final-lint.log`.
- `pnpm run typecheck` — recorded pass for all seven targets after final edits; inspected `/tmp/gristmill-337-final-types.log`.
- `pnpm run build:renderer` — recorded pass after final edits; inspected `/tmp/gristmill-337-final-build.log`. Existing large-chunk advisory remains.
- `pnpm run build:renderer:dev` — recorded pass before the disposable runtime smoke.
- `git diff --check` — ran during this audit; exit 0. Implementation also records staged whitespace checks.

R1 follows directly from the import insertion/default, migration predicate and freeze implementation; no real-profile or provider reproduction was needed. Existing passing tests do not cover that imported-Summary scenario.

## Plan gaps

None. The plan is self-contained for execution. R1 is an implementation/verification deviation, not an absent specification.

## Unrelated failures and residual notes

- No unrelated failing checks were reported or found in the cited final logs.
- The progress log discloses two runtime process deviations: the literal planned launch recipe did not honor the profile switch, and the first corrected disposable launch accidentally invoked capture. It records no observed default-profile migration, termination/removal of the disposable capture profile, and completion of the remaining smoke on a fresh confirmed synthetic profile. This is a historical verification restriction breach, not evidence of a current product defect; this audit did not repeat capture or inspect media.
- The corrected clean-profile command was `GRISTMILL_CHANNEL=development GRISTMILL_DEBUG_CDP=9337 pnpm start --user-data-dir=/tmp/gristmill-issue-337-m2-clean.2850CL`. Recorded restart evidence covers persisted contacts, mentions, frozen ordinary meeting context and correction links. The profiles were subsequently removed.
- No production package/install, real-profile migration/restore, real calendar/provider/Telegram operation or deliberate hardware verification was performed in this audit.
