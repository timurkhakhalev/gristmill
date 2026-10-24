# Implementation progress

## M1 — Contact identity, persistence and consumer cutover

Status: done

Implemented stable contact IDs, optional email and Telegram, atomic typed contact mutations, ID-based IPC/profile caches, local participant persistence, speaker links and snapshot-based CLI/export reads. The migration replaces contacts atomically, alters voice profiles in place, preserves historical snapshot emails and malformed entries, and checks foreign keys before commit. First AI processing freezes current learned/People/invite names once; later edits, failure, cancellation, retry, restart, new runs and history cleanup retain that context.

Preserved constraints: no real profile access or production app installation; no raw audio/provider/Summary artifact rewrites; no email mutation aliases; no matching name-only people by name; independent voice-profile selection; existing correction provenance and selected-source projection. Calendar previews remain external attributes until materialization. Granola token interpretation is unchanged: its email attributes become IDs at import persistence. The current Granola format does not distinguish Summary content from ordinary note content; actual saved Summary/LLM snapshot metadata supplies the historical migration freeze signal.

Issues resolved: old contract fixtures used email links and now use contact IDs. The freeze preserves malformed rosters so existing diagnostics and eligible Summary processing remain available. Historical nonempty emails remain verbatim in migration, because changing their case can change snapshot freshness. A trigger-induced freeze failure rolls back and starts no model call. The first verbose command used an unsupported extra `--`; the corrected canonical command succeeded.

### Verification

- `pnpm test -- test/cases/notes/unit/contactIdentity.test.ts test/cases/notes/integration/contactIdentityMigration.test.ts test/cases/notes/integration/contactPersistence.test.ts` — passed. Covers normalization, constraints/conflicts, distinct name-only contacts, atomic rollback, FK enforcement, voice references, malformed legacy data and reopening.
- The following complete M1 selection passed: **382 tests, 0 failures, 0 skips**, 14.907 seconds wall time including preparation/build. This is focused consumer evidence, not a full application suite.

```sh
pnpm test --verbose test/cases/notes/unit/contactIdentity.test.ts test/cases/notes/integration/contactIdentityMigration.test.ts test/cases/notes/integration/contactPersistence.test.ts test/helpers/calendarDatabase.test.ts test/helpers/googleCalendarManager.test.ts test/helpers/microsoftCalendarManager.test.ts test/helpers/appleCalendarManager.test.ts test/helpers/meetingDetectionEngine.test.ts test/helpers/granolaImportIpc.test.ts test/helpers/speakerIpc.test.ts test/cases/recording/integration/main/speakerBridge.test.ts test/cases/recording/integration/speakerContactContract.test.ts test/helpers/meetingProcessing.test.ts test/helpers/speakerRetroactiveMapping.test.ts test/helpers/noteTranscriptReader.test.ts test/helpers/noteReadService.test.ts test/cases/notes/integration/noteReadServiceFixtures.test.ts test/utils/participants.test.ts test/utils/calendarAttendees.test.ts test/utils/llmTranscript.test.ts test/helpers/transcriptFormatter.test.ts test/components/noteParticipantsMeetingCard.test.ts test/components/meetingResultsPanel.test.ts test/services/meetingResults.test.ts test/cases/recording/unit/meetingPlatformContract.test.ts test/helpers/meetingSpeakerReconcile.test.ts
```

- `pnpm test --verbose test/cases/recording/integration/main/speakerBridge.test.ts test/cases/recording/integration/speakerContactContract.test.ts test/helpers/meetingProcessing.test.ts` — **117 passed, 0 failed/skipped**, 11.634 seconds. Adds concrete mutation/result parsing, typed IPC conflicts and missing-contact attachment checks. Counts overlap with the complete selection.
- `pnpm test --verbose test/helpers/meetingProcessing.test.ts test/cases/notes/integration/contactPersistence.test.ts` — **113 passed, 0 failed/skipped**, 10.264 seconds. Adds provider failure/restart/retry/history removal plus frozen CLI/export assertions.
- `pnpm test --verbose test/helpers/meetingProcessing.test.ts` — **111 passed, 0 failed/skipped**, 10.327 seconds after adding cancellation/new-run checks.
- `pnpm run lint` — passed.
- `pnpm run typecheck` — all targets passed. After final test-only changes, `pnpm run typecheck:tests` passed; after an equivalent renderer expression cleanup, `pnpm run typecheck:renderer` passed.
- `git diff --check` and staged whitespace check — passed.

Consumer behavior validated: name-only persistence and correction, same-note membership, rejected outsider/missing contacts without writes, normalized optional attributes, typed conflict responses, valid empty profile lists, current shared contact reads, historical snapshot projections and first-processing freeze recovery. M2 owns new forms/card error-state interactions, mention journeys, permanent documentation and the isolated runtime smoke.

Commits: `570cb3ca1` — M1 implementation and regression tests. This progress record is committed separately.

Not run: the full canonical suite, renderer production bundle and GUI/hardware/provider operations; the plan schedules final integrated checks and isolated UI smoke after M2. No M2 implementation was started.

## M2 — Participant creation and Telegram card journey

Status: done

Contract sync: M1 supplies stable IDs, nullable normalized attributes, typed atomic mutations and frozen processing snapshots. M2 adds the renderer journey and read-only mention association without changing identity, correction provenance, voice selection or historical Summary/roster semantics.

Delivered shared create/edit forms with retained drafts, pending guards, keyboard save/cancel, explicit conflict selection and ID reuse; optional Telegram cards and HTTPS link invocation; current shared profile refresh; distinct equal-name ID mentions; immutable legacy href/label round-trips and snapshot-first batched exact-email resolution. Updated all locale copies and five existing user-journey/architecture documents. A final regression covers contact edits during pending legacy resolution: invalidation restarts the lookup and rejects stale responses.

Preserved invariants: contact edits do not rewrite note rosters, saved mention labels, correction links, raw artifacts or frozen processing context. Unbound/ambiguous names stay unbound. No association transfer or merge is offered. Existing correction scope defaults to Only this meeting. Name-only correction labels omit a null email suffix.

### Verification

- `pnpm test --verbose` — full canonical suite **3,534 passed, 0 failed, 0 skipped**, 143.595 seconds (`/tmp/gristmill-337-full-suite-final.log`). Includes ordinary 3,268, serial/native 66 and type probes 200. The first integrated run exposed seven issues; fixes preserved empty-string no-roster updates, carried contact IDs through the old CHECK-table migration, and updated old email fixtures/field-direction expectations. No unrelated product behavior was changed.
- After bounded final UI/mention refinements, `pnpm test --verbose test/cases/notes/integration/contactMentionJourney.test.ts test/cases/notes/integration/contactParticipantJourney.test.ts test/components/meetingResultsPanel.test.ts` — **72 passed, 0 failed/skipped**, 4.065 seconds (`/tmp/gristmill-337-final-focused.log`). The full suite preceded the final pending-lookup regression; it was not rerun unnecessarily.
- Earlier focused mention, speaker IPC/bridge, participant and manual-correction selections passed; the final integrated suite includes these tests. Earlier final-UI selection: 66 passed, 0 failed/skipped.
- `pnpm run lint` — passed after final source edits (`/tmp/gristmill-337-final-lint.log`).
- `pnpm run typecheck` — all targets passed after final edits (`/tmp/gristmill-337-final-types.log`).
- `pnpm run build:renderer` — passed after final edits (`/tmp/gristmill-337-final-build.log`); existing large-chunk advisory remains.
- `pnpm run build:renderer:dev` — passed before GUI smoke (`/tmp/gristmill-337-renderer-dev-build.log`).
- Relevant formatting checks and `git diff --check`/staged whitespace checks — passed. Final test/type/lint/build processes all exited 0. No install/native rebuild ran during checks.

### Disposable-profile runtime smoke and deviations

The literal planned `pnpm start -- --user-data-dir=...` recipe forwards an extra separator and did not honor the profile switch. Before UI interaction, the requested directory remained empty and CDP was unavailable. That failed launch read the default development `.env` (two entries; values were neither inspected nor recorded); no UI interaction or database migration was observed. The supported corrected recipe is:

```sh
GRISTMILL_CHANNEL=development GRISTMILL_DEBUG_CDP=9337 pnpm start --user-data-dir=/tmp/gristmill-issue-337-m2-clean.2850CL
```

The first corrected disposable launch used `/tmp/gristmill-issue-337-m2.Foblni`, whose database location was confirmed before interaction. I then incorrectly clicked Home's New note control, which starts capture. A companion window appeared; cancellation returned unsuccessful. I verified the owned Electron process arguments and terminated it, then deleted that entire disposable profile without examining media. This was an accidental capture/microphone operation and a deviation from the planned no-microphone smoke restriction. It was immediately disclosed to the orchestrator. No claim of zero microphone operation is made.

All remaining smoke work used a fresh confirmed disposable profile, `/tmp/gristmill-issue-337-m2-clean.2850CL`, synthetic notes created through note IPC, and generated silent PCM fixtures. Capture controls were avoided thereafter. No live calendar account, provider call, Telegram lookup/message or production installation was used. The corrected recipe and deviations were reported; plan text was left untouched as instructed.

Clean-profile runtime results:

- Created a name-only contact with Enter; added `@sample_contact337`; reused its ID in a second note. Invalid host-only Telegram retained its draft. Escape canceled an edit. Shared card changes appeared without rewriting the first note's snapshot.
- Creating a second contact with case-insensitive conflicting Telegram showed an error and preserved saved state/draft. Clearing email and Telegram kept the first ID; assigning the released handle to another contact succeeded and displayed exactly one `@`. Mounted tests cover empty-handle no-action and helper invocation; no account lookup was performed.
- Selected two equal-name/email-less contacts through the actual @ picker. Stored Markdown contained distinct `mention:contact:1` and `mention:contact:2` links. Reload/restart preserved both bindings and original labels.
- Opened synthetic old-email and unbound mentions. The old-email snapshot resolved the current avatar; unbound stayed neutral. Actual editor HTML/Markdown round-trip preserved raw hrefs/labels, content and updated_at. Contact edits changed current metadata without rewriting saved Markdown.
- Seeded a complete synthetic recording/run with generated silence and saved Summary/transcript artifacts, without a model call. Actual manual speaker correction selected the name-only contact, retaining ID 2 and null email; default scope was Only this meeting. Changed another contact after freeze: the entire stored note stayed identical and Summary freshness stayed unchanged (already stale solely from the explicit speaker correction).
- Two subsequent restarts preserved contact details, frozen snapshot, legacy hrefs, distinct mention IDs and the name-only manual correction. Final evidence: `/tmp/gristmill-337-final-restart-evidence.json`. Synthetic card/chip screenshots were visually inspected in `/tmp`; no real user data was put in repository artifacts.
- The owned final Electron process was verified by its full disposable-profile arguments, terminated, and the clean profile removed. CDP port 9337 has no listener. Both disposable profiles are deleted.

Not run: a production app build/install, real-profile migration/rollback, real Telegram account lookup/message, real calendar/provider operations, or a deliberate microphone/hardware test. Pending/failure/stale-request interactions are covered by mounted renderer tests; runtime covers the successful/error/restart journey.

Commits: `47f100885` — M2 implementation, tests and permanent docs. This evidence record is committed separately.

## Review fix round 1 — R1 and CR1

Status: done

Contract sync: the review findings require imported-Summary context preservation and startup support for historical email-keyed profiles whose speaker tables did not yet exist. Existing stable IDs, voice-history foreign keys, rollback, saved text and processing snapshots remain binding. Historical Granola content cannot identify Summary versus user notes: the old importer combined both cells. The user resolved that ambiguity by authorizing migration to freeze **all** historical `granola:` imports; new imports freeze only when the actual Summary cell is nonempty. This decision supersedes the narrower import statement in the earlier M1 evidence above.

R1: the parser now carries an explicit `hasSummary` flag through the existing main-owned pending import rows. Insertion atomically captures that flag as `participant_context_frozen` alongside the materialized roster. Notes-only imports remain provisional. Migration marks every old Granola source frozen without rewriting stored content or snapshot fields. Updated the permanent note-write contract. No attempt was made to infer provenance from content text or to recover discarded data.

CR1: migration checks the actual speaker/correction/note columns before adding identity/freeze fields, and only migrates/drops speaker email when that old column exists. This handles startup's mixture of old contacts and newly created final-schema tables. The speaker table stays in place; existing voice IDs/references and transactional FK checks remain intact.

Verification (synthetic temporary databases/recording fixtures only):

- `pnpm test --verbose test/cases/notes/integration/contactIdentityMigration.test.ts test/cases/notes/integration/contactPersistence.test.ts test/helpers/meetingProcessing.test.ts test/helpers/granolaImport.test.ts test/helpers/granolaImportIpc.test.ts` — **175 passed, 0 failed, 0 skipped**, 11.723 seconds (`/tmp/gristmill-337-fix1-final-tests.log`). Covers actual Summary/notes-only parser flags, import insertion/reopen, processing source snapshots after later contact edits, historical freeze flags, existing rollback/integrity/voice history, import IPC and existing first-processing failure/cancellation/retry consumers.
- After strengthening historical reopen assertions, `pnpm test --verbose test/cases/notes/integration/contactIdentityMigration.test.ts` — **6 passed, 0 failed, 0 skipped**, 0.418 seconds (`/tmp/gristmill-337-fix1-migration-final.log`). Actual DatabaseManager startup is exercised with both speaker tables absent, only profiles absent, and only corrections absent; reopen preserves IDs/FKs, and historical Granola context remains frozen after a contact edit. The remaining fixture covers a provisional non-Granola note.
- `pnpm run lint` — final pass (`/tmp/gristmill-337-fix1-lint-final.log`). Earlier attempts identified spacing-policy violations; these were corrected without behavior changes.
- `pnpm run typecheck:main` and `pnpm run typecheck:tests` — passed (`/tmp/gristmill-337-fix1-main-types.log`, `/tmp/gristmill-337-fix1-test-types.log`).
- Relevant `pnpm exec oxfmt --check ...`, `git diff --check` and staged whitespace check — passed.

Not rerun: full canonical suite, renderer build, GUI/capture or provider operations. These bounded changes affect main import/migration/processing paths; the focused checks cover those consumers. Prior GUI deviations remain disclosed above. No real profiles were accessed. Plan/table and prior review reports were not edited by the implementer.

Commits: `ae0608ab7` — both review fixes, regressions and permanent documentation; this progress update is committed separately.
