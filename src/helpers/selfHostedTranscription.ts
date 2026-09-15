export interface SelfHostedTranscriptionSettings {
  transcriptionMode?: unknown;
  remoteTranscriptionUrl?: unknown;
  remoteTranscriptionModel?: unknown;
}

export function isSelfHostedTranscription(settings: SelfHostedTranscriptionSettings | null | undefined): boolean {
  const mode =
    typeof settings?.transcriptionMode === "string" ? settings.transcriptionMode.trim() : "";
  const remoteUrl =
    typeof settings?.remoteTranscriptionUrl === "string"
      ? settings.remoteTranscriptionUrl.trim()
      : "";
  return mode === "self-hosted" && remoteUrl.length > 0;
}

export function resolveSelfHostedTranscriptionModel(
  settings: SelfHostedTranscriptionSettings | null | undefined
): string | null {
  if (!isSelfHostedTranscription(settings)) return null;
  const model =
    typeof settings?.remoteTranscriptionModel === "string"
      ? settings.remoteTranscriptionModel.trim()
      : "";
  return model.length > 0 ? model : null;
}
