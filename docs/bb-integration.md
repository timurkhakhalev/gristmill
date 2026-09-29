# BB agent route

Gristmill uses the installed BB app and the user's provider subscription for the optional **bb** route. The current supported CLI version is **0.44.0**. Transcription and recording stay on their existing routes.

## Harness selection

- Settings → Providers → **Coding agents (bb)** lists the available harnesses with their bb logos. It sets the order in pickers, enables or disables each harness and marks the default harness. Each harness's default model and reasoning level is stored too; it starts as the harness's first model and is not edited there. These preferences are seeded once from bb's own `providerOrder` and `defaultProviderId`. After that they belong to Gristmill and are never written back to bb.
- The chat composer (including the empty-chat bar) has a bb-style picker: harness tabs, model search over a virtual list and a reasoning row. Its **API** tab returns chat to the configured Cloud/Local/Self-Hosted route.
- Chat and meeting summaries follow the default harness and its default model unless they pin their own selection in their task picker (Settings → Models → Tasks, **bb** tab). A disabled harness resolves to no selection and is reported. It is never replaced by another harness.
- Logos are fetched by main only from bb's loopback `/api/v1/system/providers/*/logo` route. Only bounded SVG is accepted, and it is passed to the renderer as an image data URL.

## Runtime contract

- Main invokes the BB CLI script with the app's Node runtime, with prompt text on stdin. It looks for `BB_CLI`, then `~/.local/bin/bb`, then the BB app bundle at `/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb`. This does not depend on a terminal's `PATH` when the app starts from macOS Finder. It checks `bb --version` before starting a thread and reports a missing or mismatched version as an error.
- Gristmill creates a separate BB project for each app profile under its `userData/bb-agent` directory and saves the project ID there. This keeps production, development and isolated test profiles separate. BB threads are hidden in BB but remain inspectable there.
- Main reads `bb thread log --json --after-seq` for chat deltas and reads `bb thread output --json` for the final result. No provider credentials are copied into Gristmill settings.
- A profile-local `.bb-connection.json` outside the BB project directory contains the loopback CLI bridge port and token, with owner-only permissions. The agent workspace contains a small allowlisted notes/folders/dictionary/snippets tool wrapper. Main removes the connection file at shutdown and before creating a new bridge on startup. Do not place credentials in the agent prompt or log.
- The meeting run stores `bb_thread_id` before waiting for a summary. After restart, a run at the summary stage checks that thread's log and output. A completed result is reused; a running turn is watched; a failed or empty turn receives the saved summary prompt again. The transcript and original tracks remain unchanged. A crash between BB accepting a new thread and saving its ID can leave an orphan hidden thread; the meeting run retries visibly.

## Meeting context and JSON repair

The first naming or Summary turn sends a plain-text transcript in `<transcript>` tags. Later turns reuse it when the latest actual transcript in the persisted BB user-message history is byte-for-byte identical. Speaker names are supplied separately as accepted identities; naming, Summary and task requests use the same speaker aliases and timestamps. A new or changed transcript is sent in full. Fictional examples do not count as the actual meeting transcript. Other provider routes still receive the full required context.

Speaker naming and Recap validate strict JSON. Prioritized tasks return Markdown directly (an empty response means no tasks), without JSON repair. A schema-invalid reply gets one correction request in the same conversation; another invalid reply becomes a visible format error. Refusal and transport errors do not start a repair. The BB adapter returns final text and currently has no native refusal metadata, so it reports `refusal: false`; meeting JSON handling can only identify a refusal from recognizable refusal text.

Meeting JSON repair on BB uses `tell` on the run's saved `bb_thread_id`, including repair turns. Task and Recap actions may be requested independently, but their turns on one saved run are serialized: the CLI's default `tell` mode steers an active turn, so overlapping action prompts could replace one another. This serialization does not change other provider routes or Summary Markdown's revision checks.

## Updating BB

1. Install the new BB app, then check `bb --version`, `bb thread spawn --help`, `bb thread tell --help`, `bb thread log --help`, `bb thread output --help`, and the provider/model JSON output.
2. Update `SUPPORTED_BB_VERSION` in `src/helpers/bbCli.ts` after verifying the CLI argument and event schemas in `src/contracts/bb.ts`.
3. Run the BB CLI contract test, meeting recovery tests, typecheck, lint, and full suite. Perform an isolated live thread smoke against the installed app, including streamed deltas and final output. Verify Chat and meeting summary in an isolated Gristmill profile.

The version check deliberately fails closed. There is no automatic switch to a BYOK or local model when BB is unavailable.
