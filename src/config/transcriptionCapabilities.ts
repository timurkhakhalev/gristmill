// Static transcription provider capabilities shared by the store, the route
// guard and the pure settings selectors. Keep provider-specific decisions in
// one hand-maintained place: Corti's only model is realtime too, yet it
// batches through the proxy, so this list cannot be derived from the registry.

// Deepgram and AssemblyAI have no OpenAI-compatible /audio/transcriptions, so
// they exist only as realtime providers. A batch/upload/retry request for them
// has to fail closed: the fall-through at the end of resolveTranscriptionRoute
// would otherwise POST the user's audio to api.openai.com with their OpenAI key.
export const STREAMING_ONLY_PROVIDERS = new Set(["deepgram", "assemblyai"]);

// Single source for the default cloud transcription provider used by the
// store defaults and the upload selector's fail-closed substitution.
export const DEFAULT_CLOUD_TRANSCRIPTION_PROVIDER = "openai";
