# Issue 337 milestone audit — fix round 1

Status: pass

## Reviewed milestone commits and contract

- Original M1: `570cb3ca1`, `9980c202a`.
- Original M2: `47f100885`, `2558bfb34`.
- Fix: `ae0608ab7`; verification evidence: `6e1e6d1e0`.

Read the current `plan.md`, `implementation_progress.md`, prior `review-1.md` and `code-review-1.md`, the fix diff, current owning code and affected tests. The plan's orchestration block records the user's approved distinction: freeze every historical Granola import during migration; freeze new imports at insertion only when an actual Summary exists. This is the binding clarification for R1.

## M1 status: pass

R1 from `review-1.md` is resolved. The fix preserves the earlier ID, voice-history, correction and snapshot guarantees; it does not broaden ordinary provisional-note freezing.

### Scope and acceptance evidence

- **R1: new imported Summaries.** `parseGranolaCsv` derives `hasSummary` from the trimmed Summary cell and carries it on its insert-ready row. The existing preview/pending/run flow passes the row unchanged within main; it does not reconstruct or strip the property. `DatabaseManager.importNotes` inserts `participant_context_frozen` alongside the materialized roster in its existing transaction. A true flag sets `1`; notes-only input sets `0`.
- **R1: historical imports.** The conversion transaction now includes `source_file LIKE 'granola:%'` in the frozen-note predicate. It preserves the migration's stored snapshot fields and does not infer Summary provenance from text. Freezing all historical Granola imports is explicitly authorized by the recorded user decision, including historical notes-only imports whose provenance was discarded.
- **No overcorrection of first-processing enrichment.** The new persistence and processing tests import one Summary row and one notes-only row sharing a contact, edit that contact, and assert that the Summary roster remains original while the notes-only roster learns the current fields. The processing test verifies the actual saved LLM source snapshots for both cases. Existing learned-name, cancellation, retry, failure and freeze-rollback tests remain in the passing affected-consumer selection. A non-Granola provisional migration fixture remains unfrozen.
- **Restart and persisted history.** New import persistence tests reopen and retain the Summary roster. Historical startup tests edit a contact after migration, call the freeze boundary, reopen again, and verify retained IDs, roster and content, with foreign keys enabled and no violations. Existing migration tests continue to verify original voice-profile IDs, embeddings/sample counts, mapping/correction references and revisions, malformed entries, repeated migration and transactional rollback.
- **Related CR1 scope.** Column inspection handles the actual old/new schema mixture that startup creates when historical speaker tables were absent. It conditionally adds missing identity columns and migrates/drops the old speaker email column only when present. This remains a one-time schema conversion; no old contact mutation API or runtime identity fallback was restored. The speaker parent table stays in place, and the pre-commit `foreign_key_check` still throws on violations.
- **Boundary and consumer alignment.** The freeze flag remains internal to main persistence. The fix does not alter contact ID semantics, optional attributes, conflict handling, participant membership validation, correction provenance, voice-profile selection, current contact caches or snapshot read projections. No new helper layer, dependency, remote operation or automatic attribution policy was introduced.

### Issues

None. `review-1.md` R1 does not persist. The inspected CR1 fix also preserves the milestone invariants; its universal code-review disposition belongs to the parallel reviewer.

## M2 status: pass

The inherited imported-context guarantee is now met, and the permanent documentation matches the updated plan. The fix does not change the renderer journey.

### Scope and acceptance evidence

- `.memory-bank/architecture/note-writes.md` now describes both the user-approved historical Granola migration rule and the actual-Summary distinction for new imports. The previous contradictory import exception is gone.
- Participant creation/reuse, Telegram normalization/opening, atomic email conflicts, failed/pending draft retention, keyboard interactions, shared card refresh, ID mentions and the scoped legacy mention reader are unchanged by the fix. Their earlier mounted/runtime evidence remains applicable.
- The fix keeps imported saved content and frozen roster fields unchanged after later contact edits; notes-only imports retain the existing first-AI-processing behavior. This restores M2's inherited historical-context/documentation guarantee without reversing the earlier current-card versus frozen-context separation.
- No new loading, success, error or empty-state renderer branch was introduced. Import preview/run still use the existing main-owned pending state and response contract; the new flag is retained within that path and is not a renderer-editable note field.

### Issues

None.

## Summary

| Severity | Count |
| --- | ---: |
| critical | 0 |
| high | 0 |
| medium | 0 |
| minor | 0 |

## Verification commands and results

Cited the recorded affected-consumer runs after inspecting their logs and the tests they cover. The final follow-up strengthened migration/reopen assertions only; that changed test file was rerun. No additional test/build invocation was necessary for this audit under the plan's bounded fix-round verification rule.

- `pnpm test --verbose test/cases/notes/integration/contactIdentityMigration.test.ts test/cases/notes/integration/contactPersistence.test.ts test/helpers/meetingProcessing.test.ts test/helpers/granolaImport.test.ts test/helpers/granolaImportIpc.test.ts` — **175 passed, 0 failed, 0 skipped**, 11.723 seconds. Inspected `/tmp/gristmill-337-fix1-final-tests.log`. Includes the new actual-Summary/notes-only processing regression and existing rollback, voice history, membership and first-processing consumers.
- `pnpm test --verbose test/cases/notes/integration/contactIdentityMigration.test.ts` — final strengthened test file: **6 passed, 0 failed, 0 skipped**, 0.418 seconds. Inspected `/tmp/gristmill-337-fix1-migration-final.log`. Covers actual startup with both speaker tables absent, only profiles absent, and only corrections absent, plus migration history/FK/rollback checks.
- `pnpm run lint` — final recorded pass; inspected `/tmp/gristmill-337-fix1-lint-final.log`.
- `pnpm run typecheck:main` — recorded pass; inspected `/tmp/gristmill-337-fix1-main-types.log`.
- `pnpm run typecheck:tests` — recorded pass; inspected `/tmp/gristmill-337-fix1-test-types.log`.
- `git diff --check` — ran during this audit; exit 0.

The original integrated evidence remains as recorded in `implementation_progress.md` and assessed in `review-1.md`: `pnpm test --verbose` passed **3,534 tests, 0 failed/skipped**; final bounded renderer tests passed **72, 0 failed/skipped**; `pnpm run lint`, `pnpm run typecheck` and `pnpm run build:renderer` passed. Those broad checks preceded these main-only fixes and are not represented as fresh full-suite results. The fix-round scope and affected tests cover import, migration and processing; renderer output did not change.

## Plan gaps

None. The user decision recorded in the current plan resolves the historical-import provenance ambiguity. The fix follows that decision without extending it to new notes-only imports.

## Unrelated failures and residual notes

- No unrelated failures in the inspected final fix-round logs.
- The earlier failed launch and accidental disposable-profile capture remain disclosed in `implementation_progress.md` and `review-1.md`; this fix round did not repeat GUI, capture or provider operations.
- No real-profile migration/restore, production package/install, live calendar/provider/Telegram operation or hardware verification was performed in this audit. Synthetic migration, persistence and processing evidence establishes the reviewed contract; it is not real-profile or hardware validation.
