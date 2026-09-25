import type { LanguageModel } from "ai";
import { createAIModel } from "../services/ai/providerModelFactory.js";

async function createTinfoilModel(apiKey: string, model: string): Promise<LanguageModel> {
  const { createTinfoilAI } = await import("tinfoil");
  const provider = await createTinfoilAI(apiKey);
  return provider(model) as LanguageModel;
}

export function getMeetingAIModel(
  provider: string,
  model: string,
  apiKey: string,
  baseURL?: string,
  options?: { disableThinking?: boolean; omitAuthorization?: boolean }
): Promise<LanguageModel> {
  return createAIModel(provider, model, apiKey, baseURL, options, createTinfoilModel);
}
