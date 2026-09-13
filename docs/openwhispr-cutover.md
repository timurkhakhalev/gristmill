# OpenWhispr cutover

## Strategy

Use OpenWhispr as a one-time source of proven UI and platform capabilities. Pin an upstream commit, preserve its MIT license and notices when code is imported, and treat OpenHercules as an independent product afterward.

Continuous full upstream merges are not a goal. Once the product surface and data model diverge, relevant macOS fixes can be reviewed and cherry-picked deliberately.

## Keep

- Granola-like desktop layout and navigation.
- Meeting library and detail UI.
- Note editor.
- Transcript bubbles and speaker picker.
- Floating and docked meeting chat.
- Recording pill and meeting notification.
- Google, Microsoft, and Apple Calendar integrations.
- Meeting and call detection.
- macOS system-audio capture.
- Microphone capture.
- System-audio watchdog and recovery timeline.
- Audio/video import.
- Transcript export.
- SQLite foundation.
- Useful batch cloud-ASR adapters.
- Reasoning-service adapters.
- Existing note-action prompts as initial templates.

## Remove from the product

- Global voice dictation.
- Paste-at-cursor and platform hotkey machinery used only by dictation.
- Dictation translation.
- General voice assistant and computer-use features.
- Snippets and dictation-specific dictionary UI.
- Team spaces and collaborative editing.
- Public web sharing.
- OpenWhispr account, subscription, leaderboard, and hosted sync.
- Enterprise SSO, SCIM, organization policies, and enterprise provider routing.
- Windows and Linux capture/build paths for the first release.
- Bundled local ASR and LLM runtimes for the cloud-first release.
- Qdrant and cross-note semantic search.
- Mandatory realtime meeting transcription.

Calendar vocabulary hints and meeting-specific terminology should remain even if dictation dictionary features are removed.

## Replace

| Current OpenWhispr behavior | OpenHercules behavior |
| --- | --- |
| Streaming transcription is the primary meeting path | Durable recording is primary; batch ASR runs after stop |
| Meeting PCM exists temporarily for diarization | Separate mic and system tracks are durable user-owned artifacts |
| The note row is the practical root entity | Meeting owns recording, processing runs, transcript revisions, and note revisions |
| Stop persists transcript and starts diarization | Stop finalizes recording and enqueues a durable processing pipeline |
| Generate Notes is a separate manual action | Default notes generate automatically after the final transcript |
| Transcript and enhanced content are overwritten | Revisions and provider provenance are retained |
| Provider settings are coupled to existing modes | Each processing stage selects its own provider and model |
| Warnings mostly live in toasts and logs | Capture gaps and degradation persist on the meeting |
| Generic agent and note chat share broad infrastructure | Chat is meeting-scoped and grounded in timestamped artifacts |

## Refactor boundaries

Do not extend the existing large `ipcHandlers.js`, `database.js`, or renderer meeting store with another processing path.

Extract before adding the new behavior:

- `MeetingCaptureService` from meeting IPC setup and teardown;
- `RecordingRepository` from temporary diarization-file handling;
- `MeetingProcessingRunner` from renderer-driven completion behavior;
- meeting repositories and migrations from the database manager;
- stage-specific provider adapters from mixed transcription routing;
- renderer state from capture and persistence orchestration.

No compatibility shim or dual meeting pipeline should remain after cutover. Characterization tests protect the useful existing capture behavior while the new pipeline replaces the old one.

## Reusable existing seams

- File and batch transcription already support several local and cloud routes.
- Meeting capture already distinguishes microphone and system sources.
- The system-audio watchdog already detects stalls and some device invalidation.
- Transcript segments already carry source and timing information.
- Speaker mappings and calendar participants already exist.
- Meeting note prompts and a background reasoning service already exist.

The work is mainly to change ownership and sequencing, not to reimplement every provider.

