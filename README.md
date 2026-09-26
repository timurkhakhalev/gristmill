# OpenHercules

OpenHercules is a macOS Apple Silicon meeting and notes client based on an imported OpenWhispr baseline. Cleanup and the M1–M4 record-then-process implementation are in place in the current task branch; integrated verification and live mic/system hardware smoke remain pending.

The product is intended to use OpenWhispr as a one-time source for its Granola-like interface, macOS capture code, calendar integration, and selected provider adapters. OpenHercules is not planned as a long-lived rebrand that continuously merges all upstream OpenWhispr features.

## Core promise

The recording is the source of truth. A transcript, diarization result, summary, or chat index is a reproducible artifact that can be regenerated with another provider or model.

OpenHercules must never silently present a meeting as complete when one audio channel is missing or a processing stage handled only part of the recording.

## Product shape

- Capture microphone and system audio as separate durable tracks.
- Keep recording locally through network, VPN, and cloud-provider failures.
- Record only during the call. After Stop, transcribe the finalized recording with a selectable non-realtime ASR provider, requesting diarization in the same processing pass when supported.
- Diarize remote speakers when needed and let the user correct speaker identities.
- Generate notes automatically after the final transcript is ready.
- Ask questions about one meeting, with answers linked to transcript timestamps.
- Export or reprocess the original audio, transcript, and notes.
- Associate meetings with calendars, participants, categories, tags, and templates.

The implemented flow is record → Stop → finalize audio → process one derived mono full-timeline WAV → Notes. No local or cloud transcript, draft, or ASR request runs during capture. Storage epochs protect recovery and preserve source gaps; they do not define ASR requests. The raw mic/system tracks remain separate and immutable. The selected existing ElevenLabs, Deepgram, Gemini, or Local route reports capability/limit errors without hidden fallback or splitting. Timur will evaluate quality, latency, and cost after implementation. A provider Batch API is not required.

## Current status

Cleanup was merged in PR #6. The current task adds durable separate audio tracks, post-Stop processing, run history, selected-version Notes projection, playback/export, and audio retention/deletion. Existing Notes, blank/manual content, chat/tools, imports, Dictionary/Snippets, calendars, speakers, and existing provider modes remain. The live mic/system hardware smoke is still unverified and is reserved for final integration. See the [record-then-process implementation and verification status](docs/record-then-process.md), [milestones](docs/delivery-plan.md), [cleanup scope](docs/removal-plan.md), and [baseline](docs/cleanup-m0.md).

## Documents

Install with `pnpm install --frozen-lockfile` (pnpm 10.19.0, Node >=24).
Use `pnpm run build:renderer`, `pnpm run typecheck`, `pnpm run lint` and
`pnpm test` for checks. The canonical lockfile is `pnpm-lock.yaml`.
`pnpm test -- test/helpers/ffmpegUtils.test.js` runs one file; `pnpm test` runs
the full suite. Both build the main process first. On macOS, the test run uses
background scheduling and one Node test worker. pnpm refuses to run scripts
when `node_modules` does not match this worktree's lockfile; install with
`pnpm install --frozen-lockfile` in that worktree first. Dependency install
builds one child package at a time.
Before the full suite, rebuild SQLite for Node with
`pnpm --dir node_modules/better-sqlite3 exec prebuild-install`; the test command
checks the binding before starting and requires DB tests to run.
Build the macOS arm64 app with `pnpm run build:mac:arm64` (Xcode command-line tools required). For an unsigned local build, set `CSC_IDENTITY_AUTO_DISCOVERY=false`.
Build a separate unsigned development app with `pnpm run pack:dev`. It appears at `dist-dev/mac-arm64/OpenHercules Dev.app`, uses its own `OpenHercules-development` profile, and includes the Notes Debug menu and orange icons. Debug states are interactive and kept in memory; they do not save notes, record audio, or call providers.
On its first launch, the development profile takes an additive, one-way snapshot of the production profile. `pnpm dev` and the packaged Dev app share the development database. Existing dev data is kept; `OPENHERCULES_REFRESH_SNAPSHOT=1` copies only missing production files. Reset All App Data in Dev prevents automatic reseeding on later launches. Explicit `--user-data-dir` smoke profiles never import production data.
Run `node scripts/smoke-electron.js` after packaging for an isolated-profile smoke test.
For the development app, pass its executable path and `--dev` to the same smoke script.
Only the integrator runs tests/build/install, sequentially. Node tests and Electron
need different SQLite ABIs: run `pnpm --dir node_modules/better-sqlite3 exec prebuild-install`
before Node tests after packaging. The packaging hook forcibly restores Electron's ABI
and validates SQLite with the packaged runtime before creating installers.

- [Electron TypeScript build](docs/typescript-build.md)
- [Product requirements](docs/product.md)
- [Target architecture](docs/architecture.md)
- [Record-then-process decision and validation hypotheses](docs/record-then-process.md)
- [OpenWhispr cutover](docs/openwhispr-cutover.md)
- [Delivery plan](docs/delivery-plan.md)

## Working name

The project is named **OpenHercules**. Its core promise remains preserving original meeting audio and producing reproducible transcripts and notes.
