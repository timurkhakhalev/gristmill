# Issue 337 — Contacts with optional email and Telegram (Implementation Plan)

## 1. Scope (what to implement)

Make local contacts independent of email. A user can create a named participant with optional email and Telegram, reuse the person in other meetings, and manually link a transcript speaker to that participant. Extend the existing contact card to edit details and open a unique Telegram username through `t.me`.

**Blast radius:** local contacts, `notes.participants` JSON, run speaker corrections, voice-profile contact associations, shared person profiles, calendar-to-note materialization, manual speaker assignment, Home participant displays, AI participant material, transcript export, and Notes CLI reads. Calendar-provider attendee payloads and Google People ingestion still use external email attributes. No Telegram API, authentication, or messages are involved.

**Criticality:** a broken migration can make contacts or speaker associations unavailable or associate the wrong person. Invalid participant handling can omit people from prompts or speaker-count hints. A failed edit must not partially change saved contact data. Audio, raw provider output, historical summaries, correction provenance/revisions, and voice embeddings must not change during identity migration.

**Rollback:** this is a one-way schema and reference migration; reverting code alone is insufficient after the migrated profile is opened. Before a real-profile upgrade, quit Gristmill and make a consistent copy of the entire profile, including SQLite state and managed files. No automatic backup is assumed or added. Recovery requires quitting the app, restoring that pre-upgrade profile and using its matching app version. This discards later edits/recordings unless those are separately preserved; an automatic reverse conversion cannot represent name-only contacts. Implementation and smoke checks use only disposable synthetic profiles, never the user's profile.

**Irreversible effects:** after the first successful migration commit, the profile no longer has the old email-keyed identity representation. Subsequent creation of contacts without email cannot be represented by the previous version. No external writes or deletion of audio/content are planned. Restoring a pre-upgrade copy cannot retain subsequent changes by itself.

Out of scope: separate address book, Telegram numeric IDs/account verification/chat import, automatic contact merging, new automatic attribution rules, capture/provider changes, new infrastructure/dependencies, dual identity paths, or compatibility shims.

## 2. Fixed decisions (must follow)

1. Follow `AGENTS.md`, `.memory-bank/steerings/quality.md`, `type-safety.md`, `documentation.md`, and `project-commands.md`. Use the canonical runner. All tests, examples, screenshots and metadata are fully synthetic.
2. Use an integer SQLite contact ID as the stable local identity. Preserve the existing name sources (`learned_name`, `people_name`, `display_name`) and photo, with the current name priority. New manual creation requires a non-blank name. Existing imported unnamed contacts remain usable; do not invent names for them.
3. Email is nullable and unique when present, with the existing trim/lowercase semantics. Names are not unique. Email edits or removal do not change contact ID or existing participant/speaker links.
4. Store nullable `telegram_username`, without `@` or outer whitespace. Accept input with or without a single leading `@`. Compare usernames without regard to ASCII letter case and enforce a unique database index with `COLLATE NOCASE`. Use `NULL` for an empty value; permit multiple nulls. Do not store numeric Telegram IDs.
5. A collision rejects the whole contact mutation, returns a typed conflict result, and keeps saved data unchanged. Do not merge contacts or transfer a username. A same-contact save/case edit is allowed. Clearing a username releases it. Validate input before mutation; username input must remain a single username, not an arbitrary URL or path. Do not add remote availability checks.
6. Build `https://t.me/<username>` from the saved username as one escaped URL segment and use `src/utils/externalLinks.ts`. Display `@username`; show no open action when absent. There is no direct `tg:` route.
7. Local participant selection, cache keys, contact mutations, run corrections and voice-profile contact associations use contact IDs. Distinguish a contact ID from the existing voice-profile ID and speaker ID. Email may remain in display/export/provider projections as an attribute, never as a second local link identity.
8. Keep calendar transport `CalendarAttendee` separate from the local note-participant schema. Local note participants carry `contactId` plus existing name/email/RSVP/self projection fields; email is nullable. Calendar event payloads need no local ID. Resolve calendar attendees to contacts at note persistence/materialization, matching normalized email. Preserve provider RSVP/self metadata and existing event association behavior.
9. Keep old email-to-ID mapping only inside the one-time migration. At runtime, no old request aliases, email-keyed profile cache, or email-based local speaker links remain. External calendar ingestion still resolves its email attribute to the canonical contact ID.
10. Manual correction accepts an optional participant contact ID and verifies membership in that run's owning note before any correction/name write. A missing, invalid or other-note contact ID is rejected without side effects. Keep Only this meeting as the default when the dialog opens. Do not change automatic naming priority, selected-transcript projection guards, raw artifacts, Summary text, or voice-profile training policy.
11. Freeze `draft.md`. Record later planning decisions here. Update permanent docs by feature; do not link them to `.tasks/`, edit past task folders, or rewrite accepted ADRs. This contact-schema change does not itself revise a recorded ADR.

## 3. Milestone index

| ID | Name | Depends on | Notes |
| --- | --- | --- | --- |
| M1 | Contact identity, persistence and consumer cutover | none | Migrate data and adapt all existing contact/participant/speaker consumers together. |
| M2 | Participant creation and Telegram card journey | M1 | Complete the user flow, feedback, documentation and integrated verification. |

## 4. Milestone details

### 4.1 M1 — Contact identity, persistence and consumer cutover

#### 4.1.1 Depends on

Depends on: none.

#### 4.1.2 Scope

Implement the complete data/contract cutover and keep existing app flows working with IDs. Telegram storage and conflict behavior belong here; the new form/card interaction belongs to M2. Adapt existing renderer call sites mechanically in this milestone rather than leaving a broken compile or temporary email API.

**Storage and migration:**

- In `src/helpers/database.ts`, change fresh contact DDL to an ID primary key, nullable unique normalized email, and nullable case-insensitive unique Telegram username. Keep name-source, photo and timestamp columns. Add a focused `src/helpers/contactIdentityMigration.ts` for the atomic one-time conversion, following the existing transaction-oriented migration style rather than adding a migration framework.
- Migrate contacts with stable IDs. Resolve references from valid existing note participant objects, `meeting_run_speaker_corrections.participant_email`, and `speaker_profiles.email`. When an email reference has no contact row, create the missing contact from the available email/name before linking it. A voice profile with no email keeps its existing name/embedding and can have no contact link. Do not match name-only records across notes by name.
- Add `contactId` to each valid local note participant, preserving its existing projection fields and order. Email-less named legacy participant objects get distinct contacts unless an existing explicit ID resolves them. Preserve malformed JSON and unrecognized entries as stored data rather than replacing them with an empty list; retain the current reader diagnostics/skipping policy for invalid entries. Migration tests must include valid entries beside invalid ones.
- Replace correction `participant_email` with nullable `participant_contact_id` and voice-profile email linkage with nullable `contact_id`. Preserve correction sources, platform, revisions, selected runs, mapping/profile IDs, embeddings and sample counts. Update fresh DDL and old schema-upgrade ordering, including `meetingPlatformMigration.ts`, so repeated startup does not recreate removed email-link columns or rebuild the wrong correction schema. Use foreign keys where links are relational and check their integrity after migration.
- Perform the identity conversion in one transaction. A failure leaves the old identity schema/data intact and startup reports failure; do not continue with a half-migrated graph. Recognize the final schema on reopening and do no further conversion. Do not rewrite audio, transcripts, summaries, immutable provider artifacts or saved generation snapshots just to add contact IDs.
- Put normalization, contact creation/update, unique constraints and canonical note-participant persistence under the main/database boundary. A contact update is atomic. Use typed outcomes for success, invalid/missing contact, email conflict and Telegram conflict. Use a single shared normalization rule for Telegram at the write boundary and renderer input handling.

**Contracts and write ingress:**

- Update `src/contracts/speakerProfiles.ts`, `src/preload/speakerBridge.ts` and `src/helpers/speakerIpcHandlers.ts`: concrete schemas for ID-based contact profiles/search/create/update and result errors. Replace old local email-keyed operations, and adapt consumers in the same milestone. Use positive integer ID validation; parse unknown IPC inputs and returned DTOs before business use.
- Define a shared local note-participant schema with `contactId` and nullable email, used by `src/utils/noteParticipants.ts` and the changed main boundary. Keep `src/contracts/calendar.ts` calendar transport semantics separate. Do not merely make calendar email nullable everywhere.
- Update `src/helpers/database.ts` note update/import insertion and `src/helpers/noteWriteService.ts` validation as needed so every persisted local participant reference is a known contact ID. Provider/import email data is converted at its ingestion boundary; an ordinary ID-based participant mutation rejects unknown IDs rather than manufacturing a contact.
- Adapt `src/helpers/meetingDetectionEngine.ts` (`_participantsWithNames`, note creation/linking), calendar manager database interfaces, and Granola persistence in `src/helpers/granolaImport.ts` to emit the new local participant shape. Keep Granola's import token interpretation unchanged; this task does not add a new import format. Calendar sync/People refresh must preserve IDs and manually saved name/Telegram values. Resynchronizing an existing linked event must retain its current note-link policy and must not replace a manually added name-only participant merely because it has no email.

**Speaker links and read consumers:**

- Update request/result schemas in `src/contracts/meetingProcessing.ts` and `meetingRecording.ts`, then `src/helpers/meetingProcessing.ts` validation, correction persistence and readers to use participant contact IDs. Validate note membership and persist the link/name update in the correction transaction. Keep the voice profile selection independent from participant selection.
- Cut over `speaker_profiles`, `setSpeakerMapping` and `attachSpeakerEmail` callers to contact associations, replacing the email-specific attachment operation rather than retaining it as an alias. Adapt `src/helpers/ipcHandlers.ts` profile propagation, `meetingSpeakerRoster.ts`, `meetingSpeakerRecognition.ts`, and their database interfaces without adding automatic attribution behavior.
- Update `src/helpers/noteTranscriptReader.ts` and `noteReadService.ts` to resolve associated contacts by ID and project nullable email/name. Keep the public CLI output shape and transcript aggregation semantics; do not invent placeholder emails or expose Telegram to AI/CLI as a new feature.
- Update participant preparation in `meetingPromptMaterial.ts`, `meetingProcessing.ts`, `transcriptFormatter.ts`, `src/utils/llmTranscript.ts` and `participants.ts` to preserve name-only participants. Keep provider/model participant projections as name/email hints, without promoting Telegram or contact IDs into identity evidence. Preserve existing Summary freshness comparisons over semantic participant fields so an ID-only migration does not falsely mark every result stale.
- Change `src/hooks/usePersonProfile.ts` cache/batching/refresh and `PersonAvatar.tsx`/`PersonName.tsx` callers to ID-based local lookup. Calendar preview surfaces can use the external attendee name/email until materialization; they must not create contacts during render. Adapt `NoteParticipants.tsx`, `MeetingResultsPanel.tsx`, `MeetingTranscriptChat.tsx`, `NoteEditor.tsx`, `RecentNotes.tsx`, `ComingUp.tsx` and `EventNoteDraft.tsx` to the appropriate local or calendar projection. Key local lists by contact ID and keep nullable-email handling safe.

##### Consumer surfaces impacted

Contact IPC, Notes IPC/write bridge, calendar and import materialization, participant lists and avatars, manual speaker dialogs and voice-profile attachment, recording speaker-count hints, Home previews, transcript export, AI context and public Notes CLI reads.

##### Pre-response/loading/success/error/empty states

Read requests keep the existing loading behavior and ignore responses after note/contact changes or unmount. Empty contact/profile lists are valid; absent email/Telegram is not a transport failure. Invalid IDs/requests and uniqueness conflicts fail before any partial mutation. A successful contact write refreshes all mounted cards for that contact. A storage error remains visible to the mutation caller. No participant can be silently dropped just because email is absent.

#### 4.1.3 Acceptance criteria

1. Fresh and migrated profiles have stable contact IDs; email and Telegram can both be null. Names alone do not merge people. Existing normalized-email ingestion resolves the same contact.
2. Telegram normalization, case-insensitive uniqueness, multiple absent values, same-contact edits, conflict atomicity and release on clearing are enforced in SQLite and through IPC.
3. Existing contact details, valid participant references, voice-profile associations and correction links survive migration and a second open. Invalid legacy participant payloads are not destroyed. Failure rolls back the identity conversion.
4. Existing app callers compile and use ID-based links without legacy request aliases. Calendar/People updates preserve contact IDs and manual Telegram data.
5. A correction for a note participant without email succeeds and survives reopening. A contact from another note or a missing contact is rejected without modifying the correction or remembered name.
6. CLI/export/AI material retains name-only participants and existing nullable-email output semantics. An ID-only migration preserves Summary freshness and correction history.

#### 4.1.4 Verification

Repository inspection, not a live app probe, establishes the current behavior: contacts are keyed by email, the renderer participant parser requires email, and run correction membership is checked by email. The checks below must prove the ID-based outcomes above.

- Add `test/cases/notes/unit/contactIdentity.test.ts` for shared normalization and empty/case variants; no remote calls.
- Add `test/cases/notes/integration/contactIdentityMigration.test.ts` using the temporary DB/electron-stub patterns in `test/helpers/harness/db.ts`. Seed the previous schema with synthetic contacts, note rosters, profiles, run corrections and Summary metadata; migrate/reopen and compare identities, metadata, bytes of unaffected content, foreign-key integrity and freshness. Cover orphan email references, unnamed contacts, name-only entries, malformed JSON/entries, repeated startup and an injected mid-conversion failure with old data/schema still intact. Register cleanup immediately.
- Add `test/cases/notes/integration/contactPersistence.test.ts` for name-only creation, distinct equal names, atomic edit conflicts, direct SQLite collision rejection, two attempted saves of the same normalized username, null multiplicity, case-only edits, clear/reuse, and reopen. Include email changes/removal without breaking existing links.
- Extend `test/helpers/calendarDatabase.test.ts`, the three calendar-manager tests, `meetingDetectionEngine.test.ts`, and `granolaImportIpc.test.ts` for email-to-ID ingress, Google People preservation and imported/calendar participants that resolve to known IDs. Assert that manually added ID participants survive linked-event updates.
- Extend `test/helpers/speakerIpc.test.ts`, `test/cases/recording/integration/main/speakerBridge.test.ts`, and replace `speakerEmailContract.test.ts` with `speakerContactContract.test.ts`. Assert parsed ID DTOs, typed conflict outcomes, valid/missing attachment, preserved embedding/sample counts, and rejected malformed inputs before side effects.
- Extend `test/helpers/meetingProcessing.test.ts`, `speakerRetroactiveMapping.test.ts`, `noteTranscriptReader.test.ts` and `noteReadService.test.ts` for same-note ID membership, rejection of another note's contact, name-only persistence, profile/contact distinction, selected-source projection and unchanged Summary text. Reuse existing provenance/revision tests.
- Adapt the existing `test/utils/participants.test.ts`, `calendarAttendees.test.ts`, `llmTranscript.test.ts`, `test/helpers/transcriptFormatter.test.ts` and participant component fixtures to the separated local/calendar contracts. Keep calendar previews non-mutating and speaker counts unchanged for equivalent rosters.
- Focused new persistence run: `pnpm test -- test/cases/notes/unit/contactIdentity.test.ts test/cases/notes/integration/contactIdentityMigration.test.ts test/cases/notes/integration/contactPersistence.test.ts`.
- Consumer regression run: `pnpm test -- test/helpers/calendarDatabase.test.ts test/helpers/googleCalendarManager.test.ts test/helpers/microsoftCalendarManager.test.ts test/helpers/appleCalendarManager.test.ts test/helpers/meetingDetectionEngine.test.ts test/helpers/granolaImportIpc.test.ts test/helpers/speakerIpc.test.ts test/cases/recording/integration/main/speakerBridge.test.ts test/cases/recording/integration/speakerContactContract.test.ts test/helpers/meetingProcessing.test.ts test/helpers/speakerRetroactiveMapping.test.ts test/helpers/noteTranscriptReader.test.ts test/helpers/noteReadService.test.ts test/utils/participants.test.ts test/utils/calendarAttendees.test.ts test/utils/llmTranscript.test.ts test/helpers/transcriptFormatter.test.ts test/components/noteParticipantsMeetingCard.test.ts test/components/meetingResultsPanel.test.ts`.
- Run `pnpm run lint` and `pnpm run typecheck` after the cutover, including existing speaker/calendar/database type probes in the final canonical suite. M2 proves the new interactive journey; M1 must already pass the persistence, contract and existing-consumer checks.

### 4.2 M2 — Participant creation and Telegram card journey

#### 4.2.1 Depends on

Depends on: M1.

#### 4.2.2 Scope

- In `src/components/notes/NoteParticipants.tsx`, keep the existing participant entry point. Search/select existing contacts or explicitly create a contact with a required name and optional email/Telegram. Do not interpret every string containing `@` as an email; use labelled form fields. Selecting an existing contact uses its ID and prevents adding that same contact twice to one note. Equal names remain separate choices.
- Extend the current card editing UI to edit contact details, including optional email and Telegram, through M1's canonical mutation. Keep the card open while editing, preserve draft values on failed save, and support keyboard focus, Enter/save and Escape/cancel. Use the existing name-source behavior; a new name-only contact must retain its required name.
- Show `@username` with edit/clear and external-open actions. Empty Telegram shows an add affordance for editable cards. Email-less participants have no blank email row, mail domain crash or fake address; place them in an appropriate existing list group without making up a domain.
- Refresh shared profiles after a confirmed save so the same contact's other meeting cards show the new details. A failed save leaves the saved view unchanged. Handle contact-save and participant-add failures distinctly; if contact creation succeeds but note persistence fails, report that failure and permit selecting the already saved contact on retry instead of creating a duplicate.
- Complete the manual speaker participant picker for name-only contacts and use participant IDs as option values. Keep the existing default, provenance and Summary-staleness behavior; do not identify people solely by equal names or Telegram.
- Update UI strings in all existing `src/locales/*/translation.json` locales. Follow current component styling; no new UI library or separate address book.
- Update `.memory-bank/product/user-journeys/notes.md` with create/select, optional fields, contact editing, uniqueness conflict and link opening. Update `user-journeys/speakers.md` to describe participant selection independent of email. Update `.memory-bank/architecture/speaker-evidence.md` for ID membership validation and manual links; update `architecture/note-writes.md` to describe canonical participant persistence and ingestion boundaries. Keep the distinction between calendar hints and confirmed identity explicit.

##### Consumer surfaces impacted

Meeting participant search/create/list/card, shared person displays, Results and transcript speaker pickers, localized validation/conflict feedback, external-link opening.

##### Pre-response/loading/success/error/empty states

- Before save: labelled required name and optional fields, edit draft isolated from saved values.
- Loading: show a pending save and prevent duplicate submissions. Ignore stale search results after query/note changes.
- Success: display the saved normalized handle, refresh contact displays, and retain the stable participant link.
- Error: show field-relevant conflict feedback or a storage error; keep the input and card available for correction/retry. Do not close the card or show an unconfirmed edit as saved.
- Empty: a name-only contact is a complete usable participant; empty Telegram has no link and permits adding a username. No search results offers explicit contact creation.

#### 4.2.3 Acceptance criteria

1. The user can create a participant with only a name, reuse it in a second note, and link a transcript speaker to it without email.
2. Adding, editing and clearing Telegram works with/without `@`; the card displays exactly one leading `@`. A conflicting username, including different case, shows an error and preserves all saved contact fields.
3. Clicking the saved handle invokes the corresponding HTTPS `t.me` link through the existing helper. Empty Telegram has no open action.
4. Editing or removing email leaves the same contact and participant/speaker associations intact. Shared cards refresh after successful changes, including after reopen/restart.
5. Card focus/edit lifecycle and errors remain usable by keyboard. A pending or failed save cannot silently lose the user's input.
6. Documentation describes the delivered behavior. Existing calendar, speaker correction, CLI, transcript and Summary behavior passes the integrated regression suite.

#### 4.2.4 Verification

The current card only edits the contact name and shows email; participant creation requires email (inferred from inspected code). Prove the complete creation/edit/conflict/link/correction journey at renderer behavior level and in one isolated runtime smoke check.

- Extend `test/components/noteParticipantsMeetingCard.test.ts` and `meetingResultsPanel.test.ts` for ID-based read/selection fixtures and nullable email. Add `test/cases/notes/integration/contactParticipantJourney.test.ts` using `test/lib/rendererTestHarness.ts` and the existing mounted interaction harness patterns to exercise create/select, add/remove, edit/clear, failed save preservation, stale async results, cross-card refresh and external-link invocation. SSR-only markup checks cannot establish event/save behavior; do not add CSS/snapshot assertions.
- Run `pnpm test -- test/components/noteParticipantsMeetingCard.test.ts test/components/meetingResultsPanel.test.ts test/cases/notes/integration/contactParticipantJourney.test.ts` for the changed interactions.
- Run the shared final checks below once after M2 integration. Do not repeat a full suite for each review round unless behavior changes or an unresolved gap requires it.
- For GUI verification, first run `pnpm run build:renderer:dev`, then `pnpm start -- --user-data-dir=/tmp/gristmill-issue-337-<unique-suffix>` with a new disposable profile. Confirm the script honors that explicit profile before interacting. Use synthetic notes/recordings, no live calendar accounts, provider keys, microphone or Telegram account lookup.
- In the app: create a name-only participant; add `@sample_contact337`; reuse the person in a second note; edit from one card and see the shared change; try the same handle on another contact with different case; verify error and saved-state preservation; clear/reassign it; select the name-only participant in manual correction on a synthetic transcript; restart with the same disposable profile and verify details/links. Check focus, Enter/save, Escape/cancel, pending and error states.
- Verify external-link construction with the mocked helper in the interaction test; the runtime smoke may open the synthetic username URL but does not prove that a Telegram account exists. No real Telegram message or provider operation is part of verification.

## 5. Shared verification commands

Run from the repository root. Planned checks are not reports of passing implementation.

- `git diff --check` — whitespace for all changed files.
- `pnpm run lint` — lint the affected production source under the root policy.
- `pnpm run typecheck` — all compiler targets, including renderer, tests and shared consumer contracts.
- `pnpm test` — full canonical suite after final integration, because the identity migration touches shared storage, calendar, notes and recording consumers. Includes platform graph checks and compile-time probes. Report pass/fail/skip counts and unavailable checks honestly.
- `pnpm run build:renderer` — verify the changed renderer bundles.

Serialize tests, builds and native runtime preparation that share dependencies/output. Do not run install or native rebuild alongside them. Run focused failures first and preserve cleanup/isolation. Do not build/install a production app or migrate a real profile as part of this task. Inspect documentation paths and referenced commands; do not add a separate docs report or test infrastructure.
