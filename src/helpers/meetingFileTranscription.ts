// The post-Stop worker accepts only these file routes. The settings picker and
// provider-switch defaults use this same contract.
export function supportedMeetingFileProvider(
  provider: string | undefined,
  model: string | undefined
): "deepgram" | "elevenlabs" | "gemini" | "openai" | null {
  if (provider === "deepgram" && (!model || model.startsWith("nova-"))) return "deepgram";
  if (provider === "elevenlabs" && (!model || model === "scribe_v2")) return "elevenlabs";
  if (provider === "gemini" && (!model || model === "gemini-3.5-transcribe")) return "gemini";
  if (
    provider === "openai" &&
    (!model ||
      ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "gpt-4o-transcribe-diarize"].includes(model))
  )
    return "openai";
  return null;
}

export function isMeetingFilePickerModel(provider: string, model: string): boolean {
  // The file executor requests diarization and sends this model to OpenAI,
  // regardless of which older OpenAI transcription model was saved.
  return (
    supportedMeetingFileProvider(provider, model) !== null &&
    (provider !== "openai" || model === "gpt-4o-transcribe-diarize")
  );
}
