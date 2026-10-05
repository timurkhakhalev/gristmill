const modelRegistryData = require("../models/modelRegistryData.json");

import { getModelType } from "./parakeetModelInfo.js";

// Every local speech-to-text model the registry knows, with whether it is on
// disk and whether it is the one the app is set to use. The "default" comes
// from the .env values the renderer persists for server pre-warming, which is
// the only copy of that setting the main process has.
export interface LocalModelListEntry {
  provider: "whisper" | "cohere" | "nvidia";
  model: string;
  downloaded: boolean;
  default: boolean;
}

export interface LocalTranscriptionManagers {
  whisperManager: { isModelDownloaded(model: string): boolean };
  parakeetManager: { isModelDownloaded(model: string): boolean };
}

export function listLocalTranscriptionModels({
  whisperManager,
  parakeetManager,
  env = process.env,
}: LocalTranscriptionManagers & {
  env?: Record<string, string | undefined>;
}): LocalModelListEntry[] {
  const configuredProvider = env.LOCAL_TRANSCRIPTION_PROVIDER || "";

  const configuredModel =
    configuredProvider === "whisper" ? env.LOCAL_WHISPER_MODEL || "" : env.PARAKEET_MODEL || "";

  const isDefault = (provider: string, model: string): boolean =>
    provider === configuredProvider && model === configuredModel;

  const whisper: LocalModelListEntry[] = Object.keys(modelRegistryData.whisperModels).map(
    (model) => ({
      provider: "whisper",
      model,
      downloaded: whisperManager.isModelDownloaded(model),
      default: isDefault("whisper", model),
    })
  );

  const sherpa: LocalModelListEntry[] = Object.keys(modelRegistryData.parakeetModels).map(
    (model) => {
      const provider = getModelType(model) === "cohere-transcribe" ? "cohere" : "nvidia";

      return {
        provider,
        model,
        downloaded: parakeetManager.isModelDownloaded(model),
        default: isDefault(provider, model),
      };
    }
  );

  return [...whisper, ...sherpa];
}
