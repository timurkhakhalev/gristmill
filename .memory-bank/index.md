# Memory Bank

The Memory Bank is the source of truth about the project for people and agents.
Read only the parts that you need: this index, then a section index, then a document.
Active task files are in `.tasks/`. They are not part of the Memory Bank.

## Project overview

Gristmill is a macOS Apple Silicon application that records meetings and keeps notes.
It does not add a bot to the call.
During a call, it records the microphone and the system audio as two separate local Ogg/Opus tracks.
After Stop, it sends the recording to the selected transcription provider.
The provider returns a transcript with speaker labels.
Then Gristmill makes a Summary in the existing Note.

Gristmill started from a one-time import of OpenWhispr (MIT license).
It has no backend. All data is in the local application profile.

## Tech stack

- Electron 41, TypeScript main process, Node 24 or later, pnpm 10.19.0.
- Renderer: React 19, Vite 8, HeroUI, Tailwind CSS 4, zustand, TipTap, i18next.
- Storage: SQLite (`better-sqlite3`) and managed files in Electron `userData`. The macOS Keychain keeps the secrets.
- Audio: Swift native helpers (system audio tap, microphone and call detection, Zoom Accessibility, EventKit), bundled FFmpeg/libopus, ONNX Runtime (diarization, speaker embeddings).
- AI: Vercel AI SDK and direct ASR/LLM adapters. Provider support depends on the task; see [processing routes](architecture/processing-routes.md). Local engines include whisper.cpp, llama.cpp and sherpa-onnx. Optional route: bb.
- Browser: an MV3 Chrome extension (Gristmill Companion) and a native messaging host.
- Tooling: `tsrs` (Rust port of the TypeScript 7 compiler) for typecheck and build, TypeScript 6 for the Compiler API, `node:test` through the canonical test runner.

## Sections

| Section                                | Contents                                                                                | Read it when                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [product/](product/index.md)           | Product overview, principles, guarantees, user journeys                                 | You change behavior or the product surface                                           |
| [architecture/](architecture/index.md) | C4 overview, recording and processing, storage, speakers, Companion, BB, feature limits | You change code in that area                                                         |
| [adr/](adr/index.md)                   | Accepted decisions and their reasons                                                    | You want to change a deliberate decision                                             |
| [steerings/](steerings/index.md)       | Quality policy, commands, scripts, documentation rules                                  | Before each change; when you select or run checks, change tooling or write documents |
| [runbooks/](runbooks/index.md)         | Local builds, signing, profiles, troubleshooting                                        | You build, install or diagnose the app                                               |
| [references.md](references.md)         | Documents outside the Memory Bank and external sources                                  | You need upstream, brand, issues or provider documentation                           |

## Reading paths

- **Onboarding:** this file → [architecture overview](architecture/overview.md) → [product overview](product/overview.md) → [quality steering](steerings/quality.md).
- **Recording and processing:** [ADR-0003](adr/0003-record-then-process.md) → [recording and processing](architecture/recording-processing.md) → [post-Stop processing](architecture/post-stop-processing.md) → [audio storage](architecture/audio-storage.md).
- **Providers, chat, BB:** [product overview](product/overview.md#not-in-the-product) → [BB integration](architecture/bb-integration.md).
- **Speakers and Companion:** [speaker evidence](architecture/speaker-evidence.md) → [Companion](architecture/companion.md).
- **Tooling and tests:** [quality](steerings/quality.md) → [project commands](steerings/project-commands.md) → [scripts](steerings/scripts.md).

## Maintenance

Rules for documents: [documentation steering](steerings/documentation.md).
