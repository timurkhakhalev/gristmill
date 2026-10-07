import type { InferenceProvider } from "./types";
import { z } from "zod";
import { API_ENDPOINTS, TOKEN_LIMITS, buildApiUrl } from "../../../config/constants.mts";
import { getOpenAiApiConfig } from "../../../models/ModelRegistry";
import { getSettings } from "../../../stores/settingsStore";
import { withRetry, createApiRetryStrategy, httpError } from "../../../utils/retry";
import logger from "../../../utils/logger";
import { canBorrowCleanupCustomKey, resolveConfiguredOpenAIBase } from "../openaiBase";
import {
  applyChatCompletionsParams,
  fetchWithParamFallback,
  isTruncatedFinishReason,
} from "../chatRequestBody";
import { detectEndpointDialect, type ProviderRequestBody } from "../thinkingSuppressionDialects";
import { getLlmRequestTimeoutSeconds } from "../../../helpers/llmRequestTimeout.js";
import { extractApiErrorMessage, isApiErrorValue, type ApiErrorValue } from "../apiErrorMessage";
import { wrapCleanupTranscript } from "../../../config/prompts";
import { openCodeSessionHeaders } from "../openCodeSession";

const OPENAI_ENDPOINT_PREF_STORAGE_KEY = "openAiEndpointPreference";

const PROBE_TIMEOUT_MS = 2_000;

const endpointPreferenceCache = new Map<string, "responses" | "chat">();

const probedBases = new Set<string>();

// The persisted endpoint preference is a JSON map; only the "responses"/"chat"
// values are meaningful, everything else is ignored exactly as before.
const preferenceStoreSchema = z.record(z.string(), z.unknown());

// `/v1/models` probe reply: llama.cpp identifies itself with owned_by. Fields
// are permissive so one mistyped entry cannot hide a llama.cpp signature.
const modelsResponseSchema = z.looseObject({
  data: z
    .array(
      z.looseObject({
        id: z
          .string()
          .optional()
          .catch(() => undefined),
        owned_by: z
          .string()
          .optional()
          .catch(() => undefined),
      })
    )
    .optional()
    .catch(() => undefined),
});

// A Responses/Chat-Completions message content: plain text or content parts.
const contentPartSchema = z.looseObject({
  type: z.string().optional(),
  text: z.string().optional(),
});

const messageContentSchema = z
  .union([z.string(), z.array(contentPartSchema.catch({}))])
  .optional()
  .catch(() => undefined);

const outputItemSchema = z.looseObject({
  type: z.string().optional(),
  content: z.array(contentPartSchema.catch({})).optional(),
});

const choiceSchema = z.looseObject({
  finish_reason: z
    .string()
    .nullish()
    .catch(() => undefined),
  text: z
    .string()
    .optional()
    .catch(() => undefined),
  message: z.looseObject({ content: messageContentSchema }).optional(),
  delta: z.looseObject({ content: messageContentSchema }).optional(),
});

// Union of the two OpenAI wire formats this provider reads. Every field is
// permissive on its own (`.catch`) so a mistyped field degrades to "missing"
// exactly as the old untyped reads did, and a junk array entry degrades to
// `{}`, which the optional-chained reads below already skip.
const openAiResponseSchema = z.looseObject({
  status: z
    .string()
    .optional()
    .catch(() => undefined),
  incomplete_details: z.unknown().optional(),
  output_text: z
    .string()
    .optional()
    .catch(() => undefined),
  output: z
    .array(outputItemSchema.catch({}))
    .optional()
    .catch(() => undefined),
  choices: z
    .array(choiceSchema.catch({}))
    .optional()
    .catch(() => undefined),
  usage: z
    .looseObject({ total_tokens: z.unknown().optional() })
    .optional()
    .catch(() => undefined),
});

type OpenAiResponse = z.infer<typeof openAiResponseSchema>;

type MessageContent = z.infer<typeof messageContentSchema>;

function isNonEmptyString(value: MessageContent): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isContentPartText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPresentString(value: string | undefined): value is string {
  return typeof value === "string";
}

// Bare truthiness on a possibly-absent string, matching the original
// `content.text` guard; empty strings are skipped, whitespace-only is not.
function isTruthyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function readStoredPreference(base: string): "responses" | "chat" | undefined {
  if (endpointPreferenceCache.has(base)) {
    return endpointPreferenceCache.get(base);
  }

  if (typeof window === "undefined" || !window.localStorage) {
    return undefined;
  }

  try {
    const raw = window.localStorage.getItem(OPENAI_ENDPOINT_PREF_STORAGE_KEY);

    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    const store = preferenceStoreSchema.safeParse(parsed);

    if (!store.success) return undefined;
    const value = store.data[base];

    if (value === "responses" || value === "chat") {
      endpointPreferenceCache.set(base, value);

      return value;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function rememberPreference(base: string, preference: "responses" | "chat"): void {
  endpointPreferenceCache.set(base, preference);

  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }

  try {
    const raw = window.localStorage.getItem(OPENAI_ENDPOINT_PREF_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const store = preferenceStoreSchema.safeParse(parsed);
    const data = store.success ? store.data : {};
    data[base] = preference;
    window.localStorage.setItem(OPENAI_ENDPOINT_PREF_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage unavailable or malformed: the in-memory cache already updated.
  }
}

function getEndpointCandidates(base: string): Array<{ url: string; type: "responses" | "chat" }> {
  const lower = base.toLowerCase();

  if (lower.endsWith("/responses") || lower.endsWith("/chat/completions")) {
    const type: "responses" | "chat" = lower.endsWith("/responses") ? "responses" : "chat";

    return [{ url: base, type }];
  }

  const preference = readStoredPreference(base);

  if (preference === "chat") {
    return [{ url: buildApiUrl(base, "/chat/completions"), type: "chat" }];
  }

  return [
    { url: buildApiUrl(base, "/responses"), type: "responses" },
    { url: buildApiUrl(base, "/chat/completions"), type: "chat" },
  ];
}

/** Probe `/v1/models` to detect llama.cpp and prefer `/chat/completions`. */
async function detectServerType(base: string): Promise<void> {
  if (probedBases.has(base) || readStoredPreference(base) !== undefined) {
    return;
  }

  const lower = base.toLowerCase();

  if (lower.endsWith("/responses") || lower.endsWith("/chat/completions")) {
    return;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    const res = await fetch(buildApiUrl(base, "/models"), {
      method: "GET",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      probedBases.add(base);

      return;
    }

    const parsed = modelsResponseSchema.safeParse(await res.json());
    const body = parsed.success ? parsed.data : {};
    const first = body.data?.[0];

    if (first?.owned_by === "llamacpp") {
      rememberPreference(base, "chat");
      logger.logReasoning("LLAMACPP_DETECTED_VIA_MODELS", {
        base,
        modelId: first?.id,
        ownedBy: first.owned_by,
      });
    }

    probedBases.add(base);
  } catch {
    probedBases.add(base);
  }
}

export const openaiProvider: InferenceProvider = {
  id: "openai",
  supportsImages: true,
  async call({ text, model, agentName, config, ctx }) {
    const resolvedProvider = config.provider || getSettings().cleanupProvider || "";
    const isCustomProvider = resolvedProvider === "custom";
    const isOpenRouter = resolvedProvider === "openrouter";

    logger.logReasoning("OPENAI_START", {
      model,
      agentName,
      isCustomProvider,
    });

    const overrideKey = isCustomProvider ? config.customApiKey?.trim() : "";
    const canFallBackToSharedKey = !isCustomProvider || canBorrowCleanupCustomKey(config.baseUrl);

    const apiKey =
      overrideKey ||
      (canFallBackToSharedKey
        ? await ctx.getApiKey(isCustomProvider ? "custom" : isOpenRouter ? "openrouter" : "openai")
        : "");

    logger.logReasoning("OPENAI_API_KEY", {
      hasApiKey: !!apiKey,
      keyLength: apiKey?.length || 0,
    });

    const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName);
    const userContent = config.systemPrompt ? text : wrapCleanupTranscript(text);

    const imageDataUrl = config.screenContext
      ? `data:${config.screenContext.mediaType};base64,${config.screenContext.data}`
      : null;

    // The Responses and Chat Completions APIs name image content parts differently.
    const buildMessages = (type: "responses" | "chat") =>
      imageDataUrl
        ? [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: [
                type === "responses"
                  ? { type: "input_text", text: userContent }
                  : { type: "text", text: userContent },
                type === "responses"
                  ? { type: "input_image", image_url: imageDataUrl }
                  : { type: "image_url", image_url: { url: imageDataUrl } },
              ],
            },
          ]
        : [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ];

    const openAiBase = isOpenRouter
      ? API_ENDPOINTS.OPENROUTER_BASE
      : resolveConfiguredOpenAIBase(resolvedProvider, config.baseUrl);

    const dialect = detectEndpointDialect(openAiBase);
    // OpenRouter and known dialect hosts speak Chat Completions only — no /responses probe needed.
    let endpointCandidates: Array<{ url: string; type: "responses" | "chat" }>;

    if (isOpenRouter || dialect) {
      endpointCandidates = [{ url: buildApiUrl(openAiBase, "/chat/completions"), type: "chat" }];
    } else {
      await detectServerType(openAiBase);
      endpointCandidates = getEndpointCandidates(openAiBase);
    }

    const isCustomEndpoint = openAiBase !== API_ENDPOINTS.OPENAI_BASE;
    // One cleanup call is one conversation: every attempt below (endpoint
    // fallback, parameter fallback, retry) reuses the same session id.
    const openCodeHeaders = openCodeSessionHeaders(openAiBase);

    logger.logReasoning("OPENAI_ENDPOINTS", {
      base: openAiBase,
      isCustomEndpoint,
      candidates: endpointCandidates.map((candidate) => candidate.url),
      preference: readStoredPreference(openAiBase) || null,
    });

    if (isCustomEndpoint) {
      logger.logReasoning("CUSTOM_TEXT_CLEANUP_REQUEST", {
        customBase: openAiBase,
        model,
        textLength: text.length,
        hasApiKey: !!apiKey,
        apiKeyPreview: apiKey ? `${apiKey.substring(0, 8)}...` : "(none)",
      });
    }

    const retryStrategy = createApiRetryStrategy();

    const response = await withRetry(async () => {
      let lastError: Error | null = null;
      let lastRetryableError: Error | null = null;

      for (const { url: endpoint, type } of endpointCandidates) {
        const controller = new AbortController();
        const timeoutSeconds = getLlmRequestTimeoutSeconds();
        const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

        try {
          const maxTokens =
            config.maxTokens ||
            Math.max(
              4096,
              ctx.calculateMaxTokens(
                text.length,
                TOKEN_LIMITS.MIN_TOKENS,
                TOKEN_LIMITS.MAX_TOKENS,
                TOKEN_LIMITS.TOKEN_MULTIPLIER
              )
            );

          const requestBody: ProviderRequestBody = { model };

          if (type === "responses") {
            requestBody.input = buildMessages(type);
            requestBody.store = false;
            requestBody.max_output_tokens = maxTokens;
            // A known endpoint host knows its own request shape better than the model id does.
            const apiConfig = dialect ?? getOpenAiApiConfig(model, resolvedProvider);

            if (apiConfig.supportsTemperature) {
              requestBody.temperature = config.temperature ?? (config.systemPrompt ? 0.3 : 0);
            }
          } else {
            requestBody.messages = buildMessages(type);
            applyChatCompletionsParams(requestBody, {
              model,
              provider: resolvedProvider,
              endpoint: openAiBase,
              config,
              maxTokens,
            });
          }

          const res = await fetchWithParamFallback(
            () =>
              fetch(endpoint, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                  ...openCodeHeaders,
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal,
              }),
            requestBody,
            (details) => logger.logReasoning("OPENAI_PARAM_FALLBACK", { endpoint, ...details })
          );

          if (!res.ok) {
            const rawError: unknown = await res.json().catch(() => ({ error: res.statusText }));

            const errorData: ApiErrorValue = isApiErrorValue(rawError)
              ? rawError
              : { error: res.statusText };

            const errorMessage = extractApiErrorMessage(
              errorData,
              `OpenAI API error: ${res.status}`
            );

            const isUnsupportedEndpoint =
              (res.status === 404 || res.status === 405) && type === "responses";

            if (isUnsupportedEndpoint) {
              lastError = httpError(errorMessage, res.status);
              rememberPreference(openAiBase, "chat");
              logger.logReasoning("OPENAI_ENDPOINT_FALLBACK", {
                attemptedEndpoint: endpoint,
                error: errorMessage,
              });
              continue;
            }

            throw httpError(errorMessage, res.status);
          }

          rememberPreference(openAiBase, type);

          const parsed = openAiResponseSchema.safeParse(await res.json());

          if (!parsed.success) {
            const empty: OpenAiResponse = {};

            return empty;
          }

          return parsed.data;
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`Request timed out after ${timeoutSeconds}s`);
          }

          lastError = error instanceof Error ? error : new Error(String(error));

          if (retryStrategy.shouldRetry(lastError)) {
            lastRetryableError = lastError;
          }

          if (type === "responses") {
            logger.logReasoning("OPENAI_ENDPOINT_FALLBACK", {
              attemptedEndpoint: endpoint,
              error: lastError.message,
            });
            continue;
          }

          throw lastRetryableError || error;
        } finally {
          clearTimeout(timeoutId);
        }
      }

      throw lastRetryableError || lastError || new Error("No OpenAI endpoint responded");
    }, retryStrategy);

    const isResponsesApi = Array.isArray(response.output);
    const isChatCompletions = Array.isArray(response.choices);

    if (config.requireCompleteOutput) {
      const responseIncomplete =
        response.status === "incomplete" ||
        !!response.incomplete_details ||
        response.choices?.some((choice) =>
          isTruncatedFinishReason(choice.finish_reason ?? undefined)
        );

      if (responseIncomplete) {
        throw new Error("Model output was truncated before the selection edit completed");
      }
    }

    logger.logReasoning("OPENAI_RAW_RESPONSE", {
      model,
      format: isResponsesApi ? "responses" : isChatCompletions ? "chat_completions" : "unknown",
      hasOutput: isResponsesApi,
      outputLength: isResponsesApi ? response.output?.length : 0,
      outputTypes: isResponsesApi ? response.output?.map((item) => item.type) : undefined,
      hasChoices: isChatCompletions,
      choicesLength: isChatCompletions ? response.choices?.length : 0,
      usage: response.usage,
    });

    let responseText = "";

    if (isResponsesApi) {
      for (const item of response.output ?? []) {
        if (item.type === "message" && item.content) {
          for (const content of item.content) {
            if (content.type === "output_text" && isTruthyString(content.text)) {
              responseText = content.text.trim();
              break;
            }
          }

          if (responseText) break;
        }
      }
    }

    if (!responseText && isPresentString(response.output_text)) {
      responseText = response.output_text.trim();
    }

    if (!responseText && isChatCompletions) {
      for (const choice of response.choices ?? []) {
        const message = choice.message ?? choice.delta;
        const content: MessageContent | undefined = message?.content;

        if (isNonEmptyString(content)) {
          responseText = content.trim();
          break;
        }

        if (Array.isArray(content)) {
          for (const part of content) {
            if (isContentPartText(part.text)) {
              responseText = part.text.trim();
              break;
            }
          }
        }

        if (responseText) break;

        if (isNonEmptyString(choice.text)) {
          responseText = choice.text.trim();
          break;
        }
      }
    }

    logger.logReasoning("OPENAI_RESPONSE", {
      model,
      responseLength: responseText.length,
      tokensUsed: response.usage?.total_tokens || 0,
      success: true,
      isEmpty: responseText.length === 0,
    });

    if (!responseText) {
      if (config.requireCompleteOutput) {
        throw new Error("Model returned an empty selection edit");
      }

      logger.logReasoning("OPENAI_EMPTY_RESPONSE_FALLBACK", {
        model,
        originalTextLength: text.length,
        reason: "Empty response from API",
      });

      return text;
    }

    return responseText;
  },
};
