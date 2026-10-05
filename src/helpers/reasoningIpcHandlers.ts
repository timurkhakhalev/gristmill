// The main-owned reasoning IPC handlers, moved out of ipcHandlers.js: local
// one-shot reasoning + availability, the Anthropic one-shot proxy, enterprise
// one-shot reasoning (with the sender-scoped Bedrock cleanup lifecycle), and
// the enterprise stream start/cancel/part lifecycle. The renderer's BYOK/LAN
// streaming stays in ReasoningService + AI SDK — there is no second execution
// path here. All provider factories and transports are narrow injectable
// dependencies; declaring their interfaces here is not a claim that their
// internal JS implementations are strict-checked (their conversion is
// planned separately).
import { randomUUID } from "node:crypto";
import { pickEnterpriseConfig } from "./enterpriseProviderErrors.js";
import { AgentStreamRequestRegistry } from "./agentStreamRequestRegistry.js";
import {
  localReasoningArgsSchema,
  anthropicReasoningArgsSchema,
  enterpriseReasoningArgsSchema,
  enterpriseStreamStartRequestSchema,
  reasoningChannels,
  type EnterpriseReasoningConfig,
  type EnterpriseReasoningResult,
  type EnterpriseTechnicalDetails,
  type LocalReasoningConfig,
} from "../contracts/reasoning.js";
import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider";

// --- Narrow dependency interfaces -------------------------------------------

export interface LocalReasoningServiceLike {
  isAvailable(): Promise<boolean>;
  processText(text: string, modelId: string, config: LocalReasoningConfig): Promise<string>;
}

export interface ProxyFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface EnterpriseRuntime {
  provider: string;
  model: string;
  apiKey: string;
  enterprise: {
    bedrockRegion?: string;
    bedrockProfile?: string;
    bedrockAccessKeyId?: string;
    bedrockSecretAccessKey?: string;
    bedrockSessionToken?: string;
    azureEndpoint?: string;
    azureApiVersion?: string;
    vertexProject?: string;
    vertexLocation?: string;
  };
}

export interface EnterpriseModelStream {
  getReader(): {
    read(): Promise<{ done?: boolean; value?: LanguageModelV3StreamPart }>;
    releaseLock(): void;
  };
}

// The slice of LanguageModelV3 main actually drives: doStream + a reader.
// PromiseLike mirrors the SDK's doStream return so the interface stays
// structurally assignable from the real model.
export interface EnterpriseStreamModel {
  doStream(options: Record<string, unknown>): PromiseLike<{ stream: EnterpriseModelStream }>;
}

export interface MappedEnterpriseError {
  message: string;
  messageKey?: string;
  messageParams?: Record<string, string | number>;
  action?: string;
  actionKey?: string;
  copyCommand?: string;
  retryable?: boolean;
  technicalDetails?: EnterpriseTechnicalDetails;
}

export interface SenderLike {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

export interface ReasoningHandlerDeps {
  localService: LocalReasoningServiceLike;
  getAnthropicKey: () => string;
  proxyFetch: (url: string, init?: Record<string, unknown>) => Promise<ProxyFetchResponse>;
  extractAnthropicText: (data: unknown) => string | null;
  describeMissingAnthropicText: (data: unknown) => string;
  isEnterpriseProvider: (value: unknown) => boolean;
  mapEnterpriseError: (
    provider: string,
    error: unknown,
    config: Record<string, unknown>
  ) => MappedEnterpriseError;
  runAbortableOperation: <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
  runBedrockRequest: <T>(
    operation: () => Promise<T>,
    options?: { signal?: AbortSignal }
  ) => Promise<T>;
  validateEnterpriseEndpoint: (endpoint?: string) => void;
  generateText: (options: Record<string, unknown>) => Promise<{
    text: string;
    finishReason: string;
  }>;
  getEnterpriseAIModel: (
    provider: string,
    model: string,
    apiKey: string,
    enterprise: EnterpriseRuntime["enterprise"]
  ) => Promise<EnterpriseStreamModel>;
  // The Bedrock one-shot cleanup registry — a separate instance from the
  // streaming registry, so cancelling one operation never touches the other.
  bedrockCleanupRequests: AgentStreamRequestRegistry;
  enterpriseStreams: AgentStreamRequestRegistry;
  logError: (message: string, data?: unknown) => void;
}

export interface ReasoningIpcMain {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
}

// Compile-time pins: the narrow model/reader interfaces above must stay
// structurally compatible with the real SDK model, and every part main reads
// is already the SDK's union — the adapter below never widens it to unknown.
const _sdkModelIsStreamModel: (model: LanguageModelV3) => EnterpriseStreamModel = (model) => model;

void _sdkModelIsStreamModel;

// --- Enterprise runtime ------------------------------------------------------

export function resolveEnterpriseRuntime(
  provider: string,
  modelId: string,
  config: Record<string, unknown> = {}
): EnterpriseRuntime {
  return {
    provider,
    model: (config.model as string) || modelId,
    apiKey: (config.apiKey as string) || "",
    enterprise: pickEnterpriseConfig(config),
  };
}

// --- Structured-clone adapter for stream parts ------------------------------

function describeUnclearError(value: unknown): Error {
  if (value instanceof Error) return new Error(value.message);

  return new Error(String(value));
}

// IPC uses structured clone. Most SDK parts are plain data and clone as-is;
// the two fields that can carry non-cloneable values (provider `raw` payloads
// and arbitrary `error` values) degrade narrowly instead of JSON-stringifying
// the whole part or dropping text/tool/usage/binary content.
export function toCloneableStreamPart(part: LanguageModelV3StreamPart): LanguageModelV3StreamPart {
  try {
    return structuredClone(part);
  } catch {
    if (part.type === "raw") {
      const raw = part as { type: "raw"; rawValue: unknown };

      return { type: "raw", rawValue: describeUnclearError(raw.rawValue).message };
    }

    if (part.type === "error") {
      const errored = part as { type: "error"; error: unknown };

      return { type: "error", error: describeUnclearError(errored.error) };
    }

    return {
      type: "error",
      error: new Error(`Stream part of type ${String(part.type)} could not be serialized`),
    };
  }
}

// --- Helpers -----------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function enterpriseFailure(
  deps: ReasoningHandlerDeps,
  provider: string,
  error: unknown,
  config: Record<string, unknown>,
  runtime?: EnterpriseRuntime
): EnterpriseReasoningResult {
  deps.logError("Enterprise reasoning error:", error);

  const mappingConfig =
    runtime?.provider === "bedrock" && runtime.enterprise.bedrockRegion
      ? { ...config, bedrockRegion: runtime.enterprise.bedrockRegion }
      : config;

  const mapped = deps.mapEnterpriseError(provider, error, mappingConfig);

  return {
    success: false,
    error: mapped.message,
    ...(mapped.messageKey !== undefined ? { messageKey: mapped.messageKey } : {}),
    ...(mapped.messageParams !== undefined ? { messageParams: mapped.messageParams } : {}),
    ...(mapped.action !== undefined ? { action: mapped.action } : {}),
    ...(mapped.actionKey !== undefined ? { actionKey: mapped.actionKey } : {}),
    ...(mapped.copyCommand !== undefined ? { copyCommand: mapped.copyCommand } : {}),
    ...(mapped.retryable !== undefined ? { retryable: mapped.retryable } : {}),
    ...(mapped.technicalDetails !== undefined ? { technicalDetails: mapped.technicalDetails } : {}),
  };
}

// --- Local one-shot ----------------------------------------------------------

function registerLocalHandlers(ipcMain: ReasoningIpcMain, deps: ReasoningHandlerDeps): void {
  ipcMain.handle(reasoningChannels.processLocalReasoning, async (_event, ...args: unknown[]) => {
    const parsed = localReasoningArgsSchema.safeParse(args);

    if (!parsed.success) {
      return { success: false, error: "Invalid local reasoning request" };
    }

    const [text, modelId, , config] = parsed.data;

    try {
      const result = await deps.localService.processText(text, modelId, config ?? {});

      return { success: true, text: result };
    } catch (error) {
      const err = error as { message?: string; code?: string; details?: Record<string, unknown> };

      // code/details carry the machine-readable failure across to the
      // renderer, which owns the translation keys. Flattening to a bare
      // string is how llama.cpp JSON used to reach users (#2142).
      return {
        success: false,
        ...(err.message !== undefined ? { error: err.message } : {}),
        ...(err.code !== undefined ? { code: err.code } : {}),
        ...(err.details !== undefined ? { details: err.details } : {}),
      };
    }
  });

  ipcMain.handle(reasoningChannels.checkLocalReasoningAvailable, async () => {
    try {
      return await deps.localService.isAvailable();
    } catch {
      return false;
    }
  });
}

// --- Anthropic one-shot ------------------------------------------------------

function registerAnthropicHandler(ipcMain: ReasoningIpcMain, deps: ReasoningHandlerDeps): void {
  ipcMain.handle(
    reasoningChannels.processAnthropicReasoning,
    async (_event, ...args: unknown[]) => {
      const parsed = anthropicReasoningArgsSchema.safeParse(args);

      if (!parsed.success) {
        return { success: false, error: "Invalid Anthropic reasoning request" };
      }

      const [text, modelId, , config = {}] = parsed.data;

      try {
        const apiKey = deps.getAnthropicKey();

        if (!apiKey) {
          throw new Error("Anthropic API key not configured");
        }

        const systemPrompt = config.systemPrompt || "";
        const userPrompt = text;

        if (!modelId) {
          throw new Error("No model specified for Anthropic API call");
        }

        const screenContext = config.screenContext;

        const userContent = screenContext
          ? [
              { type: "text", text: userPrompt },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: screenContext.mediaType,
                  data: screenContext.data,
                },
              },
            ]
          : userPrompt;

        // Claude models from Opus 4.7 onward reject `temperature` with a 400;
        // the renderer derives support from the model registry.
        const useTemperature = config.supportsTemperature === true;

        const requestBody = {
          model: modelId,
          messages: [{ role: "user", content: userContent }],
          system: systemPrompt,
          max_tokens: config.maxTokens || Math.max(100, Math.min(text.length * 2, 4096)),
          ...(useTemperature ? { temperature: config.temperature ?? 0.3 } : {}),
        };

        const response = await deps.proxyFetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorText = await response.text();
          let errorData: Record<string, unknown> = { error: response.statusText };

          try {
            errorData = asRecord(JSON.parse(errorText)) ?? {
              error: errorText || response.statusText,
            };
          } catch {
            errorData = { error: errorText || response.statusText };
          }

          const errorField = errorData.error;

          const message =
            (typeof errorField === "string" && errorField) ||
            (asRecord(errorField)?.message as string | undefined);

          throw new Error(message || `Anthropic API error: ${response.status}`);
        }

        const data = await response.json();

        if (config.requireCompleteOutput && asRecord(data)?.stop_reason === "max_tokens") {
          throw new Error("Model output was truncated before the selection edit completed");
        }

        const outputText = deps.extractAnthropicText(data);

        if (outputText === null) {
          throw new Error(deps.describeMissingAnthropicText(data));
        }

        return { success: true, text: outputText };
      } catch (error) {
        const err = error as { message?: string };
        deps.logError("Anthropic reasoning error:", error);

        return { success: false, ...(err.message !== undefined ? { error: err.message } : {}) };
      }
    }
  );
}

// --- Enterprise one-shot -----------------------------------------------------

function registerEnterpriseOneShotHandlers(
  ipcMain: ReasoningIpcMain,
  deps: ReasoningHandlerDeps
): void {
  ipcMain.handle(
    reasoningChannels.processEnterpriseReasoning,
    async (event, ...args: unknown[]): Promise<EnterpriseReasoningResult> => {
      const parsed = enterpriseReasoningArgsSchema.safeParse(args);

      if (!parsed.success) {
        return { success: false, error: "Invalid enterprise reasoning request" };
      }

      const [text, modelId, , config = {} as EnterpriseReasoningConfig] = parsed.data;
      const provider = config.provider;
      let runtime;

      try {
        if (!deps.isEnterpriseProvider(provider)) {
          throw new Error(`Unsupported enterprise provider: ${provider}`);
        }

        const isBedrockCleanup = provider === "bedrock" && config.inferenceScope === "cleanup";

        const sender = isBedrockCleanup ? (event as { sender: SenderLike }).sender : null;
        const senderId = sender?.id;
        const requestId = isBedrockCleanup ? randomUUID() : null;

        const controller = isBedrockCleanup
          ? deps.bedrockCleanupRequests.begin(senderId as number, requestId as string)
          : null;

        const cancelSenderRequests = () =>
          deps.bedrockCleanupRequests.cancelSender(senderId as number);

        try {
          if (controller) {
            sender?.once("destroyed", cancelSenderRequests);

            if (sender?.isDestroyed()) controller.abort();
          }

          controller?.signal.throwIfAborted();

          const timeoutMs = config.timeoutMs || 60000;
          // Opus 4.7 / GPT-5 / o-series dropped `temperature`; renderer
          // derives support from the model registry and we honor that here.
          const useTemperature = config.supportsTemperature !== false;

          const resolveModel = (abortSignal?: AbortSignal) =>
            deps.runAbortableOperation(async () => {
              runtime = resolveEnterpriseRuntime(provider, modelId, config);
              abortSignal?.throwIfAborted();

              if (!runtime.model) throw new Error("No model specified for enterprise reasoning");
              deps.validateEnterpriseEndpoint(runtime.enterprise.azureEndpoint);

              return deps.getEnterpriseAIModel(
                runtime.provider,
                runtime.model,
                runtime.apiKey,
                runtime.enterprise
              );
            }, abortSignal);

          const generate = (
            model: Awaited<ReturnType<ReasoningHandlerDeps["getEnterpriseAIModel"]>>,
            abortSignal?: AbortSignal,
            disableNestedRetries = false
          ) => {
            return deps.generateText({
              model,
              system: config.systemPrompt || "",
              prompt: text,
              maxOutputTokens: config.maxTokens || 4096,
              ...(useTemperature ? { temperature: config.temperature ?? 0.3 } : {}),
              ...(abortSignal ? { abortSignal } : {}),
              ...(disableNestedRetries ? { maxRetries: 0 } : {}),
            });
          };

          let result;

          if (isBedrockCleanup) {
            result = await deps.runBedrockRequest(
              async () => {
                const abortSignal = AbortSignal.any([
                  (controller as AbortController).signal,
                  AbortSignal.timeout(timeoutMs),
                ]);

                const model = await resolveModel(abortSignal);

                return generate(model, abortSignal, true);
              },
              { signal: (controller as AbortController).signal }
            );
          } else {
            const model = await resolveModel();
            result = await generate(model, AbortSignal.timeout(timeoutMs));
          }

          const { text: generated, finishReason } = result;

          if (
            config.requireCompleteOutput &&
            ["length", "max-tokens", "max_tokens"].includes(finishReason)
          ) {
            throw new Error("Model output was truncated before the selection edit completed");
          }

          return { success: true, text: (generated || "").trim() };
        } finally {
          if (controller) {
            sender?.removeListener("destroyed", cancelSenderRequests);
            deps.bedrockCleanupRequests.complete(
              senderId as number,
              requestId as string,
              controller
            );
          }
        }
      } catch (err) {
        return enterpriseFailure(deps, provider, err, config, runtime);
      }
    }
  );

  ipcMain.on(reasoningChannels.cancelEnterpriseReasoning, (event) => {
    deps.bedrockCleanupRequests.cancelSender((event as { sender: SenderLike }).sender.id);
  });
}

// --- Enterprise streaming ----------------------------------------------------

function registerEnterpriseStreamHandlers(
  ipcMain: ReasoningIpcMain,
  deps: ReasoningHandlerDeps
): void {
  // Runs doStream for the renderer's enterprise chat model shim; parts are
  // relayed verbatim over the part event, ending with {done}/{error}.
  ipcMain.handle(
    reasoningChannels.enterpriseStreamStart,
    async (event, ...args: unknown[]): Promise<{ success: boolean; error?: string }> => {
      const parsed = enterpriseStreamStartRequestSchema.safeParse(args[0]);

      if (!parsed.success) {
        return { success: false, error: "Invalid stream request" };
      }

      const { streamId, provider, modelId, config = {}, options } = parsed.data;
      const sender = (event as { sender: SenderLike }).sender;

      const send = (message: { part?: unknown; done?: boolean; error?: string }) => {
        if (!sender.isDestroyed()) {
          sender.send(reasoningChannels.enterpriseStreamPart, { streamId, ...message });
        }
      };

      // Sender-scoped: a repeated streamId of this sender aborts the previous
      // stream; another renderer's stream with the same id is untouched.
      const controller = deps.enterpriseStreams.begin(sender.id, streamId);

      // A terminal event may only go out while this exact controller is still
      // the live entry — a replacement (or a cancel) must never receive a
      // late done/error for the id it now owns.
      const maySendTerminal = () =>
        deps.enterpriseStreams.isActive(sender.id, streamId, controller);

      // isDestroyed() stays false across reload/navigation, which wipes the
      // renderer listeners — abort so the provider request isn't billed for
      // a generation nobody receives.
      const abortOnGone = (
        _event: unknown,
        _url: unknown,
        isInPlace: unknown,
        isMainFrame: unknown
      ) => {
        if (isMainFrame && !isInPlace) controller.abort();
      };

      const abortOnDestroyed = () => controller.abort();
      sender.on("did-start-navigation", abortOnGone);
      sender.once("destroyed", abortOnDestroyed);
      let runtime;

      try {
        if (!deps.isEnterpriseProvider(provider)) {
          throw new Error(`Unsupported enterprise provider: ${provider}`);
        }

        runtime = resolveEnterpriseRuntime(provider, modelId, config);

        if (!runtime.model) throw new Error("No model specified for enterprise streaming");
        deps.validateEnterpriseEndpoint(runtime.enterprise.azureEndpoint);
        // A cancel or replacement that landed while the model resolved must
        // not start a billable provider request.
        controller.signal.throwIfAborted();

        const model = await deps.getEnterpriseAIModel(
          runtime.provider,
          runtime.model,
          runtime.apiKey,
          runtime.enterprise
        );

        controller.signal.throwIfAborted();

        const { stream } = await model.doStream({
          ...options,
          abortSignal: controller.signal,
        });

        const reader = stream.getReader();

        try {
          for (;;) {
            const { done, value } = await reader.read();

            if (done) break;

            if (sender.isDestroyed()) {
              controller.abort();
              break;
            }

            if (controller.signal.aborted) break;

            if (value !== undefined) send({ part: toCloneableStreamPart(value) });
          }
        } finally {
          reader.releaseLock();
        }

        if (maySendTerminal()) send({ done: true });

        return { success: true };
      } catch (err) {
        deps.logError("Enterprise stream error:", err);

        const mappingConfig =
          runtime?.provider === "bedrock" && runtime.enterprise.bedrockRegion
            ? { ...config, bedrockRegion: runtime.enterprise.bedrockRegion }
            : config;

        const mapped = deps.mapEnterpriseError(provider, err, mappingConfig);

        if (maySendTerminal()) send({ error: mapped.message });

        return {
          success: false,
          ...(mapped.message !== undefined ? { error: mapped.message } : {}),
        };
      } finally {
        deps.enterpriseStreams.complete(sender.id, streamId, controller);

        if (!sender.isDestroyed()) {
          sender.removeListener("did-start-navigation", abortOnGone);
          sender.removeListener("destroyed", abortOnDestroyed);
        }
      }
    }
  );

  ipcMain.handle(reasoningChannels.enterpriseStreamCancel, async (event, ...args: unknown[]) => {
    const streamId = args[0];

    if (typeof streamId !== "string" || !streamId) return;
    // Cancel looks up the stream by the sender of THIS event, so one renderer
    // can never abort another renderer's stream.
    deps.enterpriseStreams.cancel((event as { sender: SenderLike }).sender.id, streamId);
  });
}

export function registerReasoningHandlers(
  ipcMain: ReasoningIpcMain,
  deps: ReasoningHandlerDeps
): void {
  registerLocalHandlers(ipcMain, deps);
  registerAnthropicHandler(ipcMain, deps);
  registerEnterpriseOneShotHandlers(ipcMain, deps);
  registerEnterpriseStreamHandlers(ipcMain, deps);
}
