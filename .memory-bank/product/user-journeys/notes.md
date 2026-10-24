# Notes and folders

As a Gristmill user, I want to write notes, keep them in folders and find them again.

## Entry points

- **Gristmill app → sidebar → Notes** — folders and notes.
- **Gristmill app → top bar → Search** or **⌘K** — search notes and transcripts.
- **Keyboard: ⌘N** — new note. **⌘⇧N** — new folder.
- **macOS menu bar → Gristmill tray icon → New Note** — new note from any app.

## Paths

### Write a note

1. Click **New note** in the Notes tree menu, press ⌘N, or click **New Note** in the tray.
2. Type the title in **Note title** and the text below it.
3. Gristmill saves the note automatically. The editor shows **Saving**, then **Saved**.
4. If the save fails, Gristmill shows **Note was not saved. Your edits are still available.** Click **Retry**.

### Organize notes in folders

1. The Notes tree starts with a **Personal** folder. Notes without a folder appear directly under **Notes**.
2. To add a folder, open the Notes tree menu and click **Add folder**, or press ⌘⇧N.
3. To make a note in a folder, hover the folder and click **New note in this folder**.
4. To put existing notes in an empty folder, open the folder, click **Add existing**, search the notes and click **Add N notes**.
5. To move a note, drag it onto a folder in the Notes tree. Drag it onto **Notes** to move it out of a folder. Gristmill shows **Undo** after the move.
6. Use **Collapse all** or **Expand all** to change the tree.

### Change a note or a folder

1. Open the menu of a note or a folder in the Notes tree.
2. Click **Rename**, or **Change icon**.
3. For a note, click **Move to folder…** and search the folder. In the note editor, you can also select the folder or **No folder**.
   Changing folders keeps the open note and its Summary visible while saved data refreshes. A clicked folder keeps its color.
4. Click **Show in Finder** to open the Markdown copy, if note files are on. See [Note files](note-files.md).

### Delete a note or a folder

1. Open the menu and click **Delete**. Confirm the deletion.
2. When you delete a folder, its notes stay in their other folders or appear directly under **Notes**.
3. When you delete a note, Gristmill also deletes its recordings and results.

### Find a note

1. Click **Search** in the top bar or press ⌘K.
2. Type a word. Gristmill shows matching **Notes** and **Transcripts**.
3. Use the arrow keys and Enter to open a result.
4. To move between notes in the list, press ⌘⇧] and ⌘⇧[.

### Find text in a note

1. Open a note and press ⌘F.
2. Type in **Find in note**. Use **Previous match** and **Next match**.

### Add participants

1. Open a note and click **Add attendees**.
2. Search for a saved contact or choose **Create contact**. Enter a name. Email and Telegram are optional. Select an existing contact to reuse the same person in another note. Equal names can identify different contacts. Remove a participant with **Remove attendee**.
3. Open a participant card and choose **Edit contact** to edit or clear email and Telegram. Enter a bare username, `@username`, `t.me/username` or `https://t.me/username`. Telegram uses 5–32 ASCII letters, digits or underscores. A profile link can have one trailing slash; a host-only link is incomplete. Click the saved `@username` to open its HTTPS profile link.
4. A pending save keeps the form open. A failed save keeps the input for correction or retry. If an email already belongs to a contact during creation, **Select existing contact** uses that contact without changing it. **Cancel selection** keeps the form input. Editing a contact to an occupied email fails without changing either contact or its links. Contact merging is not supported. Telegram usernames are unique without regard to letter case; a conflict preserves all saved fields. If the contact saves but adding it to the note fails, select the saved contact to retry.
5. A calendar note shows its participants, the linked event and **Join** for the meeting link.
6. Gristmill uses participants as hints for speaker names. See [Correct speakers](speakers.md).

## BDD acceptance criteria

- Given I type in a note, when I stop typing, then the note saves without a Save button.
- Given a save fails, when I click **Retry**, then my edits save.
- Given I drag a note onto a different folder, when I drop it, then the note moves to that folder.
- Given I delete a folder, when the deletion completes, then its notes stay in Gristmill.
- Given I search a word from a transcript, when results appear, then I see the note in **Transcripts**.

## Related documents

- [Note writes](../../architecture/note-writes.md) — write effects and deletion policy.
- [Note output](../../architecture/note-output.md) — what a note contains and how consumers read it.
- [Home and navigation](home.md) — Home and the sidebar.

### Contact context and mentions

Cards show current shared contact details. A meeting retains its name/email context. That context is provisional until its first AI processing, so names learned after calendar-note creation can still be used. At first processing it freezes; later contact edits do not change its saved Summary, participant context or freshness. An explicitly added participant captures its own context at addition without refreshing existing members.

The `@` picker binds saved contacts by ID. Two contacts with the same name stay separate choices. New bound mentions use `[@Label](mention:contact:<id>)`; a later contact edit does not change the saved label. Transcript-only or self labels without a saved contact stay plain `@Name` text. Ambiguous action owners remain text.

Old email mentions can show a contact avatar if their email uniquely matches this note's participant snapshots, or otherwise an exact current-contact email. Old label-only, malformed or unresolved links keep a neutral avatar. Reading a mention does not create a contact, change its saved href/label, write note text or change Summary freshness.
