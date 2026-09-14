# OpenHercules

OpenHercules is a macOS Apple Silicon meeting and notes client based on an imported OpenWhispr baseline. The current task is cleanup: remove OpenWhispr Cloud and unrelated products while preserving existing realtime recording, notes, full embedded chat, all direct providers, Local and supported Self-Hosted modes.

The product is intended to use OpenWhispr as a one-time source for its Granola-like interface, macOS capture code, calendar integration, and selected provider adapters. OpenHercules is not planned as a long-lived rebrand that continuously merges all upstream OpenWhispr features.

## Core promise

The promise and product shape below describe the future batch stage, not
guarantees of the imported application or requirements for cleanup.

The recording is the source of truth. A transcript, diarization result, summary, or chat index is a reproducible artifact that can be regenerated with another provider or model.

OpenHercules must never silently present a meeting as complete when one audio channel is missing or a processing stage handled only part of the recording.

## Product shape

- Capture microphone and system audio as separate durable tracks.
- Keep recording locally through network, VPN, and cloud-provider failures.
- Transcribe the completed recording with a selectable batch ASR provider.
- Diarize remote speakers when needed and let the user correct speaker identities.
- Generate notes automatically after the final transcript is ready.
- Ask questions about one meeting, with answers linked to transcript timestamps.
- Export or reprocess the original audio, transcript, and notes.
- Associate meetings with calendars, participants, categories, tags, and templates.

Realtime transcription is optional. Reliable post-meeting processing is the primary flow.

## Current status

Cleanup is implemented on `codex/cleanup-openhercules`. Notes remain the product root, including blank notes and cross-note chat tools. OpenWhispr accounts/backend, dictation, the standalone assistant, YouTube and semantic search are removed. Direct providers, Local, supported Self-Hosted and existing realtime meeting recording remain. See the [milestone and verification log](docs/cleanup-log.md), [scope](docs/removal-plan.md) and [baseline](docs/cleanup-m0.md).

## Documents

Install with `pnpm install --frozen-lockfile` (pnpm 10.19.0, Node >=24).
Use `pnpm run build:renderer`, `pnpm run typecheck`, `pnpm run lint` and
`pnpm test` for checks. The canonical lockfile is `pnpm-lock.yaml`.
Build the macOS arm64 app with `pnpm run build:mac:arm64` (Xcode command-line tools required). For an unsigned local build, set `CSC_IDENTITY_AUTO_DISCOVERY=false`.
Run `node scripts/smoke-electron.js` after packaging for an isolated-profile smoke test.
Only the integrator runs tests/build/install, sequentially. Node tests and Electron
need different SQLite ABIs: run `pnpm --dir node_modules/better-sqlite3 exec prebuild-install`
before Node tests after packaging. The packaging hook forcibly restores Electron's ABI
and validates SQLite with the packaged runtime before creating installers.

- [Product requirements](docs/product.md)
- [Target architecture](docs/architecture.md)
- [OpenWhispr cutover](docs/openwhispr-cutover.md)
- [Delivery plan](docs/delivery-plan.md)

## Working name

The project is named **OpenHercules**. Its core promise remains preserving original meeting audio and producing reproducible transcripts and notes.
