# Processing routes

This document contains the provider and model routes of each task and their limits.
User paths: [Choose processing routes](../product/user-journeys/providers.md). Meeting provider limits: [post-Stop processing](post-stop-processing.md).

## Task catalogs

- Provider presence in the registry does not mean support for every task. The task picker and the executor restrict the set.
- Task sources: Meeting recording and Audio upload use Cloud and On-device. Meeting summary and Chat use Cloud, On-device, Self-hosted and bb.
- Chat and Summary model choices are a separate catalog. Anthropic, Bedrock, Azure or Vertex support elsewhere does not mean meeting ASR support.

## Meeting transcription

- Meeting cloud file routes in the picker: Deepgram Nova, ElevenLabs Scribe v2, Gemini 3.5 Transcribe and OpenAI gpt-4o-transcribe-diarize. Meeting processing also has a Local path.
- Stored OpenAI meeting configurations can be accepted by the executor, but the picker offers the diarization model.
- There is no Custom or Self-Hosted meeting route.

## Upload transcription

- General Upload and batch routes include OpenAI, Groq, xAI, Mistral, Gemini, Corti, Tinfoil, Deepgram and ElevenLabs, plus Custom, Local and Self-Hosted.
- AssemblyAI registry presence does not give a supported current batch or meeting-picker route.
- Gemini batch is restricted to gemini-3.5-transcribe. Deepgram uses Nova, not Flux.
- Self-Hosted uses its dedicated OpenAI-compatible endpoint configuration. Custom is a separate keyed route. They are not interchangeable.

## Local dispatch

- Local file dispatch supports Whisper, Parakeet and Cohere. Cohere requires the selected language, not auto-detection.
- A local model download does not change the selected task route.

## Size limits

- Upload size checks allow 2 GiB for Deepgram and Gemini, 3 GiB for ElevenLabs and 25 MiB for other BYOK routes. Custom has a 25 MiB cap.
- URL download has the separate 500 MiB cap.
- Local and Self-Hosted have no app-level size cap in this path.
- Single and batch Upload use the same route size cap as main.

## Failure rules

- An unsupported route fails with a capability error. Gristmill does not select a different provider silently.
- Recording is local. These transcription routes process saved audio after Stop. They do not enable live transcription.

## Code locations

- `src/components/settings/models/taskCatalog.ts`, `src/components/settings/models/taskModels.ts` — task catalogs and sources.
- `src/models/ModelRegistry.ts` — registry access.
- `src/helpers/meetingFileTranscription.ts` — meeting route contract.
- `src/helpers/transcriptionRoute.ts` — batch routes and limits.
- `src/services/fileTranscription.ts` — Local and diarization dispatch.
- `src/config/transcriptionCapabilities.ts` — Upload size checks.
