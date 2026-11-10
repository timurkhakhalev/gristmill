# Issue 337 — Code review 1

Status: changes required.

Reviewed implementation commits `570cb3ca1` and `47f100885`, with `develop...HEAD` for task requirements and documentation. Requirements: `.tasks/issue-337/plan.md`. Verification basis: `.tasks/issue-337/implementation_progress.md` and the referenced final check logs.

## Findings

### CR1 — High: upgrading a profile without speaker tables fails at startup

- **Location:** `src/helpers/contactIdentityMigration.ts:34–36`; related startup DDL at `src/helpers/database.ts:1179–1199`.
- **Violated contract:** M1 requires fresh and migrated profiles to open with stable contact IDs, including correct old-schema upgrade ordering. The profile migration must preserve access to existing contacts and notes.
- **Trigger:** open an existing email-keyed profile from before `speaker_profiles` or `meeting_run_speaker_corrections` existed. This is a real historical schema: commit `82cee8a76` introduced email-keyed contacts without either speaker table; durable meeting corrections were introduced later in `bd0d603b8`.
- **Evidence:** startup uses `CREATE TABLE IF NOT EXISTS`, so the existing contacts table stays email-keyed while a missing speaker table is created with `contact_id` or `participant_contact_id` already present. `migrateContactIdentity` only checks the contacts table, then unconditionally adds both columns. An in-memory SQLite reproduction extracted and executed the current startup table DDL and the migration's first SQL block. It produced `duplicate column name: contact_id`. The contacts table remained email-keyed after rollback and foreign-key enforcement stayed enabled.
- **Mechanism:** the migration assumes all participating tables have the previous schema together. Startup can instead produce a mixture of an old contacts table and newly created final-schema speaker tables. The unconditional `ALTER TABLE ... ADD COLUMN` then fails. If only the corrections table was absent, the equivalent collision occurs for `participant_contact_id`. `DatabaseManager.initDatabase` closes the database and rethrows initialization errors.
- **Impact:** affected existing profiles cannot open in the upgraded application. Retrying startup repeats the failure; the rollback protects the old contact rows but does not restore application access. Current migration tests create both old speaker tables up front and therefore do not cover this upgrade path.

## Verification

Reused the recorded integrated checks rather than repeating them:

- `pnpm test --verbose`: final log confirms 3,534 passed, 0 failed, 0 skipped across the three phases; total 143.595 seconds.
- Final participant/mention/Results selection: 72 passed, 0 failed, 0 skipped; total 4.065 seconds.
- Final lint, all-target typecheck and renderer build logs are consistent with the recorded successful results. The renderer build retains its chunk-size advisory.
- The progress record documents the disposable-profile GUI journeys and restart evidence, including the failed initial launch and accidental capture deviation. These are implementation evidence, not checks repeated in this review.

Checks performed in this review:

- `git diff --check develop...HEAD`: passed.
- `python3` with an in-memory SQLite database and SQL extracted from the two implementation files: confirmed CR1 with synthetic data only. This isolates the schema-ordering failure; it is not a full Electron startup test.
- Traced contact mutation and IPC parsing, roster persistence and freeze, correction membership and historical projections, calendar/import ingress, shared profile caching, participant forms/cards and mention binding/serialization against their callers and tests.

No application tests, builds, real profiles, provider calls, calendar accounts, Telegram accounts or capture operations were run during this review. No source files were changed.

## Assessment

Counts: critical 0, high 1, medium 0, minor 0.

The inspected change is not merge-ready because CR1 blocks startup for an existing profile schema. The existing broad green suite does not establish this older-profile upgrade path.
