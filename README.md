<p align="center"><img src="docs/brand/logo-horizontal.svg" alt="Gristmill AI" height="96"></p>

# Gristmill

*Meeting notes, milled fine.*

See [docs/rename-migration.md](docs/rename-migration.md) for moving an existing OpenHercules profile, keychain items and env vars.

Gristmill is a macOS Apple Silicon meeting and notes client based on an imported OpenWhispr baseline. Cleanup and the M1–M4 record-then-process implementation are in place in the current task branch; root's final integrated checks and live mic/system hardware smoke remain pending.

The product is intended to use OpenWhispr as a one-time source for its Granola-like interface, macOS capture code, calendar integration, and selected provider adapters. Gristmill is not planned as a long-lived rebrand that continuously merges all upstream OpenWhispr features.

## Core promise

The recording is the source of truth. A transcript, diarization result, summary, or chat index is a reproducible artifact that can be regenerated with another provider or model.

Gristmill must never silently present a meeting as complete when one audio channel is missing or a processing stage handled only part of the recording.

## Product shape

- Capture microphone and system audio as separate durable tracks.
- Keep recording locally through network, VPN, and cloud-provider failures.
- Record only during the call. After Stop, transcribe the finalized recording with a selectable non-realtime ASR provider, requesting diarization in the same processing pass when supported.
- Diarize speakers where the selected route supports it, suggest names from evidence, and let the user correct them.
- Generate one Summary automatically for meetings that meet the duration and transcript-length thresholds; a ready transcript can also be summarized manually.
- Add optional prioritized tasks and a manually requested Recap to that Summary; draft Follow-up in the existing Chat.
- Ask questions about one meeting, with answers linked to transcript timestamps.
- Export or reprocess the original audio, transcript, and notes.
- Associate meetings with calendars, participants, categories, tags, and templates.

After a successful Stop, a persisted 15-second gate delays audio preparation and ASR; a restart respects the saved deadline. Pause does not queue processing, and Resume invalidates pending work for the earlier Note audio version. The implemented flow is record → Stop → finalize audio → wait → prepare provider-specific full-timeline WAVs → transcript → optional speaker naming → Summary → optional task sections → Notes. No local or cloud transcript, draft, or ASR request runs during capture. Storage epochs protect recovery and preserve source gaps; they do not define ASR requests. The raw mic/system tracks remain separate and immutable. Deepgram receives one stereo WAV (mic on channel 0, system on channel 1) with multichannel diarization. ElevenLabs, Gemini and OpenAI receive two parallel requests: mic without diarization, system with diarization. OpenAI uses Whisper for timestamped mic transcription and GPT-4o Transcribe Diarize for system audio. Source responses persist separately so a retry reuses a completed source. Local ASR keeps its existing mono route. Settings > Profile and onboarding offer an optional display name for mic speech (otherwise "You"). Meeting prompts receive merged plain-text turns inside `<transcript>`, using Speaker N aliases with accepted names and audio sources listed separately. BB reuses the unchanged transcript from its saved conversation. Speakers can be linked to calendar participants in the name editor; locally saved names enrich future calendar candidates without assigning new voices automatically. The first automatic Summary requires both 180 seconds of audio and 2,500 transcript characters; a ready shorter transcript can be summarized manually. Explicit retranscription creates a new Summary for every nonempty result, preserving previous versions. Action items return Markdown directly, with an empty response for no tasks. Summary, task sections, and Recap share one Markdown artifact. Follow-up is an ordinary assistant message in the existing embedded Chat and is never sent externally.

Meeting transcription uses the selected supported ElevenLabs, Deepgram, Gemini, or OpenAI file route, or the existing Local route. It reports capability/limit errors without hidden fallback or splitting; no new Self-Hosted meeting-transcription route was added. Timur will evaluate quality, latency, and cost after implementation. A provider Batch API is not required.

## Current status

Cleanup was merged in PR #6. The current task adds durable separate audio tracks, post-Stop processing, run history, selected-version Notes projection, playback/export, and audio retention/deletion. Existing Notes, blank/manual content, full embedded chat/tools, imports, Dictionary/Snippets, calendars, speakers, and existing provider modes remain. There is no meeting-only dashboard or new results tab. The live mic/system hardware smoke is still unverified and is reserved for final integration. See the [record-then-process implementation and verification status](docs/record-then-process.md), [milestones](docs/delivery-plan.md), [cleanup scope](docs/removal-plan.md), and [baseline](docs/cleanup-m0.md).

## Documents

### Read-only Notes CLI

The packaged app installs or refreshes the Notes CLI on startup. Settings → Advanced → **Install Notes CLI** can also refresh it manually. This writes `~/.local/bin/gristmill`; add that directory to `PATH` if your shell does not already include it. The launcher uses the installed app's Node runtime, and the Gristmill app must be running. Explicit test profiles leave this global command untouched. Run `gristmill doctor` to check the connection.

```sh
gristmill notes list --from 2026-09-01 --with-transcript
gristmill notes search "релиз"
gristmill notes show 42
gristmill notes content show 42
gristmill notes summary show 42
gristmill notes transcript show 42 --from 00:12:00 --to 00:13:00
gristmill notes transcript show 42 --plain-text
```

Run `gristmill --help` or a command with `--help` for options. Inside a Gristmill BB workspace, the CLI automatically uses that workspace's profile. Outside BB, the launcher defaults to the profile of the app that installed it: production for Gristmill, development for Gristmill Dev. Use `--profile dev` (or `--profile development`) to select Dev explicitly; `GRISTMILL_PROFILE` also selects a profile. An absolute profile path is useful for isolated test profiles. Date filters use inclusive local calendar days in the machine's time zone. Interactive commands print readable text. Redirected output is JSON, and `--json` forces JSON in a terminal; transcript `--plain-text` always prints text. Errors go to stderr and use the selected output format. Exit codes are 0 for success, 1 for execution/access errors, and 2 for invalid arguments. The CLI reads saved Note data and never starts transcription or Summary generation.

The CLI's profile-local connection file grants read-only access to Note metadata, user notes, saved Summary and transcript. The embedded BB tools retain their existing write access through a separate token. Neither connection exposes raw audio or provider payloads.

Start at the [memory bank](.memory-bank/index.md). The
[quality steering](.memory-bank/steerings/quality.md) defines which checks to run
for each change and how to keep test execution within the resource budget.

Install with `pnpm install --frozen-lockfile` (pnpm 10.19.0, Node >=24).
Use `pnpm run build:renderer`, `pnpm run typecheck`, `pnpm run lint` and
`pnpm test` for checks. The canonical lockfile is `pnpm-lock.yaml`.
`pnpm test --domain calendar` selects a domain; repeat `--domain` to combine them.
Add `--kind unit` for a fast loop or `--list` to inspect the plan without running
tests or preparing the runtime. Other kinds are `integration`, `types` and `native`.
`pnpm test -- test/helpers/ffmpegUtils.test.ts` runs one file; `pnpm test` runs
the full suite. The registry validates coverage of all test files. Main is built
once only when selected tests require its output. See
[project commands](.memory-bank/steerings/project-commands.md) for selector rules.
pnpm refuses to run scripts
when `node_modules` does not match this worktree's lockfile; install with
`pnpm install --frozen-lockfile` in that worktree first. Dependency install
builds one child package at a time.
On macOS, focused and full tests run under Electron's Node mode and share its
SQLite ABI with `pnpm dev`; the test command probes that binding and repairs a
mismatch before starting. Linux CI runs tests under Node with the Node ABI.
A healthy binding is left untouched.
Production saves meeting capture errors in `userData/logs/capture-errors.log`
without Debug mode. It keeps that file and one rotated `capture-errors.1.log`,
each at most 1 MiB. Settings → Developer opens the logs folder; Debug mode
still creates its separate detailed log.

The runner uses at most two ordinary test processes, with compiler/native and
shared-resource tests in a sequential phase. Use `pnpm test -- --processes 1`
for a one-process diagnostic run. Full runs share a lock across Git worktrees.
Build the macOS arm64 app with `pnpm run build:mac:arm64` (Xcode command-line tools required). For a local install without a Developer ID certificate, use `pnpm run build:mac:arm64:local` to ad-hoc sign the app with its bundle identifier so macOS can register it for Accessibility access.
The package does not include Whisper, llama.cpp or sherpa-onnx executables. The first use of a downloaded local model installs its required engine into the app's user data; cloud routes do not install them.
An ad-hoc signature changes with each rebuild, so macOS may require microphone, system audio and Accessibility access again after a local update. Sign with a stable Apple certificate to preserve those grants across updates.
Build a separate unsigned development app with `pnpm run pack:dev`. It appears at `dist-dev/mac-arm64/Gristmill Dev.app`, uses its own `Gristmill-development` profile, and includes the Notes Debug menu and orange icons. Debug states are interactive and kept in memory; they do not save notes, record audio, or call providers.
On its first launch, the development profile takes an additive, one-way snapshot of the production profile. `pnpm dev` and the packaged Dev app share the development database. Existing dev data is kept; `GRISTMILL_REFRESH_SNAPSHOT=1` copies only missing production files. Reset All App Data in Dev prevents automatic reseeding on later launches. Explicit `--user-data-dir` test profiles never import production data.
Only the integrator runs tests/build/install, sequentially. `pnpm dev` and
`pnpm start` probe the Electron binding and repair a mismatch before opening
the app. Keep dependency installs and packaging rebuilds separate from a
running test suite or app because they replace the native binary.
The packaging hook forcibly restores Electron's ABI and validates SQLite with the
packaged runtime before creating installers.

- [Electron TypeScript build](docs/typescript-build.md)
- [Product requirements](docs/product.md)
- [Target architecture](docs/architecture.md)
- [Record-then-process decision and validation hypotheses](docs/record-then-process.md)
- [BB agent route and pinned CLI version](docs/bb-integration.md)
- [OpenWhispr cutover](docs/openwhispr-cutover.md)
- [Delivery plan](docs/delivery-plan.md)

## Working name

The project is named **Gristmill**. Its core promise remains preserving original meeting audio and producing reproducible transcripts and notes.

Meeting audio is recorded directly into separate mono Ogg/Opus tracks at 32 kbit/s VBR, complexity 0. Derived WAV inputs are temporary; saved transcripts and provider results remain durable. See [recording storage and migration](docs/opus-recording.md).
