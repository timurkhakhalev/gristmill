# Gristmill CLI

As a Gristmill user, I want to read my notes from the terminal and use them in scripts and other tools.

## Entry points

- **Gristmill app → Settings → Advanced → Gristmill CLI** — install the CLI.
- **Terminal → `gristmill`** — find and read saved notes.
- **Gristmill app → Chat → bb harness** — the chat agent also uses `gristmill` to read other notes. See [AI conversations](chat.md).

## Paths

### Install the CLI

1. Open the packaged Gristmill app. The app installs or refreshes `~/.local/bin/gristmill` at startup.
2. If the CLI is not installed, open Settings → Advanced and click **Install Gristmill CLI**. The row shows **CLI installed**, and the button becomes disabled.
3. If the terminal cannot find `gristmill`, add `~/.local/bin` to your shell `PATH`.
4. Run `gristmill doctor`. The CLI prints `Gristmill production: connected (read-only)`.

### Find a note

1. Keep the Gristmill app open.
2. To see all notes, newest first, run `gristmill notes list`.
   - To limit the dates, add `--from 2026-09-01` and `--to 2026-09-30`. The dates are full local calendar days, and both days are included.
   - To see only notes with a transcript, add `--with-transcript`.
3. To find notes by a word, run `gristmill notes search "release"`. The search looks in titles, user notes, Summaries and transcripts. Add `--note 42` to search in one note.
4. Copy the note ID from the output.

### Read a note

1. Run `gristmill notes show 42` to see the title, the participants and the parts that the note contains.
2. Read the part that you need:
   - `gristmill notes content show 42` — your notes as Markdown.
   - `gristmill notes summary show 42` — the saved Summary. If the note has no Summary, the CLI tells you. It does not make a new Summary.
   - `gristmill notes transcript show 42` — the transcript with speakers and times.
3. To read a part of the transcript, add `--from 00:12:00 --to 00:13:00` or `--speaker speaker_2`.

### Use notes in a script or another tool

1. Send the output to a file or a pipe. The CLI writes JSON automatically.
2. To get JSON in the terminal, add `--json`. To get text from a redirected transcript, add `--plain-text`.
3. Use the exit code: 0 is success, 1 is an access or execution error, 2 is an incorrect argument. An empty list is a success.
4. Read errors from stderr. They use the same format as the output: text or JSON.
5. For all options, run `gristmill --help` or a command with `--help`.

### Read notes from Gristmill Dev or a test profile

1. Open the app of that profile.
2. Run the command with `--profile dev`, or set `GRISTMILL_PROFILE`. For an isolated test profile, give its absolute path.
3. In a Gristmill bb workspace, you do not select a profile. The CLI uses the profile of that workspace.

### Recover when the app is closed

1. A CLI command fails with `No Notes CLI connection for production`.
2. Open or restart Gristmill. For Gristmill Dev, open Gristmill Dev or use `--profile dev`.
3. Run `gristmill doctor` again, then run the command again.

## BDD acceptance criteria

- Given the app is open and the CLI is installed, when I run `gristmill notes search "release"`, then I see the saved notes that contain "release".
- Given the app is closed, when I run a CLI command, then the command fails with exit code 1 and tells me to open Gristmill.
- Given I use the CLI, when I try to change a note, then I cannot, because the CLI only reads notes.
- Given I redirect the output to a file, when the command completes, then the file contains JSON.

## Related documents

- [BB integration](../../architecture/bb-integration.md) — CLI profile selection, the local bridge, tokens and route limits.
