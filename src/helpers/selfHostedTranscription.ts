export interface SelfHostedTranscriptionSettings {
  transcriptionMode?: unknown;
  remoteTranscriptionUrl?: unknown;
  remoteTranscriptionModel?: unknown;
}

import { z } from "zod";

const settingsShape = z.object({
  transcriptionMode: z.string().optional(),
  remoteTranscriptionUrl: z.string().optional(),
  remoteTranscriptionModel: z.string().optional(),
});

// Ponytail-lite: callers pass persisted preference bags; tolerate-and-default.
function parseSettings(settings: SelfHostedTranscriptionSettings | null | undefined) {
  return settingsShape
    .nullable()
    .catch(null)
    .parse(settings ?? null);
}

export function isSelfHostedTranscription(
  settings: SelfHostedTranscriptionSettings | null | undefined
): boolean {
  const parsed = parseSettings(settings);
  const mode = parsed?.transcriptionMode?.trim() ?? "";
  const remoteUrl = parsed?.remoteTranscriptionUrl?.trim() ?? "";

  return mode === "self-hosted" && remoteUrl.length > 0;
}

export function resolveSelfHostedTranscriptionModel(
  settings: SelfHostedTranscriptionSettings | null | undefined
): string | null {
  if (!isSelfHostedTranscription(settings)) return null;

  const model = parseSettings(settings)?.remoteTranscriptionModel?.trim() ?? "";

  return model.length > 0 ? model : null;
}
