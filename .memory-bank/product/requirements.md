# Product requirements

- Scope boundaries, non-goals and future candidates: [scope](scope.md).

## Problem

Meeting assistants can make useful notes but fail at the most important task: to keep the conversation.
If the system audio stops during a connection or device change, and the application did not keep the original recording, you cannot recover or process the meeting again.

Cloud processing is useful, but capture must not depend on a stable cloud connection.
The user must be able to change Wi-Fi, hotspot or VPN during a call without loss of either side of the recording.

## Product statement

Gristmill is a meeting recorder for macOS that does not add a bot to the call.
During a call, it records the microphone and the system audio locally and keeps both sources.
After Stop, it finalizes the recording, runs ordinary file transcription with diarization and makes notes from the final transcript.
There is no live transcript and no draft.
See [ADR-0003](../adr/0003-record-then-process.md) and [post-Stop processing](../architecture/post-stop-processing.md).

## Primary user

A technical individual user who:

- joins calls from a Mac;
- does not want a visible bot in the meeting;
- uses direct cloud providers, Local models or supported Self-Hosted models;
- thinks that the final result is more important than a realtime transcript;
- wants control of the recordings and the possibility to process them again;
- wants to customize integrations and prompts.

## Product principles

1. **Audio first.** The original audio is the source of truth.
2. **Capture is offline.** Recording never depends on an ASR or LLM connection.
3. **No silent loss.** A missing or interrupted track is a persistent, visible state.
4. **Each derived artifact is replaceable.** You can process the recording again with a different provider.
5. **Separate tracks stay separate.** Gristmill does not mix the microphone and the system audio into one internal file.
6. **Process after Stop.** Capture does no ASR or diarization. After the audio is finalized, ordinary file requests process it. If the network fails, the saved audio stays available for a retry.
7. **The user owns the files.** The user can export and delete audio, transcripts and notes.
8. **No invented identities.** Calendar participants are hints. A speaker identity needs evidence or user confirmation.

## Primary journey

1. A calendar event or an active call causes Gristmill to show a small recording prompt.
2. The user starts the recording. No bot joins the call.
3. Gristmill captures the microphone and the system audio into separate durable local tracks.
4. A compact pill shows the recording duration and the health of both tracks.
5. If a source stops, Gristmill shows a persistent warning and records the gap.
6. During the call, Gristmill saves both sources and shows the duration and capture health. It does not make a transcript or a draft.
7. A successful Stop closes both raw source epochs and saves a 15-second not-before deadline before preparation or ASR. Pause does not put processing in the queue. Resume makes the pending run of the previous group invalid. A restart obeys the saved deadline.
8. The selected provider route processes temporary full-timeline WAV inputs: stereo for Deepgram, separate mono source tracks for the other cloud providers, mono for Local. The raw provider response is saved before normalization. Gristmill can suggest speaker names from transcript evidence. User corrections have priority.
9. An automatic Summary follows the saved transcript only when both thresholds are met: 180 seconds and 2,500 transcript characters. The user can start a Summary manually for each ready transcript. The Summary uses the corrected full transcript segments and a saved prompt and model snapshot.
10. Meeting recordings and result history attach to the existing Note. The selected transcript and the single Summary Markdown artifact show in the existing Notes fields. Manual content stays separate. Previous runs and raw tracks stay available after a retry.
11. Prioritized tasks fill the existing `## Action Items` section of the Summary. Zero tasks remove this section. An optional manual Recap uses the same Markdown with revision checks. Follow-up makes a normal assistant reply draft in the existing Chat. Gristmill sends no message anywhere.
12. The user can select a completed result version, correct speakers, play and seek audio, export audio, start an ASR run with a different provider or model, or try the Summary again from a saved transcript.

## Required capabilities

### Capture and recovery

- Record the microphone and the system audio separately.
- Keep completed chunks if the app or the renderer crashes.
- Recover an unfinished meeting after a restart.
- Continue to record during network and VPN changes.
- Find a missing or stalled system audio source.
- Record device changes, interruptions, gaps and the duration of each track.
- Never discard a recording because transcription or summary failed.

### Processing after the meeting

- Start ordinary file transcription only after Stop and durable finalization. No ASR, draft or diarization runs during capture.
- Persist pending processing jobs across restarts. After network or provider failures, try again from the saved audio.
- Prepare the full-timeline WAV input of the selected route from the saved epochs: stereo for Deepgram, separate mono microphone and system files for other cloud routes, mono for Local. Keep the raw source tracks separately.
- Storage chunk boundaries do not set ASR requests. A split for provider limits needs an explicit design for completeness and speaker continuity.
- "Batch" means processing of saved audio after the meeting. A provider Batch API is not necessary.
- Let the user configure language and vocabulary hints. Russian is a primary case.
- Use the integrated diarization of the selected route when it is available. Keep names in the scope of one run until the user corrects or confirms them.
- Make notes automatically after the final transcript is available.
- Apply the inclusive automatic Summary thresholds: 180 seconds and 2,500 characters. Keep the manual Summary available for each ready transcript.
- Keep one Summary Markdown artifact. Tasks update only `## Action Items`. Recap is optional and manual. A conflict keeps user edits and earlier results.
- Let the user try transcription and summary again independently. Try diarization again separately only when the provider has an independent operation. An integrated response is one processing result.
- Keep a processing history with provider, model, configuration, status and errors.
- Keep many transcript and note revisions. Do not overwrite previous results.

### Meeting detail

- Play the meeting and go from a transcript segment to its timestamp.
- Download or show the original microphone and system tracks.
- Export the transcript as Markdown, text, JSON and SRT when timing is available.
- Edit the title, category, tags, participants and speaker mappings.
- Add manual notes before or after the meeting.
- Select a summary template and make the notes again.
- Show incomplete or degraded capture clearly.

### Chat

- Keep the full embedded Note chat, with its tools that create and edit notes.
- Use the transcript, manual notes, generated notes and meeting metadata as context.
- Link factual answers to transcript timestamps.
- Keep the chat history for each meeting.
- Offer the editable Follow-up Action as a draft in the existing Chat. Store it as a normal assistant message. Never send it anywhere.
- Keep explicit local cross-note search and access. Do not limit the chat to one note.

### Integrations and customization

- Google, Microsoft and Apple Calendar integration.
- User-defined meeting categories, tags and note templates.
- ElevenLabs, Deepgram, Gemini and OpenAI file routes, with explicit provider selection and visible capability and limit errors.
- Provider and model settings for transcription, summary and chat. Integrated diarization is part of the transcription settings. Show a separate diarization selection only for a supported independent path.
- Keep all existing direct cloud, on-demand Local and supported Self-Hosted implementations.

## Required failure scenarios

These are implementation and verification requirements.
Live microphone and system tail-loss and restart checks need isolated hardware verification.

1. A change of Wi-Fi, hotspot or VPN during a meeting does not interrupt either local track.
2. A cloud provider outage keeps the meeting in the queue and available for a retry.
3. A missing system track causes a persistent warning and a degraded meeting state.
4. After a crash, the previously completed audio chunks are recoverable.
5. You can process a poor transcript again with a different ASR. The original recording does not change.
6. After a failed summary, the audio and the transcript stay available. You can try the summary again independently.
7. A speaker correction updates the meeting presentation. It does not change the raw provider output.
8. You can trace each displayed transcript segment to a recording interval and a processing run.
9. Recording starts without a cloud connection or a loaded ASR model. No ASR or diarization request and no local inference runs during capture.
10. Stop saves all captured samples before the processing job can run.

## Folders

- A new profile starts with one Personal folder.
- The user can rename or delete each folder.
- When the user deletes a folder, its notes stay in their other folders or move to the space root.
- A note without an explicit folder stays at the space root. This includes calendar meetings.
- Uploads offer a "No folder" destination.
- Existing folders stay.
