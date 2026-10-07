import { createOpenAI } from "@ai-sdk/openai";
import { createGroq } from "@ai-sdk/groq";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { API_ENDPOINTS } from "../../config/constants.mts";
import { openCodeSessionHeaders } from "./openCodeSession.js";

export type TinfoilLanguageModelFactory = (apiKey: string, model: string) => Promise<LanguageModel>;

// Narrow a fetch body to a string without naming the DOM BodyInit type, which
// is not in the main-process lib.
function isStringBody(value: RequestInit["body"]): value is string {
  return typeof value === "string";
}

// Decoded AI SDK request body: arbitrary JSON keys, mutated before re-encoding.
const requestBodySchema = z.record(z.string(), z.unknown());

// OpenRouter's reasoning control is a top-level request field the AI SDK
// can't emit, so inject it at the fetch boundary.
const withDisabledReasoning: typeof fetch = (input, init) => {
  if (isStringBody(init?.body)) {
    try {
      const parsed = requestBodySchema.safeParse(JSON.parse(init.body));

      if (parsed.success) {
        parsed.data.reasoning = { enabled: false };
        init = { ...init, body: JSON.stringify(parsed.data) };
      }
    } catch {
      // Malformed body: forward it untouched so the provider reports the error.
    }
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
