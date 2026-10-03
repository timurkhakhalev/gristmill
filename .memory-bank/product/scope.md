# Product scope

Gristmill is a standalone macOS Apple Silicon application for meetings.
It has no backend of its own and does not use the OpenWhispr backend.
Recordings, transcripts, notes, settings and processing history stay local.
The cleanup decision is [ADR-0002](../adr/0002-cleanup-scope.md).

## Kept

- The Note is the product root. Notes without audio (blank notes included), manual text, the editor, folders, prompts and AI Actions stay. There is no mandatory Meeting root. Recordings and processing history attach to a Note.
- The full embedded Note chat stays, with its tools that create and edit notes and its local cross-note tools (full-text search). Only `web_search` is removed.
- All direct ASR and LLM providers (BYOK) stay, with their models, keys and custom endpoints. Direct AWS, Azure and Vertex credentials stay. The Local runtime, model downloads and the supported Self-Hosted routes stay.
- Realtime microphone and system recording, Audio Upload, import of the audio formats offered by the picker (including WebM) and direct media URLs, and FFmpeg stay.
- All speaker recognition stays: live recognition, voice fingerprints across meetings, contacts, manual corrections and the local diarization.
- Dictionary and Snippets stay: their data, their embedded chat tools and their management screen.
- Calendars stay: Apple (EventKit helper), Google and Microsoft (direct OAuth). Call detection, reminders, calendar vocabulary and participants stay. A calendar participant is a hint. It is not proof of speaker identity.
- The meeting hotkey, the recording pill, the tray and notifications stay.

## Removed

- OpenWhispr accounts, Cloud inference, sync and backup, sharing and teams, billing, enterprise policies (SSO, SCIM), hosted API, upstream MCP and CLI integrations, engagement features and the Insights upload.
- Dictation, paste at the cursor, dictation translation, wake words, the global voice assistant, the standalone ChatView, and screen or selection context outside notes.
- The dictation-history Home of OpenWhispr and Insights. The start view is the current Home.
- `web_search`, YouTube import, Qdrant and cross-note semantic search.
- Upstream auto-update and all distribution that is not macOS arm64.

The removed code is in the baseline commit `49cd2b3`.
Do not keep it in hidden flags, commented-out code or legacy directories.

The read-only Gristmill CLI and the internal loopback HTTP bridge remain available.
The internal write routes do not constitute a published public API.
See [local automation access](user-journeys/local-api.md).

## Non-goals without a new product decision

- A meeting-only screen that replaces Notes as the product root. The current Home is a start view, not a replacement root.
- Dictation, a general voice assistant, team collaboration, hosted sync, enterprise controls, Windows or Linux.
- A live transcript, a draft or ASR during capture.
- Cross-meeting semantic search and public web sharing.
- A marketplace or a dynamic plugin SDK. The provider registry is a static TypeScript table.

## Future candidates

- New ASR, diarization or LLM models in addition to the kept providers.
- MCP or a public local API.
- Action-item integrations.
- Gristmill OAuth registrations for Google and Microsoft. When a provider registration is absent from the application configuration, the application shows that its connection is not available. Manual recording and Apple Calendar work without them.
