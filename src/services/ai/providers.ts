import type { LanguageModel } from "ai";
import { getTinfoilLanguageModel } from "./tinfoilClient.js";
import { createAIModel } from "./providerModelFactory.js";

// Renderer-side provider entry point. Meeting summaries use the same factory
// through a main-safe adapter that does not import renderer model settings.
export async function getAIModel(
  provider: string,
  model: string,
  apiKey: string,
  baseURL?: string,
  opts?: { disableThinking?: boolean; omitAuthorization?: boolean }
): Promise<LanguageModel> {
  return createAIModel(
    provider,
    model,
    apiKey,
    baseURL,
    opts,
    getTinfoilLanguageModel
  );
}
