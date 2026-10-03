# Read-only Gristmill CLI

## Installation

- The packaged app installs or refreshes the Gristmill CLI at startup.
- If the CLI is not installed, use Settings → Advanced → **Install Gristmill CLI**. The button is not available for an already installed CLI.
- The CLI is `~/.local/bin/gristmill`. If your shell `PATH` does not include `~/.local/bin`, add it.
- The launcher uses the Node runtime of the installed app. The Gristmill app must be running.
- Explicit test profiles do not change this global command.
- To examine the connection, run `gristmill doctor`.

## Commands

```sh
gristmill notes list --from 2026-09-01 --with-transcript
gristmill notes search "релиз"
gristmill notes show 42
gristmill notes content show 42
gristmill notes summary show 42
gristmill notes transcript show 42 --from 00:12:00 --to 00:13:00
gristmill notes transcript show 42 --plain-text
```

For options, run `gristmill --help` or a command with `--help`.

## Profile selection

- In a Gristmill BB workspace, the CLI uses the profile of that workspace automatically.
- Outside BB, the launcher uses the profile of the app that installed it: production for Gristmill, development for Gristmill Dev.
- To select Dev explicitly, use `--profile dev` (or `--profile development`).
- `GRISTMILL_PROFILE` also selects a profile.
- Use an absolute profile path for isolated test profiles.

## Output and errors

- Date filters use inclusive local calendar days in the time zone of the machine.
- Interactive commands print readable text.
- Redirected output is JSON. `--json` makes JSON output in a terminal.
- Transcript `--plain-text` always prints text.
- Errors go to stderr in the selected output format.
- Exit codes: 0 for success, 1 for execution or access errors, 2 for invalid arguments.
- The CLI reads saved Note data. It never starts transcription or Summary generation.

## Access limits

The profile-local connection file of the CLI gives read-only access to Note metadata, user notes, the saved Summary and the transcript.
The embedded BB tools keep their write access through a separate token.
The CLI read token does not give access to raw audio or provider payloads. The internal write token has a wider route table than the embedded BB tools; see [local automation access](user-journeys/local-api.md).
For bridge and token details, see [BB integration](../architecture/bb-integration.md).
