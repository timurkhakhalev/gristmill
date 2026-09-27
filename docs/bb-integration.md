# BB agent route

OpenHercules uses the installed BB app and the user's provider subscription for the optional **Agent (bb)** route. The current supported CLI version is **0.44.0**. Chat can select its harness, model and reasoning level from the chat header. Meeting summaries use the separate Notes summary settings. Transcription and recording stay on their existing routes.

## Runtime contract

- Main invokes the BB CLI directly, with prompt text on stdin. It looks for `BB_CLI`, then `~/.local/bin/bb`, then the BB app bundle at `/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb`. It checks `bb --version` before starting a thread and reports a missing or mismatched version as an error.
- OpenHercules creates a separate BB project for each app profile under its `userData/bb-agent` directory and saves the project ID there. This keeps production, development and isolated test profiles separate. BB threads are hidden in BB but remain inspectable there.
- Main reads `bb thread log --json --after-seq` for chat deltas and reads `bb thread output --json` for the final result. No provider credentials are copied into OpenHercules settings.
- A profile-local `.bb-connection.json` outside the BB project directory contains the loopback CLI bridge port and token, with owner-only permissions. The agent workspace contains a small allowlisted notes/folders/dictionary/snippets tool wrapper. Main removes the connection file at shutdown and before creating a new bridge on startup. Do not place credentials in the agent prompt or log.
- The meeting run stores `bb_thread_id` before waiting for a summary. After restart, a run at the summary stage checks that thread's log and output. A completed result is reused; a running turn is watched; a failed or empty turn receives the saved summary prompt again. The transcript and original tracks remain unchanged. A crash between BB accepting a new thread and saving its ID can leave an orphan hidden thread; the meeting run retries visibly.

## Updating BB

1. Install the new BB app, then check `bb --version`, `bb thread spawn --help`, `bb thread tell --help`, `bb thread log --help`, `bb thread output --help`, and the provider/model JSON output.
2. Update `SUPPORTED_BB_VERSION` in `src/helpers/bbCli.ts` after verifying the CLI argument and event schemas in `src/contracts/bb.ts`.
3. Run the BB CLI contract test, meeting recovery tests, typecheck, lint, and full suite. Perform an isolated live thread smoke against the installed app, including streamed deltas and final output. Verify Chat and meeting summary in an isolated OpenHercules profile.

The version check deliberately fails closed. There is no automatic switch to a BYOK or local model when BB is unavailable.
