// Static transcription provider capabilities shared by the store, the route
// guard and the pure settings selectors. Keep provider-specific decisions in
// one hand-maintained place: Corti's only model is realtime too, yet it
// batches through the proxy, so this list cannot be derived from the registry.

// AssemblyAI has no OpenAI-compatible /audio/transcriptions route, so
// it exists only as a realtime provider. A batch/upload/retry request for it
// has to fail closed: the fall-through at the end of resolveTranscriptionRoute
// would otherwise POST the user's audio to api.openai.com with their OpenAI key.
export const STREAMING_ONLY_PROVIDERS = new Set(["assemblyai"]);
export const DEEPGRAM_FILE_SIZE_LIMIT = 2 * 1024 * 1024 * 1024;
export const ELEVENLABS_FILE_SIZE_LIMIT = 3 * 1024 * 1024 * 1024;

// Single source for the default cloud transcription provider used by the
// store defaults and the upload selector's fail-closed substitution.
export const DEFAULT_CLOUD_TRANSCRIPTION_PROVIDER = "openai";
