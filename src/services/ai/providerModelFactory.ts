import { createOpenAI } from "@ai-sdk/openai";
import { createGroq } from "@ai-sdk/groq";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { API_ENDPOINTS } from "../../config/constants.mts";
import { openCodeSessionHeaders } from "./openCodeSession.js";

export type TinfoilLanguageModelFactory = (apiKey: string, model: string) => Promise<LanguageModel>;

// OpenRouter's reasoning control is a top-level request field the AI SDK
// can't emit, so inject it at the fetch boundary.
const withDisabledReasoning: typeof fetch = (input, init) => {
  if (typeof init?.body === "string") {
    try {
      const body = JSON.parse(init.body);
      body.reasoning = { enabled: false };
      init = { ...init, body: JSON.stringify(body) };
    } catch {}
  }

  return fetch(input, init);
};

export async function createAIModel(
  provider: string,
  model: string,
  apiKey: string,
  baseURL: string | undefined,
  opts: { disableThinking?: boolean; omitAuthorization?: boolean } | undefined,
  createTinfoilModel: TinfoilLanguageModelFactory
): Promise<LanguageModel> {
  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey })(model);
    case "groq":
      return createGroq({ apiKey })(model);
    case "anthropic":
      return createAnthropic({
        apiKey,
        headers: { "anthropic-dangerous-direct-browser-access": "true" },
      })(model);
    case "gemini":
      return createGoogleGenerativeAI({ apiKey })(model);
    case "tinfoil":
      return createTinfoilModel(apiKey, model);
    case "corti":
      return createOpenAI({ apiKey, baseURL: API_ENDPOINTS.CORTI_MODELS_BASE }).chat(model);
    case "custom":
      return createOpenAI({
        apiKey,
        baseURL,
        headers: openCodeSessionHeaders(baseURL),
      }).chat(model);
    case "openrouter":
      return createOpenAI({
        apiKey,
        baseURL,
        ...(opts?.disableThinking ? { fetch: withDisabledReasoning } : {}),
      }).chat(model);
    case "local":
      return createOpenAI({
        apiKey: apiKey || "no-key",
        baseURL,
        ...(opts?.omitAuthorization
          ? {
              fetch: (input, init) => {
                const headers = new Headers(init?.headers);
                headers.delete("authorization");

                return fetch(input, { ...init, headers });
              },
            }
          : {}),
      }).chat(model);
    default:
      throw new Error(`Unsupported AI SDK provider for renderer: ${provider}`);
  }
}
