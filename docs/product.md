# Product requirements

## Current delivery contract

Cleanup is complete. The M1–M4 record-then-process implementation adds durable
mic/system tracks, post-Stop processing, saved result versions, selected-result
Notes projection, playback/export, and configurable audio retention. Final
integrated verification and live mic/system hardware smoke are still pending;
see [record-then-process status](record-then-process.md).

After a successful Stop, a durable 15-second gate runs before preparation and
ASR. A saved transcript can produce one Markdown Summary. Automatic Summary
requires at least 180 seconds of audio and 2,500 transcript characters; users
can generate Summary manually for shorter meetings. Prioritized tasks and a
manual Recap are sections in the same Summary. Follow-up is drafted as an
assistant message in the existing embedded Chat and is never sent externally.

Preserve Notes (including blank notes and manual text), the embedded chat and
tools, file/direct URL import, Dictionary/Snippets, calendars, speaker profiles,
and existing BYOK, Local, Self-Hosted, and direct provider routes. No new
dashboard or meeting-only replacement for Notes is part of this delivery.

## Problem

Existing meeting assistants can produce useful notes while still failing at the most important responsibility: preserving the conversation. If system audio disappears during a connection or device transition and the application does not retain the original recording, the meeting cannot be recovered or reprocessed.

Cloud processing is useful, but capture must not depend on a stable cloud connection. The user should be able to switch Wi-Fi, hotspot, or VPN during a call without losing either side of the recording.

## Product statement

OpenHercules is a bot-free meeting recorder for macOS. During a call it records microphone and system audio locally and preserves both sources. After Stop it finalizes the recording, runs ordinary file transcription with diarization, and generates notes from the final transcript. There is no live transcript or draft. See [the agreed flow and validation hypotheses](record-then-process.md).

## Primary user

A technical individual user who:

- joins calls from a Mac;
- does not want a bot visible in the meeting;
- uses direct cloud providers, Local or supported Self-Hosted models;
- cares more about the final result than a realtime transcript;
- wants control over recordings and the ability to retry processing;
- expects integrations and prompts to be customizable.

## Product principles

1. **Audio first.** Original audio is the source of truth.
2. **Capture is offline.** Recording never depends on an ASR or LLM connection.
3. **No silent loss.** Missing or interrupted tracks are persistent, visible states.
4. **Every derived artifact is replaceable.** Processing can be rerun with another provider.
5. **Separate tracks stay separate.** Microphone and system audio are not reduced to one mixed file internally.
6. **Process after Stop.** Capture performs no ASR or diarization. Once audio is finalized, process it through ordinary file requests; network failures leave saved audio available for retry.
7. **The user owns the files.** Audio, transcripts, and notes are exportable and explicitly deletable.
8. **No invented identities.** Calendar participants are hints; speaker identity requires evidence or user confirmation.

## Primary journey

1. A calendar event or active call causes OpenHercules to show a small recording prompt.
2. The user starts recording without adding a bot to the call.
3. OpenHercules captures microphone and system audio into separate durable local tracks.
4. A compact pill shows recording duration and health for both tracks.
5. If a source stops, OpenHercules shows a persistent warning and records the gap.
6. During the call, OpenHercules saves both sources and displays recording duration and capture health. No transcript or draft is generated.
7. A successful Stop closes both raw source epochs and persists a 15-second not-before deadline before preparation or ASR. Pause does not queue processing; Resume invalidates the pending run for the earlier group. Restart respects the saved deadline.
8. A single derived mono timeline WAV is processed through the selected supported provider route; the raw provider response is stored before normalization. Speaker names may be suggested from transcript evidence, and user corrections take precedence.
9. Automatic Summary follows the saved transcript only when both thresholds are met: 180 seconds and 2,500 transcript characters. A user can start Summary manually for any ready transcript. Summary uses corrected full transcript segments and a saved prompt/model snapshot.
10. Meeting recordings and result history attach to the existing Note. The selected transcript and the single Summary Markdown artifact project into existing Notes fields; manual content stays separate. Prior runs and raw tracks remain available after retry.
11. Prioritized tasks fill the Summary's existing `## Action Items` section; zero tasks remove that section. An optional manual Recap uses the same Markdown under revision checks. Follow-up drafts a normal assistant reply in the existing Chat; no message is sent externally.
12. The user can select a completed result version, correct speakers, play/seek and export audio, create an ASR run with another provider/model, or retry Summary from a saved transcript.

## Required capabilities

### Capture and recovery

- Record microphone and system audio separately.
- Preserve completed chunks if the app or renderer crashes.
- Recover an unfinished meeting after restart.
- Continue recording during network and VPN transitions.
- Detect a missing or stalled system-audio source.
- Record device changes, interruptions, gaps, and per-track durations.
- Never discard a recording because transcription or summary failed.

### Processing after the meeting

- Start ordinary non-realtime file transcription only after Stop and durable finalization. No ASR, draft or diarization runs during capture.
- Persist pending recording-processing jobs across restarts and retry from saved audio after network/provider failures.
- Prepare one full-timeline mono WAV from saved epochs and preserve raw source tracks separately. Do not require a second full ASR pass or merge independent track transcripts.
- Storage chunk boundaries do not define ASR requests. Splitting for provider limits requires an explicit completeness and speaker-continuity design.
- Batch means processing saved audio after the meeting, not a requirement to use a provider Batch API.
- Configurable language and vocabulary hints, with Russian as a first-class case.
- Use the selected route's integrated diarization when available; keep names scoped to a run until corrected or confirmed.
- Automatic note generation after the final transcript is available.
- Apply the inclusive 180-second and 2,500-character automatic Summary thresholds; keep manual Summary available for any ready transcript.
- Keep one Summary Markdown artifact. Tasks update only `## Action Items`; Recap is optional and manual; conflicts preserve user edits and earlier results.
- Retry transcription and summary independently. Retry diarization separately only where the chosen provider actually exposes an independent operation; an integrated response is one processing result.
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

- Preserve full embedded note chat, including note creation and editing tools.
- Use transcript, manual notes, generated notes, and meeting metadata as context.
- Link factual answers to transcript timestamps.
- Keep chat history per meeting.
- Offer the editable Follow-up Action as a draft in the existing Chat. Store it as a normal assistant message and never send it externally.
- Preserve explicit local cross-note search and access; do not add a single-note restriction.

### Integrations and customization

- Google, Microsoft, and Apple Calendar integration.
- User-defined meeting categories, tags, and note templates.
- ElevenLabs, Deepgram and Gemini are included in the first post-Stop implementation, with explicit provider selection and visible capability/limit errors. Comparative evaluation is performed by Timur after implementation.
- Provider and model settings for transcription, summary, and chat. Integrated diarization belongs to transcription settings; expose a separate diarization selection only for a supported independent path.
- Preserve all existing direct cloud, on-demand Local and supported Self-Hosted implementations.

## Initial non-goals

- Global voice dictation and paste-at-cursor.
- Dictation translation.
- General voice assistant or computer-use agent.
- Team workspaces and collaborative editing.
- Public web sharing.
- Hosted OpenHercules sync or subscription accounts.
- Enterprise SSO, SCIM, or organization policies.
- Windows and Linux clients.
- Cross-meeting semantic search.
- Live transcript/draft or ASR during capture; the implemented flow processes after Stop.
- A marketplace or dynamically installed plugin SDK.

## Required failure scenarios

These are implementation and verification requirements. M1–M3 focused root gates
passed. M4 focused and final integration checks remain root-owned; live
mic/system tail-loss and restart checks remain unverified.

1. Switching Wi-Fi, hotspot, and VPN during a meeting does not interrupt either local track.
2. A cloud provider outage leaves the meeting queued and retryable.
3. A missing system track produces a persistent warning and a degraded meeting state.
4. A crash leaves previously completed audio chunks recoverable.
5. A poor transcript can be rerun through another ASR without touching the original recording.
6. A failed summary leaves audio and transcript available and can be retried independently.
7. Correcting a speaker updates the meeting presentation without mutating raw provider output.
8. Every displayed transcript segment can be traced to a recording interval and processing run.
9. Recording starts without a cloud connection or loaded ASR model; no ASR/diarization request or local inference runs during capture.
10. Stop persists all captured samples before the processing job becomes runnable.

## Later candidates

- Live transcript or draft only after a new explicit product decision; excluded from the agreed recording flow.
- New ASR/diarization/LLM models beyond the preserved local and direct providers.
- Semantic search (existing local cross-note tools remain).
- MCP or a public local API.
- Action-item integrations.
- Sharing and collaboration, if a real requirement appears.
