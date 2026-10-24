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
