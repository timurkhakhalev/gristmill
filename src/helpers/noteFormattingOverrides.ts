// Provider overrides for note-formatting ReasoningService.processText calls.
// Self-hosted must forward remoteUrl as lanUrl — without it, processText
// would use the dictation-cleanup scope instead of this scope's endpoint.

export type NoteFormattingScopeOverrides = {
  inferenceScope: "noteFormatting";
  provider?: string;
  baseUrl?: string;
  customApiKey?: string;
  lanUrl?: string;
};

// The settings-slice shape the store actually passes; unknown/absent fields
// normalize like the JS version did instead of rejecting.
export interface NoteFormattingSettings {
  mode?: string | null;
  provider?: string | null;
  cloudBaseUrl?: string | null;
  remoteUrl?: string | null;
  customApiKey?: string | null;
}

export function buildNoteFormattingOverrides(
  noteFormatting: NoteFormattingSettings | null | undefined,
  isCloudMode: boolean
): NoteFormattingScopeOverrides {
  if (isCloudMode) {
    return {
      inferenceScope: "noteFormatting",
      baseUrl: undefined,
      customApiKey: undefined,
      lanUrl: undefined,
    };
  }

  const mode = noteFormatting?.mode;

  if (mode === "self-hosted") {
    return {
      inferenceScope: "noteFormatting",
      provider: undefined,
      baseUrl: undefined,
      customApiKey: noteFormatting?.customApiKey || undefined,
      lanUrl: noteFormatting?.remoteUrl || undefined,
    };
  }

  // Local and enterprise must pin their providers too, or processText would
  // use the dictation-cleanup scope when this scope has no route override.
  const provider =
    mode === "local"
      ? "local"
      : mode === "providers" || mode === "enterprise"
        ? noteFormatting?.provider || undefined
        : undefined;
  const isCustom = provider === "custom";
  return {
    inferenceScope: "noteFormatting",
    provider,
    baseUrl: isCustom ? noteFormatting?.cloudBaseUrl || undefined : undefined,
    customApiKey: isCustom ? noteFormatting?.customApiKey || undefined : undefined,
    lanUrl: undefined,
  };
}
