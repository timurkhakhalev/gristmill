# Note files

As a Gristmill user, I want a local Markdown copy of my notes that I can open with other tools.

## Entry points

- **Gristmill app → Settings → Notes → Store note files** — turn the copy on or off.
- **Gristmill app → sidebar spaces tree → note or folder menu → Show in Finder** — open the files.

## Paths

### Turn on note files

1. Open Settings → Notes.
2. Turn on **Store note files**.
3. Wait. Gristmill writes all notes to the notes folder in the application data. The switch stays off and locked until the files are ready.
4. When the copy is ready, the switch is on.

### Open the files of a note or a folder

1. In the spaces tree, open the menu of a note or a folder.
2. Click **Show in Finder**. Finder opens the file or the folder.
3. Each note has a Markdown file with its details and its Summary or your notes. The transcript is in a separate file.
4. Notes without a folder are in the Personal folder.

### Keep the files up to date

1. Write, record or process notes as usual.
2. Gristmill updates the files when a note changes: a new calendar or manual note, a transcript, a Summary, a generated title, a speaker correction.
3. When you rename a folder, Gristmill moves the files of its notes.
4. The copy goes in one direction only. A change in a file does not change the note in Gristmill.

### Recover when the copy cannot start

1. If Gristmill cannot write the files, the switch stays off and an error shows below it.
2. Fix the cause, for example the folder permissions.
3. Turn on **Store note files** again.

### Turn off note files

1. Turn off **Store note files**.
2. Gristmill stops all updates. The existing files stay on disk.

## BDD acceptance criteria

- Given I turn on **Store note files**, when the files are ready, then the switch is on and **Show in Finder** works.
- Given Gristmill cannot write the files, when I turn on the switch, then the switch stays off and I see an error.
- Given I edit a Markdown file, when I open the note in Gristmill, then the note does not change.
- Given I turn off the switch, when the update stops, then the existing files stay.

## Related documents

- [Note files architecture](../../architecture/note-files.md) — mirror ownership, layout and failure rules.
- [Note writes](../../architecture/note-writes.md) — when a note change asks for a mirror update.
