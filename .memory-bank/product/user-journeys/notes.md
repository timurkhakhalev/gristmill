# Notes and folders

As a Gristmill user, I want to write notes, keep them in folders and find them again.

## Entry points

- **Gristmill app → sidebar spaces tree** — spaces, folders and notes.
- **Gristmill app → top bar → Search** or **⌘K** — search notes and transcripts.
- **Keyboard: ⌘N** — new note. **⌘⇧N** — new folder.
- **macOS menu bar → Gristmill tray icon → New Note** — new note from any app.

## Paths

### Write a note

1. Click **New note** in the spaces tree menu, press ⌘N, or click **New Note** in the tray.
2. Type the title in **Note title** and the text below it.
3. Gristmill saves the note automatically. The editor shows **Saving**, then **Saved**.
4. If the save fails, Gristmill shows **Note was not saved. Your edits are still available.** Click **Retry**.

### Organize notes in folders

1. A new profile has one space, **Personal**, with one folder, **Personal**. Only you can see this space.
2. To add a folder, open the spaces tree menu and click **Add folder**, or press ⌘⇧N.
3. To make a note in a folder, hover the folder and click **New note in this folder**.
4. To put existing notes in an empty folder, open the folder, click **Add existing**, search the notes and click **Add N notes**.
5. Use **Collapse all** or **Expand all** to change the tree.

### Change a note or a folder

1. Open the menu of a note or a folder in the spaces tree.
2. Click **Rename**, or **Change icon**.
3. For a note, click **Move to folder…** and search the folder. In the note editor, you can also select the folder or **No folder**.
4. For a folder, click **Move to space…**. Gristmill shows **Undo** for a short time.
5. Click **Show in Finder** to open the Markdown copy, if note files are on. See [Note files](note-files.md).

### Delete a note or a folder

1. Open the menu and click **Delete**. Confirm the deletion.
2. When you delete a folder, its notes stay in their other folders or go to the top of the space.
3. When you delete a note, Gristmill also deletes its recordings and results.

### Find a note

1. Click **Search** in the top bar or press ⌘K.
2. Type a word. Gristmill shows matching **Notes** and **Transcripts**.
3. Select **All spaces** or one space to limit the search.
4. Use the arrow keys and Enter to open a result.
5. To move between notes in the list, press ⌘⇧] and ⌘⇧[.

### Find text in a note

1. Open a note and press ⌘F.
2. Type in **Find in note**. Use **Previous match** and **Next match**.

### Add participants

1. Open a note and click **Add attendees**.
2. Type an email and press Enter. Remove a participant with **Remove attendee**.
3. A calendar note shows its participants, the linked event and **Join** for the meeting link.
4. Gristmill uses participants as hints for speaker names. See [Correct speakers](speakers.md).

## BDD acceptance criteria

- Given I type in a note, when I stop typing, then the note saves without a Save button.
- Given a save fails, when I click **Retry**, then my edits save.
- Given I delete a folder, when the deletion completes, then its notes stay in Gristmill.
- Given I search a word from a transcript, when results appear, then I see the note in **Transcripts**.

## Related documents

- [Note writes](../../architecture/note-writes.md) — write effects and deletion policy.
- [Note output](../../architecture/note-output.md) — what a note contains and how consumers read it.
- [Home and navigation](home.md) — Home and the sidebar.
