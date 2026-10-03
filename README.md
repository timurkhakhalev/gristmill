<p align="center"><img src="docs/brand/logo-horizontal.svg" alt="Gristmill AI" height="96"></p>

# Gristmill

*Meeting notes, milled fine.*

Gristmill is a meeting recorder and notes app for macOS on Apple Silicon.
It does not add a bot to the call.
It started from a one-time import of [OpenWhispr](https://github.com/OpenWhispr/openwhispr) (MIT license).

## Core promise

The recording is the source of truth.
A transcript, a speaker result, a summary or a chat index is an artifact.
You can make it again with a different provider or model.

Gristmill never shows a meeting as complete when an audio channel is missing.
It also never shows a meeting as complete when a processing stage used only part of the recording.

## What it does

- Records the microphone and the system audio as separate local tracks (Ogg/Opus).
- Continues to record during network, VPN and cloud-provider failures.
- After Stop, transcribes the finished recording with the selected provider (ElevenLabs, Deepgram, Gemini, OpenAI or Local). Speaker diarization runs in the same pass when the provider supports it.
- Suggests speaker names from evidence. You can correct them.
- Makes a Summary with prioritized tasks. A Recap and a Follow-up draft are available on request.
- Gives a chat for each meeting. Answers link to transcript timestamps.
- Lets you play, export and process the original audio again.
- Connects meetings to calendars and participants.
- Links Google Meet and Telemost calls through the [Gristmill Companion](.memory-bank/product/companion.md) Chrome extension.
- Gives read-only access to notes from the terminal through the [`gristmill` CLI](.memory-bank/product/notes-cli.md).

## Getting started

You need Node 24 or later, pnpm 10.19.0 and the Xcode command-line tools.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Checks:

```sh
pnpm run typecheck
pnpm run lint
pnpm test                       # full suite
pnpm test --domain calendar     # one domain
pnpm run build:renderer
```

Build and install the app locally (quit Gristmill first):

```sh
pnpm run update:local
```

Signing, the Dev app and profiles: [local builds](.memory-bank/runbooks/local-builds.md).
All commands: [project commands](.memory-bank/steerings/project-commands.md).

## Documentation

All project documentation is in the [Memory Bank](.memory-bank/index.md):

- [Product](.memory-bank/product/index.md): requirements, scope, user-facing behavior.
- [Architecture](.memory-bank/architecture/index.md): how recording, processing and integrations work.
- [Decisions](.memory-bank/adr/index.md): why the system is like this.
- [Steerings](.memory-bank/steerings/index.md): quality policy and commands.
- [Runbooks](.memory-bank/runbooks/index.md): builds and troubleshooting.

Agents start at [AGENTS.md](AGENTS.md).

## License

MIT. See [LICENSE](LICENSE). Gristmill keeps the OpenWhispr license and attribution.
Import provenance: [docs/openwhispr-upstream/IMPORT.md](docs/openwhispr-upstream/IMPORT.md).
