# ADR-0003: Record then process

Status: Accepted
Date: 2026-09-23
Decided by: Timur

## Context

Meeting assistants can lose a conversation.
This occurs when the system audio stops during a network or device change and the application did not keep the original recording.
Cloud processing is useful, but capture must not depend on the network.

## Decision

- During the meeting, record the microphone and the system audio as separate tracks. Show the health of each track.
- Do not do ASR, diarization, a draft or a live transcript during capture.
- The original tracks are the source of truth. A transcript, a summary and a chat index are artifacts that another provider can make again.
- Only a successful Stop finalizes the recording. Stop creates a durable processing run with a 15-second not-before gate. This state stays after a restart.
- After the gate, send the recording to the file ASR of the selected route, with integrated diarization.
- Save the raw provider response before normalization.
- Storage chunks are for recovery. They do not set ASR request boundaries.
- If a provider limit stops a request, show it as a route error. Do not split, cut or send the audio to a different provider without notice.
- "Batch" means processing after Stop. A provider Batch API is not necessary.
- Keep provider-specific payloads behind canonical stage contracts. The provider registry is a static TypeScript table.
- A source channel and a speaker identity are different. The microphone is not automatically the user. Equal speaker IDs from different requests are not the same person. A calendar participant is only a candidate.

## Alternatives considered

- Transcription of one-minute fragments during the recording (VAD windows, overlap, a live queue, speaker matching across fragments) and a local draft.
  We examined 15 open-source projects and rejected this option.
  Speaker and boundary matching adds much complexity and does not help the main goal.
  The research was in `docs/transcription-chunking-research.md`. That file was removed in the memory bank restructure commit `e549bb3bb`; the last revision before that is in the Git history.

## Consequences

- Never change a dual-track recording to a mic-only recording that looks complete.
- A retry must not delete or overwrite raw audio or previous artifacts.
- Implementation: [recording and processing](../architecture/recording-processing.md), [post-Stop processing](../architecture/post-stop-processing.md).
- Provider quality and cost are evaluation questions. They do not block implementation.
