import { refreshTinfoilCatalogAndReconcileSelections } from "../models/tinfoilModels";
import {
  resolveInferenceProvider,
  getCloudModel,
  getOpenAiApiConfig,
  getProviderDisplayName,
  isEnterpriseProvider,
  type EnterpriseProvider,
} from "../models/ModelRegistry";
import { BaseReasoningService, ReasoningConfig } from "./BaseReasoningService";
import { SecureCache } from "../utils/SecureCache";
import { withRetry, createApiRetryStrategy, httpError } from "../utils/retry";
import { API_ENDPOINTS, TOKEN_LIMITS, buildApiUrl } from "../config/constants.mts";
import logger from "../utils/logger";
import { getSettings } from "../stores/settingsStore";
import { decodeCleanupTranscriptEntities, wrapCleanupTranscript } from "../config/prompts";
import { stripThinkingTags } from "../helpers/stripThinking.js";
import { getLlmRequestTimeoutSeconds } from "../helpers/llmRequestTimeout.js";
import { streamText, stepCountIs } from "ai";
import type { JSONValue, ModelMessage, Tool } from "ai";
import { z } from "zod";
import { getAIModel } from "./ai/providers";
import { createEnterpriseChatModel } from "./ai/enterpriseChatModel";
import { PROVIDER_REGISTRY, type ProviderContext } from "./ai/inferenceProviders";
import {
  canBorrowCleanupCustomKey,
  resolveConfiguredOpenAIBase,
  resolveSelfHostedOpenAIBase,
} from "./ai/openaiBase";
import {
  applyChatCompletionsParams,
  fetchWithParamFallback,
  isTruncatedFinishReason,
} from "./ai/chatRequestBody";
import { getModelFamilyConstraints } from "./ai/modelFamilyConstraints";
import { detectEndpointDialect, type ProviderRequestBody } from "./ai/thinkingSuppressionDialects";
import { openCodeSessionHeaders } from "./ai/openCodeSession";
import { createStreamingThinkFilter } from "./ai/streamingThinkFilter";
import { extractApiErrorMessage, isApiErrorValue, type ApiErrorValue } from "./ai/apiErrorMessage";
import { clearTinfoilClientCache } from "./ai/tinfoilClient";
import { resolveChatRoute } from "../helpers/chatRouting";
import type { BbSelection } from "../contracts/bb";

/**
 * A content part on a chat turn: the text+image parts the caller builds. Keys
 * outside the ones this service reads stay JSON so the model contract holds.
 */
export interface ChatContentPart {
  type?: string;
  text?: string;
  [key: string]: JSONValue | undefined;
}

export type ChatMessageContent = string | ChatContentPart[];

export interface ChatMessage {
  role: string;
  content: ChatMessageContent;
}

function isTextPart(part: ChatContentPart): part is ChatContentPart & { text: string } {
  return part.type === "text" && typeof part.text === "string";
}

/** Request/stream cancellation surfaces as an `AbortError`-named Error. */
function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

function isPrimitiveValue(value: unknown): value is string | number | boolean | bigint {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  );
}

/** Normalizes an unknown stream failure into the Error the caller should see. */
function toError(cause: unknown): Error {
  if (cause instanceof Error) return cause;

  if (cause === undefined || cause === null || isPrimitiveValue(cause)) {
    return new Error(cause === undefined || cause === null ? "Stream failed" : String(cause));
  }

  return new Error("Stream failed");
}

interface LogErrorDetails {
  message: string;
  stack?: string;
  name: string;
}

/** Fields read off an unexpected rejection for logging; `undefined` safe. */
function logErrorDetails(cause: unknown): LogErrorDetails {
  if (cause instanceof Error) {
    return { message: cause.message, stack: cause.stack, name: cause.name };
  }

  return { message: String(cause), name: "UnknownError" };
}

interface ApiKeyMissingError extends Error {
  code: "API_KEY_MISSING";
  provider: string;
}

/** The error a missing credential throws; callers key off `code`. */
function apiKeyMissingError(message: string, provider: string): ApiKeyMissingError {
  return Object.assign(new Error(message), { code: "API_KEY_MISSING" as const, provider });
}

/** Maps chat turns onto the AI SDK message union. */
function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  // SAFETY: chat callers build turns with ModelMessage roles (system/user/
  // assistant) and text or image content; both match the union arms this
  // transport accepted untyped before.
  const modelMessages = messages.map((message) => ({
    role: message.role,
    content: message.content,
  })) as ModelMessage[];

  return modelMessages;
}

/** Flattens a turn's text parts, mirroring the old inline filter/join exactly. */
function chatMessageText(message: ChatMessage): string {
  if (!Array.isArray(message.content)) return message.content;

  return message.content
    .filter(isTextPart)
    .map((part) => part.text)
    .join("\n");
}

// A tool's model-facing output: a string payload, or an error envelope. The AI
// SDK types tool output as JSON; the error arm is read only to describe a failed tool.
const toolOutputSchema = z.union([
  z.string(),
  z.looseObject({
    error: z
      .string()
      .optional()
      .catch(() => undefined),
  }),
]);

type ToolOutput = z.infer<typeof toolOutputSchema>;

function isStringOutput(value: ToolOutput): value is string {
  return typeof value === "string";
}

function toolOutputText(value: ToolOutput): string {
  return isStringOutput(value) ? value : value.error || "Done";
}

const sseChunkSchema = z.looseObject({
  choices: z
    .array(
      z
        .looseObject({
          delta: z
            .looseObject({
              content: z
                .string()
                .optional()
                .catch(() => undefined),
            })
            .optional()
            .catch(() => undefined),
        })
        .catch(() => ({}))
    )
    .optional()
    .catch(() => undefined),
});

/** Reads one streamed delta's text; malformed chunks yield undefined. */
function parseSseContent(data: string): string | undefined {
  let raw: unknown;

  try {
    raw = JSON.parse(data);
  } catch {
    return undefined;
  }

  const parsed = sseChunkSchema.safeParse(raw);

  return parsed.success ? parsed.data.choices?.[0]?.delta?.content : undefined;
}

/**
 * Chat-completions wire shape: only the fields this service reads, kept
 * permissive so a malformed field degrades to "missing" like the old reads.
 */
const chatCompletionSchema = z.looseObject({
  choices: z
    .array(
      z
        .looseObject({
          finish_reason: z
            .string()
            .optional()
            .catch(() => undefined),
          message: z
            .looseObject({
              content: z
                .string()
                .nullish()
                .catch(() => undefined),
            })
            .optional()
            .catch(() => undefined),
        })
        .catch(() => ({}))
    )
    .optional()
    .catch(() => undefined),
  usage: z
    .looseObject({ total_tokens: z.unknown().optional() })
    .optional()
    .catch(() => undefined),
});

type ChatCompletion = z.infer<typeof chatCompletionSchema>;

export type ToolMetadata = Record<string, JSONValue> | Array<Record<string, JSONValue>>;

const BYOK_STREAM_PROVIDERS = [
  "openai",
  "groq",
  "gemini",
  "anthropic",
  "tinfoil",
  "custom",
  "openrouter",
  "corti",
] as const;

type ByokStreamProvider = (typeof BYOK_STREAM_PROVIDERS)[number];

// Raw Chat Completions base URLs for the BYOK providers that expose one here.
// anthropic/tinfoil/custom use endpoint overrides or the AI SDK transport.
const BYOK_CHAT_BASE_URLS: Partial<Record<ByokStreamProvider, string>> = {
  openai: API_ENDPOINTS.OPENAI_BASE,
  groq: API_ENDPOINTS.GROQ_BASE,
  corti: API_ENDPOINTS.CORTI_MODELS_BASE,
  gemini: API_ENDPOINTS.GEMINI,
};

function isByokStreamProvider(provider: string): provider is ByokStreamProvider {
  return BYOK_STREAM_PROVIDERS.some((candidate) => candidate === provider);
}

function toByokStreamProvider(provider: string): ByokStreamProvider {
  if (!isByokStreamProvider(provider)) {
    throw new Error(`Unsupported reasoning provider: ${provider}`);
  }

  return provider;
}

export type AgentStreamChunk =
  | { type: "content"; text: string }
  | { type: "tool_calls"; calls: Array<{ id: string; name: string; arguments: string }> }
  | {
      type: "tool_result";
      callId: string;
      toolName: string;
      displayText: string;
      metadata?: ToolMetadata;
    }
  | { type: "done"; finishReason?: string };

function logParamFallback(logEvent: string) {
  return (details: { status: number; stripped: string[] }) =>
    logger.logReasoning(logEvent, details);
}

class ReasoningService extends BaseReasoningService {
  private apiKeyCache: SecureCache<string>;
  private static readonly MAX_TOOL_STEPS = 20;
  private cacheCleanupStop: (() => void) | undefined;
  private streamAbortController: AbortController | null = null;
  private activeRequestControllers = new Set<AbortController>();
  private requestCancellationGeneration = 0;

  private readonly providerContext: ProviderContext;

  constructor() {
    super();
    this.apiKeyCache = new SecureCache();
    this.cacheCleanupStop = this.apiKeyCache.startAutoCleanup();
    this.providerContext = {
      getApiKey: (provider: string) => this.getApiKey(toByokStreamProvider(provider)),
      getSystemPrompt: this.getSystemPrompt.bind(this),
      getCustomDictionary: this.getCustomDictionary.bind(this),
      getPreferredLanguage: this.getPreferredLanguage.bind(this),
      getUiLanguage: this.getUiLanguage.bind(this),
      callChatCompletionsApi: this.callChatCompletionsApi.bind(this),
      calculateMaxTokens: this.calculateMaxTokens.bind(this),
    };

    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => this.destroy());
    }
  }

  private hasLanCleanupConfiguration(): boolean {
    const settings = getSettings();

    return settings.cleanupMode === "self-hosted" && !!settings.cleanupRemoteUrl?.trim();
  }

  private async getApiKey(
    provider:
      | "openai"
      | "anthropic"
      | "gemini"
      | "groq"
      | "tinfoil"
      | "custom"
      | "openrouter"
      | "corti"
  ): Promise<string> {
    if (provider === "custom") {
      let customKey = "";

      try {
        customKey = (await window.electronAPI?.getCleanupCustomKey?.()) || "";
      } catch (err) {
        logger.logReasoning("CUSTOM_KEY_IPC_FALLBACK", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (!customKey || !customKey.trim()) {
        customKey = getSettings().cleanupCustomApiKey || "";
      }

      const trimmedKey = customKey.trim();

      logger.logReasoning("CUSTOM_KEY_RETRIEVAL", {
        provider,
        hasKey: !!trimmedKey,
        keyLength: trimmedKey.length,
      });

      return trimmedKey;
    }

    let apiKey = this.apiKeyCache.get(provider);

    logger.logReasoning(`${provider.toUpperCase()}_KEY_RETRIEVAL`, {
      provider,
      fromCache: !!apiKey,
      cacheSize: this.apiKeyCache.size || 0,
    });

    if (!apiKey) {
      try {
        const keyGetters = {
          openai: () => window.electronAPI.getOpenAIKey(),
          anthropic: () => window.electronAPI.getAnthropicKey(),
          gemini: () => window.electronAPI.getGeminiKey(),
          groq: () => window.electronAPI.getGroqKey(),
          openrouter: () => window.electronAPI.getOpenrouterKey(),
          tinfoil: () => window.electronAPI.getTinfoilKey?.(),
          corti: () => window.electronAPI.getCortiKey?.(),
        };

        apiKey = (await keyGetters[provider]()) ?? undefined;

        logger.logReasoning(`${provider.toUpperCase()}_KEY_FETCHED`, {
          provider,
          hasKey: !!apiKey,
          keyLength: apiKey?.length || 0,
        });

        if (apiKey) {
          this.apiKeyCache.set(provider, apiKey);
        }
      } catch (error) {
        logger.logReasoning(`${provider.toUpperCase()}_KEY_FETCH_ERROR`, {
          provider,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    }

    if (!apiKey) {
      const displayName = getProviderDisplayName(provider);
      const errorMsg = `${displayName} API key not configured`;
      logger.logReasoning(`${provider.toUpperCase()}_KEY_MISSING`, {
        provider,
        error: errorMsg,
      });
      const error = apiKeyMissingError(errorMsg, displayName);
      throw error;
    }

    return apiKey;
  }

  // Single source for BYOK streaming credentials and endpoint overrides:
  // rejects unknown providers instead of defaulting them to OpenAI, and only
  // lets a custom scope borrow the shared cleanup key for the cleanup endpoint.
  private async resolveByokAccess(
    provider: string,
    config: Pick<ReasoningConfig, "baseUrl" | "customApiKey">
  ): Promise<{ apiKey: string; baseURL?: string }> {
    const providerKey = toByokStreamProvider(provider);
    const overrideKey = providerKey === "custom" ? config.customApiKey?.trim() || "" : "";

    const canFallBackToSharedKey =
      providerKey !== "custom" || canBorrowCleanupCustomKey(config.baseUrl);

    const apiKey = overrideKey || (canFallBackToSharedKey ? await this.getApiKey(providerKey) : "");

    const baseURL =
      providerKey === "openrouter"
        ? API_ENDPOINTS.OPENROUTER_BASE
        : providerKey === "custom"
          ? resolveConfiguredOpenAIBase(providerKey, config.baseUrl)
          : undefined;

    return { apiKey, baseURL };
  }

  private async callChatCompletionsApi(
    endpoint: string,
    apiKey: string,
    model: string,
    text: string,
    agentName: string | null,
    config: ReasoningConfig,
    providerName: string
  ): Promise<string> {
    // No systemPrompt override means the default cleanup path: a deterministic
    // transform, so zero temperature and a delimited transcript.
    const isCleanup = !config.systemPrompt;
    const systemPrompt = config.systemPrompt || this.getSystemPrompt(agentName);
    const userPrompt = isCleanup ? wrapCleanupTranscript(text) : text;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const requestBody: ProviderRequestBody = { model, messages };
    applyChatCompletionsParams(requestBody, {
      model,
      provider: providerName,
      endpoint,
      config,
      maxTokens:
        config.maxTokens ||
        Math.max(
          4096,
          this.calculateMaxTokens(
            text.length,
            TOKEN_LIMITS.MIN_TOKENS,
            TOKEN_LIMITS.MAX_TOKENS,
            TOKEN_LIMITS.TOKEN_MULTIPLIER
          )
        ),
    });

    logger.logReasoning(`${providerName.toUpperCase()}_REQUEST`, {
      endpoint,
      model,
      hasApiKey: !!apiKey,
      requestBody: JSON.stringify(requestBody).substring(0, 200),
    });

    // Minted before the retry loop so every attempt of this call is one conversation.
    const openCodeHeaders = openCodeSessionHeaders(endpoint);

    const requestGeneration = this.requestCancellationGeneration;

    const response = await withRetry(async () => {
      if (requestGeneration !== this.requestCancellationGeneration) {
        throw httpError("Request cancelled", 499);
      }

      const controller = new AbortController();
      this.activeRequestControllers.add(controller);
      const timeoutSeconds = getLlmRequestTimeoutSeconds();
      const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

      try {
        const headers = {
          "Content-Type": "application/json",
          ...openCodeHeaders,
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        };

        const res = await fetchWithParamFallback(
          () =>
            fetch(endpoint, {
              method: "POST",
              headers,
              body: JSON.stringify(requestBody),
              signal: controller.signal,
            }),
          requestBody,
          logParamFallback(`${providerName.toUpperCase()}_PARAM_FALLBACK`)
        );

        if (!res.ok) {
          const errorText = await res.text();
          let errorData: ApiErrorValue = { error: res.statusText };

          try {
            const parsed: unknown = JSON.parse(errorText);

            if (isApiErrorValue(parsed)) errorData = parsed;
          } catch {
            errorData = { error: errorText || res.statusText };
          }

          const errorMessage = extractApiErrorMessage(
            errorData,
            `${providerName} API error: ${res.status}`
          );

          logger.logReasoning(`${providerName.toUpperCase()}_API_ERROR_DETAIL`, {
            status: res.status,
            statusText: res.statusText,
            error: errorData,
            errorMessage,
            fullResponse: errorText.substring(0, 500),
          });
          throw httpError(errorMessage, res.status);
        }

        const jsonResponse: unknown = await res.json();
        const parsed = chatCompletionSchema.safeParse(jsonResponse);
        const parsedResponse: ChatCompletion = parsed.success ? parsed.data : {};

        logger.logReasoning(`${providerName.toUpperCase()}_RAW_RESPONSE`, {
          hasResponse: !!jsonResponse,
          responseKeys: Object.keys(parsedResponse),
          hasChoices: !!parsedResponse.choices,
          choicesLength: parsedResponse.choices?.length || 0,
          fullResponse: JSON.stringify(jsonResponse).substring(0, 500),
        });

        return parsedResponse;
      } catch (error) {
        if (isAbortError(error)) {
          if (requestGeneration !== this.requestCancellationGeneration) {
            throw httpError("Request cancelled", 499);
          }

          throw new Error(`Request timed out after ${timeoutSeconds}s`);
        }

        throw error;
      } finally {
        clearTimeout(timeoutId);
        this.activeRequestControllers.delete(controller);
      }
    }, createApiRetryStrategy());

    if (!response.choices || !response.choices[0]) {
      logger.logReasoning(`${providerName.toUpperCase()}_RESPONSE_ERROR`, {
        model,
        response: JSON.stringify(response).substring(0, 500),
        hasChoices: !!response.choices,
        choicesCount: response.choices?.length || 0,
      });
      throw new Error(`Invalid response structure from ${providerName} API`);
    }

    const choice = response.choices[0];

    if (config.requireCompleteOutput && isTruncatedFinishReason(choice?.finish_reason)) {
      throw new Error("Model output was truncated before the selection edit completed");
    }

    // Reasoning models leak <think> blocks into non-streamed output; strip them
    // unless the user explicitly enabled thinking (same default as streaming).
    const rawContent = choice.message?.content?.trim() || "";

    const responseText =
      config.disableThinking !== false ? stripThinkingTags(rawContent) : rawContent;

    if (!responseText) {
      logger.logReasoning(`${providerName.toUpperCase()}_EMPTY_RESPONSE`, {
        model,
        finishReason: choice.finish_reason,
        hasMessage: !!choice.message,
        response: JSON.stringify(choice).substring(0, 500),
      });
      throw new Error(`${providerName} returned empty response`);
    }

    logger.logReasoning(`${providerName.toUpperCase()}_RESPONSE`, {
      model,
      responseLength: responseText.length,
      tokensUsed: response.usage?.total_tokens || 0,
      success: true,
    });

    return responseText;
  }

  async processText(
    text: string,
    model: string = "",
    agentName: string | null = null,
    config: ReasoningConfig = {}
  ): Promise<string> {
    if (!text.trim() && !config.systemPrompt) return "";
    const trimmedModel = model?.trim?.() || "";
    const settings = getSettings();

    const isImplicitCleanup =
      config.provider === undefined && config.baseUrl === undefined && config.lanUrl === undefined;

    const implicitProvider =
      settings.cleanupMode === "self-hosted" ? "lan" : settings.cleanupProvider || undefined;

    const isImplicitCustomCleanup =
      isImplicitCleanup && settings.cleanupMode === "providers" && implicitProvider === "custom";

    const dispatchConfig: ReasoningConfig = isImplicitCleanup
      ? {
          ...config,
          provider: implicitProvider,
          baseUrl: isImplicitCustomCleanup ? settings.cleanupCloudBaseUrl : undefined,
          customApiKey: isImplicitCustomCleanup
            ? (config.customApiKey ?? settings.cleanupCustomApiKey)
            : config.customApiKey,
        }
      : config;

    const isLanCleanup = !!dispatchConfig.lanUrl || dispatchConfig.provider === "lan";

    const providerId = isLanCleanup
      ? "lan"
      : resolveInferenceProvider(dispatchConfig.provider, trimmedModel);

    if (!providerId) {
      throw new Error("No reasoning provider selected");
    }

    if (!trimmedModel && providerId !== "lan") {
      throw new Error("No reasoning model selected");
    }

    logger.logReasoning("PROVIDER_SELECTION", {
      provider: providerId,
      model: trimmedModel,
      agentName,
      isLanCleanup,
      textLength: text.length,
    });

    const handler = PROVIDER_REGISTRY[providerId];

    if (!handler) {
      throw new Error(`Unsupported reasoning provider: ${providerId}`);
    }

    const startTime = Date.now();

    try {
      const result = await handler.call({
        text,
        model: trimmedModel,
        agentName,
        config: dispatchConfig,
        ctx: this.providerContext,
      });

      logger.logReasoning("PROVIDER_SUCCESS", {
        provider: providerId,
        model: trimmedModel,
        processingTimeMs: Date.now() - startTime,
        resultLength: result.length,
      });

      return dispatchConfig.systemPrompt ? result : decodeCleanupTranscriptEntities(result);
    } catch (error) {
      logger.logReasoning("PROVIDER_ERROR", {
        provider: providerId,
        model: trimmedModel,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async *processTextStreaming(
    messages: Array<{ role: string; content: string }>,
    model: string,
    provider: string,
    config: ReasoningConfig & { systemPrompt: string }
  ): AsyncGenerator<string, void, unknown> {
    const abortController = new AbortController();
    this.streamAbortController = abortController;

    try {
      yield* this.processTextStreamingRaw(messages, model, provider, config, abortController);
    } finally {
      if (this.streamAbortController === abortController) {
        this.streamAbortController = null;
      }
    }
  }

  private async *processTextStreamingRaw(
    messages: ChatMessage[],
    model: string,
    provider: string,
    config: ReasoningConfig & { systemPrompt: string },
    abortController: AbortController
  ): AsyncGenerator<string, void, unknown> {
    const route = resolveChatRoute({
      provider,
      lanUrl: config.lanUrl,
      customApiKey: config.customApiKey,
    });

    const isLocalProvider = route.kind === "local";
    const isLanChat = route.kind === "self-hosted";

    let endpoint: string;
    let apiKey = "";

    if (isLanChat) {
      const baseUrl = resolveSelfHostedOpenAIBase(route.baseUrl);
      endpoint = buildApiUrl(baseUrl, "/chat/completions");
      apiKey = route.apiKey;
    } else if (isLocalProvider) {
      const serverResult = await window.electronAPI.llamaServerStart(model);

      if (!serverResult.success || !serverResult.port) {
        throw new Error(serverResult.error || "Failed to start local model server");
      }

      endpoint = `http://127.0.0.1:${serverResult.port}/v1/chat/completions`;
    } else {
      const access = await this.resolveByokAccess(provider, config);
      apiKey = access.apiKey;

      const chatBase = access.baseURL ?? BYOK_CHAT_BASE_URLS[toByokStreamProvider(provider)];

      // anthropic and tinfoil have no raw Chat Completions transport here.
      if (!chatBase) {
        throw new Error(`${provider} streaming must use the AI SDK transport`);
      }

      endpoint = buildApiUrl(
        chatBase,
        provider === "gemini" ? "/openai/chat/completions" : "/chat/completions"
      );
    }

    if (abortController.signal.aborted) return;

    const requestBody: ProviderRequestBody = {
      model,
      messages,
      stream: true,
    };

    applyChatCompletionsParams(requestBody, {
      model,
      provider: isLanChat ? "lan" : isLocalProvider ? "local" : provider,
      endpoint,
      config,
      maxTokens: config.maxTokens || Math.max(4096, TOKEN_LIMITS.MAX_TOKENS),
    });

    logger.logReasoning("AGENT_STREAM_REQUEST", {
      endpoint,
      model,
      provider,
      isLocal: isLocalProvider,
      isLan: isLanChat,
      messageCount: messages.length,
    });

    const headers = {
      "Content-Type": "application/json",
      ...openCodeSessionHeaders(endpoint),
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };

    const timeoutSeconds = getLlmRequestTimeoutSeconds({ streaming: true });
    let timeoutTriggered = false;

    const timeoutId = setTimeout(() => {
      if (abortController.signal.aborted) return;
      timeoutTriggered = true;
      abortController.abort();
    }, timeoutSeconds * 1000);

    let response: Response;

    try {
      response = await fetchWithParamFallback(
        () =>
          fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(requestBody),
            signal: abortController.signal,
          }),
        requestBody,
        logParamFallback("AGENT_STREAM_PARAM_FALLBACK")
      );
    } catch (error) {
      clearTimeout(timeoutId);

      if (isAbortError(error) && abortController.signal.aborted) {
        if (!timeoutTriggered) return;
        throw new Error("Streaming request timed out");
      }

      throw error;
    }

    if (!response.ok) {
      clearTimeout(timeoutId);
      const errorText = await response.text();
      let errorMessage: string;

      try {
        const parsed: unknown = JSON.parse(errorText);

        const errorData: ApiErrorValue = isApiErrorValue(parsed)
          ? parsed
          : { error: errorText || `API error: ${response.status}` };

        errorMessage = extractApiErrorMessage(errorData, `API error: ${response.status}`);
      } catch {
        errorMessage = errorText || `API error: ${response.status}`;
      }

      logger.logReasoning("AGENT_STREAM_ERROR", { status: response.status, errorMessage });
      throw new Error(errorMessage);
    }

    const reader = response.body?.getReader();

    if (!reader) {
      clearTimeout(timeoutId);
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    const stripThinking = (isLocalProvider || isLanChat) && config.disableThinking !== false;
    const filterThinkTags = stripThinking ? createStreamingThinkFilter() : null;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();

          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6);

          if (data === "[DONE]") {
            const trailing = filterThinkTags?.finish();

            if (trailing) yield trailing;

            return;
          }

          try {
            const content = parseSseContent(data);

            if (!content) continue;

            if (filterThinkTags) {
              const filtered = filterThinkTags(content);

              if (!filtered) continue;

              yield filtered;
            } else {
              yield content;
            }
          } catch {
            // skip malformed SSE chunks
          }
        }
      }

      const trailing = filterThinkTags?.finish();

      if (trailing) yield trailing;
    } catch (error) {
      if (isAbortError(error) && abortController.signal.aborted) {
        if (!timeoutTriggered) return;
        throw new Error("Streaming request timed out");
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
      reader.releaseLock();
    }
  }

  async *processTextStreamingAI(
    // Content is a string, or text+image parts when a screenshot rides along
    // (image-capable BYOK providers only — the caller drops it elsewhere).
    messages: ChatMessage[],
    model: string,
    provider: string,
    config: ReasoningConfig & { systemPrompt: string },
    tools?: Record<string, Tool>
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    if (config.agentSelection) {
      if (!config.agentConversationId)
        throw new Error("A saved Chat conversation is required for bb");
      yield* this.processBbStreaming(
        messages,
        config.agentSelection,
        config.agentConversationId,
        config.onThreadTitle
      );

      return;
    }

    const route = resolveChatRoute({
      provider,
      lanUrl: config.lanUrl,
      customApiKey: config.customApiKey,
      isEnterpriseProvider: isEnterpriseProvider(provider),
    });

    // Both streaming transports share this owner so cancellation survives
    // asynchronous server, key, and model setup.
    const abortController = new AbortController();
    this.streamAbortController = abortController;
    const isEnterprise = route.kind === "enterprise";
    const isLocalProvider = route.kind === "local";
    const isLanChat = route.kind === "self-hosted";

    if ((isLocalProvider || isLanChat) && !tools) {
      // Attachments are never routed to local/LAN providers, so content is string-only here.
      try {
        const contentGen = this.processTextStreamingRaw(
          messages,
          model,
          provider,
          config,
          abortController
        );

        for await (const text of contentGen) {
          yield { type: "content", text };
        }

        yield { type: "done", finishReason: "stop" };
      } catch (error) {
        if (abortController.signal.aborted && isAbortError(error)) return;
        throw error;
      } finally {
        if (this.streamAbortController === abortController) {
          this.streamAbortController = null;
        }
      }

      return;
    }

    const filterThinkTags =
      (isLocalProvider || isLanChat) && config.disableThinking !== false
        ? createStreamingThinkFilter()
        : null;

    let apiKey = "";
    let baseURL: string | undefined;

    if (isEnterprise) {
      // Enterprise SDKs run in the main process; the model below proxies
      // doStream over IPC, so no key or base URL is resolved here.
    } else if (isLanChat) {
      apiKey = route.apiKey;
      baseURL = resolveSelfHostedOpenAIBase(route.baseUrl);
    } else if (isLocalProvider) {
      const serverResult = await window.electronAPI.llamaServerStart(model);

      if (!serverResult.success || !serverResult.port) {
        throw new Error(serverResult.error || "Failed to start local model server");
      }

      baseURL = `http://127.0.0.1:${serverResult.port}/v1`;
    } else {
      ({ apiKey, baseURL } = await this.resolveByokAccess(provider, config));
    }

    const aiProvider = isLocalProvider || isLanChat ? "local" : provider;
    // OpenRouter ids are never in the local registry, so the supportsThinking
    // exemption below can't apply — honor the toggle directly.
    const openrouterDisableThinking = provider === "openrouter" && config.disableThinking === true;

    if (aiProvider === "tinfoil") {
      if (!apiKey?.trim()) throw new Error("Tinfoil API key not configured");
      // Cache-hit application is synchronous. Network repair affects later
      // settings resolution, not this operation's model or request parameters.
      void refreshTinfoilCatalogAndReconcileSelections().catch(() => {});
    }

    const apiConfig = detectEndpointDialect(baseURL) ?? getOpenAiApiConfig(model, provider);
    const modelDef = getCloudModel(model);
    const userSuppressesThinking = config.disableThinking === true && !!modelDef?.supportsThinking;

    const needsGroqDisableThinking =
      provider === "groq" && (modelDef?.disableThinking || userSuppressesThinking);

    const needsGeminiMinimalThinking = provider === "gemini" && userSuppressesThinking;

    const providerOptions = {
      // The effort value is a family fact: gpt-oss has no "none" (#1611).
      ...(needsGroqDisableThinking
        ? {
            groq: {
              reasoningEffort:
                getModelFamilyConstraints(model)?.reasoningEffort?.suppressValue ?? "none",
            },
          }
        : {}),
      ...(needsGeminiMinimalThinking
        ? { google: { thinkingConfig: { thinkingLevel: "minimal", includeThoughts: false } } }
        : {}),
    };

    const hasProviderOptions = Object.keys(providerOptions).length > 0;

    const aiModel = isEnterprise
      ? // SAFETY: resolveChatRoute only returns the enterprise route after
        // isEnterpriseProvider(provider) passed, so the narrowed type holds.
        createEnterpriseChatModel(provider as EnterpriseProvider, model)
      : await getAIModel(aiProvider, model, apiKey, baseURL, {
          disableThinking: openrouterDisableThinking,
        });

    if (abortController.signal.aborted) {
      yield { type: "done", finishReason: "stop" };

      return;
    }

    logger.logReasoning("AGENT_AI_SDK_STREAM_REQUEST", {
      model,
      provider,
      hasTools: !!tools,
      toolCount: tools ? Object.keys(tools).length : 0,
      messageCount: messages.length,
    });

    const useTemperature = isLocalProvider || isLanChat || apiConfig.supportsTemperature;

    const result = streamText({
      model: aiModel,
      messages: toModelMessages(messages),
      tools: tools || undefined,
      stopWhen: stepCountIs(tools ? ReasoningService.MAX_TOOL_STEPS : 1),
      abortSignal: abortController.signal,
      ...(useTemperature ? { temperature: config.temperature ?? 0.3 } : {}),
      maxOutputTokens: config.maxTokens || 4096,
      ...(hasProviderOptions ? { providerOptions } : {}),
    });

    let canFlushFilteredText = true;

    const finishFilteredText = (): string => {
      const trailing = filterThinkTags?.finish() ?? "";

      return canFlushFilteredText ? trailing : "";
    };

    try {
      for await (const chunk of result.fullStream) {
        if (chunk.type === "text-delta") {
          const text = filterThinkTags ? filterThinkTags(chunk.text) : chunk.text;

          if (text) yield { type: "content", text };
        } else if (chunk.type === "text-end" || chunk.type === "finish-step") {
          const trailing = finishFilteredText();

          if (trailing) yield { type: "content", text: trailing };
        } else if (chunk.type === "tool-call") {
          yield {
            type: "tool_calls",
            calls: [
              {
                id: chunk.toolCallId,
                name: chunk.toolName,
                arguments: JSON.stringify(chunk.input),
              },
            ],
          };
        } else if (chunk.type === "tool-result") {
          const parsedOutput = toolOutputSchema.safeParse(chunk.output);

          yield {
            type: "tool_result",
            callId: chunk.toolCallId,
            toolName: chunk.toolName,
            displayText: parsedOutput.success ? toolOutputText(parsedOutput.data) : "Done",
          };
        } else if (chunk.type === "abort") {
          canFlushFilteredText = false;
          finishFilteredText();
        } else if (chunk.type === "error") {
          // streamText reports provider failures as error parts and then ends
          // the stream; swallowing them leaves callers with an empty reply and
          // no terminal signal. Re-throw unless we aborted on purpose.
          canFlushFilteredText = false;
          finishFilteredText();

          if (!abortController.signal.aborted) {
            throw toError(chunk.error);
          }
        } else if (chunk.type === "finish") {
          const trailing = finishFilteredText();

          if (trailing) yield { type: "content", text: trailing };
          yield { type: "done", finishReason: chunk.finishReason };
        }
      }
    } catch (error) {
      canFlushFilteredText = false;
      finishFilteredText();

      if (abortController.signal.aborted) {
        yield { type: "done", finishReason: "stop" };

        return;
      }

      throw error;
    } finally {
      if (this.streamAbortController === abortController) {
        this.streamAbortController = null;
      }
    }
  }

  private async *processBbStreaming(
    messages: ChatMessage[],
    selection: BbSelection,
    conversationId: number,
    onThreadTitle?: (title: string) => void
  ): AsyncGenerator<AgentStreamChunk, void, unknown> {
    const streamId = crypto.randomUUID();
    const controller = new AbortController();
    this.streamAbortController = controller;
    const queue: Array<{ text?: string; done?: boolean; error?: string }> = [];
    let wake: (() => void) | null = null;
    // The title arrives after the answer is done, so the listener can outlive the stream.
    let keepListeningForTitle = false;
    let titleTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};

    const stopListening = () => {
      clearTimeout(titleTimer);
      unsubscribe();
    };

    unsubscribe = window.electronAPI.onBbStreamPart((part) => {
      if (part.streamId !== streamId) return;

      if (part.title) {
        onThreadTitle?.(part.title);
        stopListening();

        return;
      }

      queue.push(part);
      wake?.();
    });

    const onAbort = () => {
      wake?.();
      void window.electronAPI.bbStreamCancel(streamId).catch(() => {});
    };

    controller.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const formatMessage = (message: ChatMessage) =>
        `${message.role.toUpperCase()}:\n${chatMessageText(message)}`;

      const initialPrompt = messages.map(formatMessage).join("\n\n");
      const latestUser = messages.filter((message) => message.role === "user").at(-1);

      if (!latestUser) throw new Error("A Chat user message is required for bb");
      const prompt = chatMessageText(latestUser);
      await window.electronAPI.bbStreamStart({
        streamId,
        conversationId,
        prompt,
        initialPrompt,
        selection,
      });

      while (!controller.signal.aborted) {
        if (queue.length === 0)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        wake = null;
        const part = queue.shift();

        if (!part) continue;

        if (part.error) throw new Error(part.error);

        if (part.text) yield { type: "content", text: part.text };

        if (part.done) {
          keepListeningForTitle = !!onThreadTitle;
          yield { type: "done", finishReason: "stop" };

          return;
        }
      }
    } finally {
      controller.signal.removeEventListener("abort", onAbort);

      if (keepListeningForTitle) titleTimer = setTimeout(stopListening, 15_000);
      else stopListening();

      if (this.streamAbortController === controller) this.streamAbortController = null;
    }
  }

  /** Aborts the chat/agent stream only (panel Esc, chat surface unmount). */
  cancelActiveStream(): void {
    this.streamAbortController?.abort();
    this.streamAbortController = null;
  }

  /**
   * Aborts everything in flight in this renderer: the chat stream plus every
   * single-shot request (cleanup, selection edit, titles). Used by the
   * dictation cancel path, never by chat lifecycle.
   */
  cancelAllRequests(): void {
    this.requestCancellationGeneration += 1;

    for (const controller of this.activeRequestControllers) controller.abort();
    this.activeRequestControllers.clear();
    this.cancelActiveStream();
  }

  async isAvailable(): Promise<boolean> {
    try {
      const settings = getSettings();

      if (this.hasLanCleanupConfiguration()) {
        logger.logReasoning("API_KEY_CHECK", { lanCleanup: true });

        return true;
      }

      if (settings.cleanupProvider === "custom" && settings.cleanupCloudBaseUrl?.trim()) {
        logger.logReasoning("API_KEY_CHECK", {
          customProvider: true,
          hasCustomEndpoint: true,
        });

        return true;
      }

      // Enterprise providers: detect credentials by provider, short-circuit.
      // Runtime auth errors (expired SSO, missing ADC) surface via
      // mapEnterpriseError with actionable remediation copy.
      if (settings.cleanupProvider === "bedrock") {
        const hasBedrockCreds =
          !!settings.bedrockProfile?.trim() ||
          (!!settings.bedrockAccessKeyId?.trim() && !!settings.bedrockSecretAccessKey?.trim());

        logger.logReasoning("API_KEY_CHECK", { bedrock: true, hasBedrockCreds });

        if (hasBedrockCreds) return true;
      }

      if (settings.cleanupProvider === "azure") {
        const hasAzureCreds = !!settings.azureApiKey?.trim() && !!settings.azureEndpoint?.trim();
        logger.logReasoning("API_KEY_CHECK", { azure: true, hasAzureCreds });

        if (hasAzureCreds) return true;
      }

      if (settings.cleanupProvider === "vertex") {
        const hasVertexCreds = !!settings.vertexApiKey?.trim() || !!settings.vertexProject?.trim();
        logger.logReasoning("API_KEY_CHECK", { vertex: true, hasVertexCreds });

        if (hasVertexCreds) return true;
      }

      const openaiKey = await window.electronAPI?.getOpenAIKey?.();
      const anthropicKey = await window.electronAPI?.getAnthropicKey?.();
      const geminiKey = await window.electronAPI?.getGeminiKey?.();
      const groqKey = await window.electronAPI?.getGroqKey?.();
      const openrouterKey = await window.electronAPI?.getOpenrouterKey?.();
      const tinfoilKey = await window.electronAPI?.getTinfoilKey?.();
      const cortiKey = await window.electronAPI?.getCortiKey?.();
      const localAvailable = await window.electronAPI?.checkLocalReasoningAvailable();

      logger.logReasoning("API_KEY_CHECK", {
        hasOpenAI: !!openaiKey,
        hasAnthropic: !!anthropicKey,
        hasGemini: !!geminiKey,
        hasGroq: !!groqKey,
        hasOpenrouter: !!openrouterKey,
        hasTinfoil: !!tinfoilKey,
        hasCorti: !!cortiKey,
        hasLocal: !!localAvailable,
      });

      return !!(
        openaiKey ||
        anthropicKey ||
        geminiKey ||
        groqKey ||
        openrouterKey ||
        tinfoilKey ||
        cortiKey ||
        localAvailable
      );
    } catch (error) {
      logger.logReasoning("API_KEY_CHECK_ERROR", logErrorDetails(error));

      return false;
    }
  }

  clearApiKeyCache(
    provider?:
      | "openai"
      | "anthropic"
      | "gemini"
      | "groq"
      | "mistral"
      | "tinfoil"
      | "custom"
      | "openrouter"
      | "corti"
  ): void {
    if (provider) {
      if (provider !== "custom") {
        this.apiKeyCache.delete(provider);
      }

      if (provider === "tinfoil") {
        clearTinfoilClientCache();
      }

      logger.logReasoning("API_KEY_CACHE_CLEARED", { provider });
    } else {
      this.apiKeyCache.clear();
      clearTinfoilClientCache();
      logger.logReasoning("API_KEY_CACHE_CLEARED", { provider: "all" });
    }
  }

  destroy(): void {
    this.cancelAllRequests();

    if (this.cacheCleanupStop) {
      this.cacheCleanupStop();
    }
  }
}

export default new ReasoningService();
