# Choose processing routes

As a Gristmill user, I want to select models supported by the task I want to run.

## User journey

1. Open Settings → Models and choose the task.
2. Select an offered cloud, Local or supported endpoint route.
3. Configure the required access in Providers or download a local model in On-device.
4. Run Upload or post-Stop meeting processing with those settings.

## Behavior and limits

- Provider presence in the registry does not mean support for every task. The task picker and executor restrict the set.
- Meeting cloud file routes are Deepgram Nova, ElevenLabs Scribe v2, Gemini 3.5 Transcribe and OpenAI gpt-4o-transcribe-diarize in the picker. Meeting processing also has a Local path.
- General Upload/batch routes include OpenAI, Groq, xAI, Mistral, Gemini, Corti, Tinfoil, Deepgram and ElevenLabs, plus Custom, Local and Self-Hosted. AssemblyAI registry presence does not provide a supported current batch or meeting-picker route.
- Gemini batch is restricted to gemini-3.5-transcribe; Deepgram uses Nova rather than Flux. Stored OpenAI meeting configurations can be accepted by the executor, but the picker offers the diarization model.
- Local file dispatch supports Whisper, Parakeet and Cohere. Cohere requires the selected language rather than auto-detection.
- Self-Hosted uses its dedicated OpenAI-compatible endpoint configuration. Custom is a separate keyed route. They are not interchangeable meeting routes.
- Upload size checks allow 2 GiB for Deepgram/Gemini, 3 GiB for ElevenLabs and 25 MiB for other BYOK routes. URL download has the separate 500 MiB cap. Local and Self-Hosted have no app-level size cap in this path.
- Custom UI bypasses its initial size check, but the route enforces 25 MiB. Do not describe Custom as unlimited.
- Chat/Summary model choices are a separate catalog. Anthropic, Bedrock, Azure or Vertex support elsewhere does not imply meeting ASR support.
- Recording is local. These transcription routes process saved audio after Stop; they do not enable live transcription.

## What to check

- Each task offers only supported routes.
- A local model download does not select it automatically.
- Provider errors retain saved meeting audio for retry.

## BDD acceptance criteria

- Given I select Meeting, when the cloud picker opens, then it offers the meeting file-route subset.
- Given an unsupported batch route is supplied, when it is resolved, then it fails with a capability error rather than silently selecting another provider.

## Entry points

- [taskCatalog.ts](../../../src/components/settings/models/taskCatalog.ts) — task catalogs.
- [ModelRegistry.ts](../../../src/models/ModelRegistry.ts) — registry access.
- [meetingFileTranscription.ts](../../../src/helpers/meetingFileTranscription.ts) — meeting route contract.
- [transcriptionRoute.ts](../../../src/helpers/transcriptionRoute.ts) — batch routes and limits.
- [fileTranscription.ts](../../../src/services/fileTranscription.ts) — Local and diarization dispatch.
- [transcriptionCapabilities.ts](../../../src/config/transcriptionCapabilities.ts) — Upload size checks.
