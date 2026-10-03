# Product scope

Gristmill is a standalone macOS Apple Silicon application for meetings.
It has no backend of its own and does not use the OpenWhispr backend.
Recordings, transcripts, notes, settings and processing history stay local.
The cleanup decision is [ADR-0002](../adr/0002-cleanup-scope.md).

## Kept

- The Note is the product root. Notes without audio (blank notes included), manual text, the editor, folders, prompts and AI Actions stay. There is no mandatory Meeting root. Recordings and processing history attach to a Note.
- The full embedded Note chat stays, with its tools that create and edit notes and its local cross-note tools (full-text search). Only `web_search` is removed.
- All direct ASR and LLM providers (BYOK) stay, with their models, keys and custom endpoints. Direct AWS, Azure and Vertex credentials stay. The Local runtime, model downloads and the supported Self-Hosted routes stay.
- Realtime microphone and system recording, Audio Upload, import of local audio and video files and direct media URLs, and FFmpeg stay.
- All speaker recognition stays: live recognition, voice fingerprints across meetings, contacts, manual corrections and the local diarization.
- Dictionary and Snippets stay: their data, their embedded chat tools and their management screen.
- Calendars stay: Apple (EventKit helper), Google and Microsoft (direct OAuth). Call detection, reminders, calendar vocabulary and participants stay. A calendar participant is a hint. It is not proof of speaker identity.
- The meeting hotkey, the recording pill, the tray and notifications stay.

## Removed

- OpenWhispr accounts, Cloud inference, sync and backup, sharing and teams, billing, enterprise policies (SSO, SCIM), hosted API, MCP and CLI integrations, engagement features and the Insights upload.
- Dictation, paste at the cursor, dictation translation, wake words, the global voice assistant, the standalone ChatView, and screen or selection context outside notes.
- Home (dictation history) and Insights. The application opens Notes by default.
- `web_search`, YouTube import, Qdrant and cross-note semantic search.
- Upstream auto-update and all distribution that is not macOS arm64.

The removed code is in the baseline commit `49cd2b3`.
Do not keep it in hidden flags, commented-out code or legacy directories.

## Non-goals without a new product decision

- A dashboard or a meeting-only screen that replaces Notes.
- Dictation, a general voice assistant, team collaboration, hosted sync, enterprise controls, Windows or Linux.
- A live transcript, a draft or ASR during capture.
- Cross-meeting semantic search and public web sharing.
- A marketplace or a dynamic plugin SDK. The provider registry is a static TypeScript table.

## Future candidates

- New ASR, diarization or LLM models in addition to the kept providers.
- MCP or a public local API.
- Action-item integrations.
- Gristmill OAuth registrations for Google and Microsoft. Until they exist, the application shows that the connection is not available. Manual recording and Apple Calendar work without them.
