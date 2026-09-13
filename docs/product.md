# Product requirements

## Problem

Existing meeting assistants can produce useful notes while still failing at the most important responsibility: preserving the conversation. If system audio disappears during a connection or device transition and the application does not retain the original recording, the meeting cannot be recovered or reprocessed.

Cloud processing is useful, but capture must not depend on a stable cloud connection. The user should be able to switch Wi-Fi, hotspot, or VPN during a call without losing either side of the recording.

## Product statement

OpenHercules is a bot-free meeting recorder for macOS. It captures the user's microphone and system audio locally, preserves both sources, and processes the completed meeting through configurable transcription, diarization, note-generation, and chat providers.

## Primary user

A technical individual user who:

- joins calls from a Mac;
- does not want a bot visible in the meeting;
- prefers cloud models but may use local models later;
- cares more about the final result than a realtime transcript;
- wants control over recordings and the ability to retry processing;
- expects integrations and prompts to be customizable.

## Product principles

1. **Audio first.** Original audio is the source of truth.
2. **Capture is offline.** Recording never depends on an ASR or LLM connection.
3. **No silent loss.** Missing or interrupted tracks are persistent, visible states.
4. **Every derived artifact is replaceable.** Processing can be rerun with another provider.
5. **Separate tracks stay separate.** Microphone and system audio are not reduced to one mixed file internally.
6. **Realtime is optional.** Preview may fail without invalidating the final recording.
7. **The user owns the files.** Audio, transcripts, and notes are exportable and explicitly deletable.
8. **No invented identities.** Calendar participants are hints; speaker identity requires evidence or user confirmation.

## Primary journey

1. A calendar event or active call causes OpenHercules to show a small recording prompt.
2. The user starts recording without adding a bot to the call.
3. OpenHercules captures microphone and system audio into separate durable local tracks.
4. A compact pill shows recording duration and health for both tracks.
5. If a source stops, OpenHercules shows a persistent warning and records the gap.
6. When the meeting ends, OpenHercules finalizes the recording locally before making cloud requests.
7. A durable background pipeline transcribes, diarizes, merges, and generates notes.
8. The meeting detail view exposes audio, transcript, notes, participants, processing history, and chat.
9. The user can correct speakers, change a model or template, and rerun an individual stage.

## Required capabilities

### Capture and recovery

- Record microphone and system audio separately.
- Preserve completed chunks if the app or renderer crashes.
- Recover an unfinished meeting after restart.
- Continue recording during network and VPN transitions.
- Detect a missing or stalled system-audio source.
- Record device changes, interruptions, gaps, and per-track durations.
- Never discard a recording because transcription or summary failed.

### Post-meeting processing

- Batch transcription after the recording is finalized.
- Configurable language and vocabulary hints, with Russian as a first-class case.
- Optional diarization of the remote/system track.
- Deterministic merge of track transcripts and speaker turns.
- Automatic note generation after the final transcript is available.
- Independent retry of transcription, diarization, merge, and summary.
- Processing history containing provider, model, configuration, status, and errors.
- Multiple transcript and note revisions without overwriting previous results.

### Meeting detail

- Play the meeting and jump from a transcript segment to its timestamp.
- Download or reveal the original microphone and system tracks.
- Export transcript as Markdown, text, JSON, and SRT where timing is available.
- Edit title, category, tags, participants, and speaker mappings.
- Add manual notes before or after the meeting.
- Select a summary template and regenerate notes.
- Display incomplete or degraded capture prominently.

### Chat

- Ask questions about one meeting.
- Use transcript, manual notes, generated notes, and meeting metadata as context.
- Link factual answers to transcript timestamps.
- Keep chat history per meeting.
- Do not silently answer from unrelated meetings.

### Integrations and customization

- Google, Microsoft, and Apple Calendar integration.
- User-defined meeting categories, tags, and note templates.
- Separate provider and model settings for transcription, diarization, summary, and chat.
- Cloud-first provider support without preventing future local implementations.

## Initial non-goals

- Global voice dictation and paste-at-cursor.
- Dictation translation.
- General voice assistant or computer-use agent.
- Team workspaces and collaborative editing.
- Public web sharing.
- Hosted OpenHercules sync or subscription accounts.
- Enterprise SSO, SCIM, or organization policies.
- Windows and Linux clients.
- Voice fingerprinting across meetings.
- Cross-meeting semantic search.
- Mandatory realtime transcription.
- A marketplace or dynamically installed plugin SDK.

## Required failure scenarios

The first useful release is not complete until these scenarios work:

1. Switching Wi-Fi, hotspot, and VPN during a meeting does not interrupt either local track.
2. A cloud provider outage leaves the meeting queued and retryable.
3. A missing system track produces a persistent warning and a degraded meeting state.
4. A crash leaves previously completed audio chunks recoverable.
5. A poor transcript can be rerun through another ASR without touching the original recording.
6. A failed summary leaves audio and transcript available and can be retried independently.
7. Correcting a speaker updates the meeting presentation without mutating raw provider output.
8. Every displayed transcript segment can be traced to a recording interval and processing run.

## Later candidates

- Optional live transcript preview.
- Local ASR, diarization, and LLM providers.
- Cross-meeting questions and semantic search.
- MCP or a public local API.
- Action-item integrations.
- Sharing and collaboration, if a real requirement appears.

