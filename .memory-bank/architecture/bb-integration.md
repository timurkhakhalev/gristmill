# BB agent route

The optional **bb** route uses the installed BB app and the provider subscription of the user.
The supported CLI version is **0.44.0** (`SUPPORTED_BB_VERSION` in `src/helpers/bbCli.ts`).
Transcription and recording stay on their existing routes.

## Harness selection

- Settings → Providers → **Coding agents (bb)** lists the available harnesses with their bb logos.
- This screen sets the sequence in pickers, enables or disables each harness and marks the default harness.
- Gristmill also stores the default model and reasoning level of each harness. The initial value is the first model of the harness. This screen does not edit it.
- Gristmill copies these preferences one time from the bb `providerOrder` and `defaultProviderId`. After that, they belong to Gristmill. Gristmill never writes them back to bb.
- The chat composer (also the empty-chat bar) has a bb-style picker: harness tabs, model search in a virtual list and a reasoning row.
- The **API** tab of the picker sets the chat back to the configured Cloud, Local or Self-Hosted route.
- Chat and meeting summaries use the default harness and its default model, unless their task picker pins a different selection (Settings → Models → Tasks, **bb** tab).
- A disabled harness gives no selection, and Gristmill reports it. A different harness never replaces it.
- Main gets logos only from the bb loopback route `/api/v1/system/providers/*/logo`. It accepts only bounded SVG and sends it to the renderer as an image data URL.

## Runtime contract

### CLI discovery

- Main runs the BB CLI script with the Node runtime of the app. The prompt text goes to stdin.
- Main looks for the CLI in this sequence:
  1. `BB_CLI`
  2. `~/.local/bin/bb`
  3. The BB app bundle: `/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb`
- Thus the discovery does not depend on the terminal `PATH` when the app starts from Finder.
- Main runs `bb --version` before it starts a thread. A missing or incorrect version is an error.

### Projects and output

- Gristmill creates a separate BB project for each app profile under `userData/bb-agent` and saves the project ID there.
- This keeps the production, development and isolated test profiles separate.
- BB threads are hidden in BB, but you can inspect them there.
- Main reads `bb thread log --json --after-seq` for chat deltas and `bb thread output --json` for the final result.
- No provider credentials are copied into the Gristmill settings.

### Chat thread binding

- Each local Chat conversation has one persisted BB binding in the SQLite table `agent_bb_threads`: `conversation_id`, `thread_id` and `provider`.
- The first turn creates a thread and saves its ID before streaming. Later turns use `tell` on that ID, also after the app opens again.
- A new local Chat creates a separate thread.
- An existing chat without a binding sends the local history and the system instructions to its first thread.
- Follow-up turns send only the newest user message, without changes. They do not send system instructions, role labels or previous answers.
- The event cursor starts after the previous turn. Thus old deltas and completion events do not replay.

### Turn serialization

- Chat turns of one conversation run one at a time across windows. This includes stream completion and the Stop request of a cancellation.
- If the app opens again while its saved thread is still running, it waits for that turn before it sends another.
- A cancellation keeps the saved binding.
- A missing thread is an error. Gristmill does not create a replacement without notice.
- Model and reasoning changes go with `tell`. A change of the BB harness needs a new Chat.
- Direct API, Local and Self-Hosted chat routes continue to use the local conversation history, not an external thread ID.

### Renderer conversation identity and persistence

`useChatPersistence` owns the visible conversation ID and generation. Note changes, conversation loads and New Chat invalidate older reads before they can publish. Home and Note hosts do not keep a second ID. Each turn captures its destination; switch and New Chat cancel the stream, and an old turn cannot save into a different conversation.

The sender awaits and checks the saved user row before it starts AI. Completion awaits the assistant write. A failed write leaves its text and a retry action in the visible history. Retry uses the current validated destination and does not run AI again. A pending or failed write prevents the next submission. The submission lock includes conversation creation, streaming and completion persistence.

Explicit Stop discards partial persistence. Unmount can save a visible partial reply to the originating conversation. An invalidated stream does not update tool activity or cancel a newer stream. Main retains BB turn/Stop serialization across windows.

### Bridges and tokens

- A profile-local `.bb-connection.json`, outside the BB project directory, contains the loopback CLI bridge port and token. It has owner-only permissions.
- The agent workspace contains a small allowlisted tool wrapper for notes, folders, dictionary and snippets.
- Main removes the connection file at shutdown and before it creates a new bridge at startup.
- Do not put credentials in the agent prompt or in a log.
- The installed `~/.local/bin/gristmill` command reads a separate profile-local `.cli-read-connection.json` token. The bridge permits only read-only routes for this token.
- The BB wrapper keeps its write token for the existing embedded Chat tools.
- The packaged app installs or refreshes its managed launcher at startup. Explicit smoke profiles do not change the global command.
- In `userData/bb-agent`, the CLI selects the profile of that workspace automatically, independently of the app channel of the launcher.
- Outside BB, the launcher uses the channel of the app that installed it. Explicit `--profile` and `GRISTMILL_PROFILE` override these defaults.
- A closed workspace profile fails visibly. The CLI does not read a different profile.

### Bridge routes and access limits

- The loopback HTTP bridge is an internal integration contract. It is not a published general-purpose API.
- The bridge starts with the app. It binds `127.0.0.1` on the first free port in 8200–8219 and requires a Bearer token.
- The app makes two tokens at each start. Both connection files use mode 0600.
- The read token permits health and Note list, search, metadata, content, Summary and transcript. It does not permit all GET routes: folders, vocabulary, models and transcriptions stay closed.
- The write token permits Note create, patch and delete, folder list and create, Dictionary and Snippets list and update, local models, local-file transcription, and separate transcription and audio deletion.
- There are no folder edit or delete routes. `/v1/transcribe` uses an installed local model and a local file path. It does not run the full meeting and Summary pipeline.
- The BB tool wrapper has a narrower allowlist than the write token: Note read, create and patch, folder list and create, and Dictionary and Snippets operations. It does not expose Note delete or transcription and audio routes.
- Do not infer BB tool availability from the full route table. A read-token request to a write route fails as read-only.

### Chat prompt

- BB Chat gets the current Note ID and a short description of `gristmill` as a helper for more meeting information. `gristmill --help` shows the commands.
- These instructions are part of the Chat prompt, not a generated workspace `AGENTS.md`. Workspace preparation removes the old generated file.
- The agent reads other Notes on demand. It does not get the full embedded Note transcript in each BB prompt.
- Naming and Summary turns keep their full saved transcript context.

### Meeting run recovery

- The meeting run saves `bb_thread_id` before it waits for a summary.
- After a restart, a run at the summary stage examines the log and the output of that thread:
  - A completed result is used again.
  - A running turn is watched.
  - A failed or empty turn gets the saved summary prompt again.
- The transcript and the original tracks do not change.
- If a crash occurs after BB accepts a new thread but before Gristmill saves its ID, an orphan hidden thread can stay. The meeting run tries again visibly.

## Meeting context and JSON repair

### Transcript reuse

- The first naming or Summary turn sends a plain-text transcript in `<transcript>` tags.
- Later turns use it again when the latest actual transcript in the persisted BB user-message history is identical byte for byte.
- Speaker names are sent separately as accepted identities.
- Naming, Summary and task requests use the same speaker aliases and timestamps.
- A new or changed transcript is sent in full.
- Fictional examples do not count as the actual meeting transcript.
- Other provider routes still get the full necessary context.

### JSON repair

- Speaker naming and Recap validate strict JSON.
- Prioritized tasks return Markdown directly, without JSON repair. An empty response means no tasks.
- A reply that is not valid for the schema gets one correction request in the same conversation. A second invalid reply becomes a visible format error.
- Refusal and transport errors do not start a repair.
- The BB adapter returns the final text and has no native refusal metadata. Thus it reports `refusal: false`. The meeting JSON handling can find a refusal only from recognizable refusal text.
- Meeting JSON repair on BB uses `tell` on the saved `bb_thread_id` of the run. This includes repair turns.
- The user can request task and Recap actions independently. But their turns on one saved run go one at a time. The default CLI `tell` mode steers an active turn, so overlapping prompts could replace each other.
- This serialization does not change other provider routes or the revision checks of the Summary Markdown.

## Updating BB

1. Install the new BB app.
2. Examine `bb --version`, `bb thread spawn --help`, `bb thread tell --help`, `bb thread log --help`, `bb thread output --help` and the provider and model JSON output.
3. Verify the CLI argument and event schemas in `src/contracts/bb.ts`.
4. Update `SUPPORTED_BB_VERSION` in `src/helpers/bbCli.ts`.
5. Run the BB CLI contract test, the meeting recovery tests, typecheck, lint and the full suite.
6. Do an isolated live thread smoke test against the installed app. Include streamed deltas and the final output.
7. Verify Chat and the meeting summary in an isolated Gristmill profile.

The version check fails closed deliberately.
When BB is not available, Gristmill does not change to a BYOK or local model automatically.
