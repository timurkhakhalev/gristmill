# Issue 337 — Contacts with optional email and Telegram (Draft)

Source: [issue #337](https://github.com/timurkhakhalev/gristmill/issues/337) and the confirmed brainstorm on 2026-10-24. The agreed scope below extends the original email-based contact-card request.

## 1. Goal

Let a user add a person to a meeting, link a transcript speaker to that person, and return to their Telegram conversation, even when the person has no email address.

## 2. Scope

- Give each local contact a stable ID that does not depend on email or Telegram.
- Require a name when the user creates a contact. Email and Telegram are optional; a contact can have neither.
- Extend the existing meeting participant flow to select a saved contact or create one with these fields.
- Extend the existing contact card to edit contact details and add, change, or clear Telegram.
- Use the same saved contact across meetings. Contact edits appear wherever that contact is shown.
- Allow manual speaker correction to select a participant without email and retain the contact link.
- Preserve existing contacts, meeting participants, and speaker links when moving local contact identity to IDs.

## 3. Non-goals

- A separate address book or contact management section outside meeting participants.
- Telegram authentication, numeric Telegram IDs, account lookup, chat import, messages, or automatic call detection.
- Automatic contact merging or speaker identity inference from a Telegram username or a matching name.
- Changes to audio capture, transcription providers, or automatic speaker attribution policy.
- Compatibility shims or parallel email-based and ID-based local identity paths after the data migration.

## 4. Constraints and fixed decisions

- Keep contact data in the existing local SQLite storage and use the existing main/preload/renderer boundaries.
- Email remains an optional, unique contact attribute. Existing calendar contacts continue to be found by their normalized email. The local contact ID is the identity used for contact links.
- Store Telegram usernames, never numeric Telegram IDs. Trim outer whitespace and remove the optional leading `@` before storage. Display a saved value with one leading `@`.
- Telegram usernames are unique across contacts without regard to letter case. Enforce this in the database as well as at the save boundary.
- Empty Telegram values mean no username and may occur on any number of contacts.
- A username conflict shows a clear error and keeps the previously saved contact data. It does not merge contacts or transfer the username.
- Clearing a username makes it available to another contact.
- Open the corresponding `https://t.me/<username>` link through the existing external-link mechanism.
- Names are not unique. Equal names do not automatically identify or merge people.
- Imported existing contacts must remain usable even if their stored name is absent. Requiring a name for new manual creation must not discard or block existing data.
- Calendar attendee data can still contain email addresses. Replacing local identity must preserve calendar synchronization and existing event associations.

## 5. User journey and visible behavior

1. Open a meeting note and its participant list.
2. Find and select an existing contact, or create a contact by entering a name and optional email and Telegram username.
3. The person appears as a participant, including when both optional fields are empty. Selecting that saved contact in another meeting refers to the same person.
4. Open the participant's contact card. Add, edit, or clear Telegram. Input accepts the username with or without `@`; the saved card shows `@username`.
5. If another contact owns the username, saving shows an error and leaves saved data unchanged. The user can correct the input.
6. Click the saved handle to open its `t.me` link. No link is shown for an empty value.
7. Open manual speaker correction and select this meeting participant, including a participant with no email. Save and retain the contact association.
8. Reopen the note or restart the app. Contact details and participant/speaker links remain available. Editing one contact is reflected across its meeting cards.

Existing speaker correction rules still apply: participants are candidates, a manual selection is required, raw provider output is preserved, and a correction does not rewrite an existing Summary.

## 6. Testing expectations

Use the existing test runner and synthetic temporary profiles/databases under the quality steering.

- Unit tests for Telegram normalization and case-insensitive comparison, including empty values and inputs with or without `@`.
- Persistence and migration integration tests: preserve existing contact data and participant/speaker links; create contacts with a name only; reopen the database and verify stable IDs and optional fields.
- Persistence tests for username conflicts, including a case-only collision, multiple empty usernames, unchanged saved data after a failed edit, and reuse after clearing a username.
- IPC/preload contract tests for optional attributes, contact IDs, validation, and conflict results. Verify that the database protection cannot be bypassed by a second save path.
- Participant and speaker correction behavior tests: add/select a contact without email, distinguish people with the same name, reuse a contact across notes, and retain a manual speaker link without email.
- Renderer tests for card editing, conflict feedback, consistent `@` display, profile refresh across cards, and the constructed external link.
- Inspect the affected UI in an isolated app profile: create a name-only participant, edit Telegram, handle a conflict, navigate the link, and link a speaker. Use keyboard-accessible controls and keep the card open during editing.
- Run lint and typechecks for affected boundaries and consumers. Choose the final check scope from the implementation and direct consumers; use the full suite if the migration impact cannot be bounded.

Draft-stage checks cover document accuracy and whitespace only. Application tests belong to implementation.

## 7. Documentation updates

Update the following documents with the implementation:

- `.memory-bank/product/user-journeys/notes.md`: creating and reusing participants without email; editing Telegram and opening the link.
- `.memory-bank/product/user-journeys/speakers.md`: manual speaker linking to a participant with or without email.
- `.memory-bank/architecture/speaker-evidence.md`: contact-ID links and manual correction constraints, replacing the current email-only description.

Keep documentation in English and record durable behavior rather than migration logs.

## 8. Acceptance criteria

1. A user can create a named contact with no email and no Telegram through meeting participants and reuse that contact in another meeting.
2. Email and Telegram can be absent without fake email addresses or placeholder usernames.
3. A user can add, edit, and remove Telegram in the contact card. Both `username` and `@username` inputs produce a stored value without `@` and a displayed value with `@`.
4. Two contacts cannot own the same Telegram username, including case variants. A conflicting save shows an error and leaves saved contact data unchanged.
5. Any number of contacts can have no Telegram username. Clearing a username lets another contact use it.
6. Clicking a saved handle opens the corresponding `t.me` link through the existing external-link path.
7. A user can manually link a transcript speaker to a meeting participant without email, and the saved link survives reopening and restart.
8. Contact details and participant associations survive restart, and edits to a shared contact appear across its meeting cards.
9. Existing contacts, calendar participants, speaker links, and their associated content remain usable after migration. Equal names do not cause automatic merging.

## 9. Resolved brainstorm decisions

- Both email and Telegram are optional; name-only contacts are supported.
- Creation stays inside meeting participants; no separate address book is added.
- Manual speaker linking includes participants without email.
- Telegram links use HTTPS `t.me`, not an application-specific protocol.
- Telegram usernames are stored without `@` and must be unique without regard to case. Conflicts are rejected rather than merged.

## 10. Notes for planning

The current `contacts` table uses email as its primary key. `NoteParticipants.tsx`, `usePersonProfile.ts`, `speakerProfiles.ts`, the speaker bridge/handlers, and manual correction contracts also use email for lookup or links. Plan must trace the affected storage and consumers before choosing migration steps. Calendar transport fields must not be confused with local contact identity.

Reuse the existing participant card, shared contact-profile refresh, external-link helper, and manual correction flow. Add only the changes needed for optional email, stable contact links, and the agreed Telegram behavior.
