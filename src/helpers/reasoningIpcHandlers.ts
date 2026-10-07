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
  type AnthropicReasoningResult,
  type EnterpriseReasoningResult,
  type EnterpriseStreamEnvelope,
  type EnterpriseTechnicalDetails,
  type LocalReasoningConfig,
  type LocalReasoningResult,
} from "../contracts/reasoning.js";
import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { Event as ElectronEvent, WebContentsDidStartNavigationEventParams } from "electron";

// --- Inbound payload shapes -------------------------------------------------
//
// Every IPC argument is decoded by a contract schema before these helpers run
// (see the tuple/stream-start schemas above). The interfaces below only name
// the fields main reads off already-decoded values or off SDK-owned contracts;
// they are not open dictionaries.

interface AnthropicResponseBody {
  content?: unknown;
  stop_reason?: unknown;
  error?: unknown;
  message?: unknown;
}

interface LocalReasoningFailure extends Record<string, unknown> {
  message?: unknown;
  code?: unknown;
  details?: unknown;
}

interface LocalErrorDetails extends Record<string, unknown> {}

interface MessageCarrier extends Record<string, unknown> {
  message?: unknown;
}

// The Bedrock/Azure/Vertex error mapper receives the parsed request config,
// optionally enriched with the runtime region. An index signature keeps the
// passthrough credential/generation fields flowing through untouched.
interface EnterpriseMappingConfig extends Record<string, unknown> {
  bedrockRegion?: string;
}

// `pickEnterpriseConfig` normalizes the credential subset; the raw config this
// runtime reads carries the model/apiKey overrides alongside it.
interface EnterpriseRuntimeSource extends Record<string, unknown> {
  model?: unknown;
  apiKey?: unknown;
}

interface SenderEvent {
  sender: unknown;
}

interface EnterpriseStreamMessage {
  part?: unknown;
  done?: boolean;
  error?: string;
}

// --- Runtime type guards ----------------------------------------------------

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isAnthropicResponseBody(value: unknown): value is AnthropicResponseBody {
  return typeof value === "object" && value !== null;
}

function isLocalReasoningFailure(value: unknown): value is LocalReasoningFailure {
  return typeof value === "object" && value !== null;
}

function isLocalErrorDetails(value: unknown): value is LocalErrorDetails {
  return typeof value === "object" && value !== null;
}

function isMessageCarrier(value: unknown): value is MessageCarrier {
  return typeof value === "object" && value !== null;
}

function isSenderEvent<T>(value: T): value is T & SenderEvent {
  return typeof value === "object" && value !== null && "sender" in value;
}

function isSenderIdentity(value: unknown): value is SenderIdentity {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "number" &&
    "isDestroyed" in value &&
    typeof value.isDestroyed === "function"
  );
}

function isSenderLifecycle(value: unknown): value is SenderLifecycle {
  return (
    isSenderIdentity(value) &&
    "once" in value &&
    typeof value.once === "function" &&
    "removeListener" in value &&
    typeof value.removeListener === "function"
  );
}

function isSenderLike(value: unknown): value is SenderLike {
  return (
    isSenderLifecycle(value) &&
    "on" in value &&
    typeof value.on === "function" &&
    "send" in value &&
    typeof value.send === "function"
  );
}

// IPC events are structured-cloned external input; decode the sender before
// dispatching to the sender-scoped registries. The cleanup lifecycle needs
// only, and therefore accepts, the identity + once/removeListener subset.
function senderFrom<T>(event: T): SenderLifecycle {
  if (isSenderEvent(event) && isSenderLifecycle(event.sender)) return event.sender;

  throw new TypeError("IPC event is missing a sender");
}

// Enterprise streaming additionally emits parts and listens for navigation.
function senderStreamFrom<T>(event: T): SenderLike {
  if (isSenderEvent(event) && isSenderLike(event.sender)) return event.sender;

  throw new TypeError("IPC event is missing a sender");
}

// A non-JSON error body must degrade to the raw text, not throw a second time.
function parseAnthropicError(text: string): AnthropicResponseBody | null {
  try {
    const parsed: unknown = JSON.parse(text);

    return isAnthropicResponseBody(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// --- Narrow dependency interfaces -------------------------------------------

export interface LocalReasoningServiceLike {
  isAvailable(): Promise<boolean>;
  processText(text: string, modelId: string, config: LocalReasoningConfig): Promise<string>;
}

// The response body stays a generic so the composition root can pass Electron's
// `net.fetch` Response (whose `json()` is `Promise<unknown>`) unchanged; every
// body is decoded with a guard before it is read.
export interface ProxyFetchResponse<Body = unknown> {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<Body>;
}

export interface ProxyFetchInit extends Record<string, unknown> {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
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

// The SDK call options the shim actually relays are serializable fields plus
// the main-injected abortSignal; the open index keeps the passthrough options
// (prompt, tools, providerOptions, …) flowing to the provider unchanged.
export interface EnterpriseStreamCallOptions extends Record<string, unknown> {
  prompt?: unknown;
  abortSignal?: AbortSignal;
}

// The slice of LanguageModelV3 main actually drives: doStream + a reader.
// PromiseLike mirrors the SDK's doStream return so the interface stays
// structurally assignable from the real model.
export interface EnterpriseStreamModel {
  doStream(options: EnterpriseStreamCallOptions): PromiseLike<{ stream: EnterpriseModelStream }>;
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

export interface SenderIdentity {
  id: number;
  isDestroyed(): boolean;
}

// The Bedrock cleanup lifecycle only needs to observe destroy.
export interface SenderLifecycle extends SenderIdentity {
  once(event: string, listener: (...args: never[]) => void): void;
  removeListener(event: string, listener: (...args: never[]) => void): void;
}

export interface SenderLike extends SenderLifecycle {
  send(channel: string, payload: EnterpriseStreamEnvelope): void;
  on(event: string, listener: (...args: never[]) => void): void;
}

export interface GenerateTextOptions extends Record<string, unknown> {
  model?: EnterpriseStreamModel;
  system?: string;
  prompt?: string;
  maxOutputTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
  maxRetries?: number;
}

export interface ReasoningHandlerDeps {
  localService: LocalReasoningServiceLike;
  getAnthropicKey: () => string;
  proxyFetch: (url: string, init?: ProxyFetchInit) => Promise<ProxyFetchResponse>;
  extractAnthropicText: <T>(data: T) => string | null;
  describeMissingAnthropicText: <T>(data: T) => string;
  isEnterpriseProvider: (value: string) => boolean;
  mapEnterpriseError: <T>(
    provider: string,
    error: T,
    config: EnterpriseMappingConfig
  ) => MappedEnterpriseError;
  runAbortableOperation: <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
  runBedrockRequest: <T>(
    operation: () => Promise<T>,
    options?: { signal?: AbortSignal }
  ) => Promise<T>;
  validateEnterpriseEndpoint: (endpoint?: string) => void;
  generateText: (options: GenerateTextOptions) => Promise<{
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
  logError: <T>(message: string, data?: T) => void;
}

export interface ReasoningIpcMain {
  handle<Result>(channel: string, listener: (...args: unknown[]) => Result): void;
  on(channel: string, listener: (...args: unknown[]) => void): void;
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
  config: EnterpriseRuntimeSource = {}
): EnterpriseRuntime {
  return {
    provider,
    model: isString(config.model) && config.model ? config.model : modelId,
    apiKey: isString(config.apiKey) ? config.apiKey : "",
    enterprise: pickEnterpriseConfig(config),
  };
}

// --- Structured-clone adapter for stream parts ------------------------------

function describeUnclearError<T>(value: T): Error {
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
      return { type: "raw", rawValue: describeUnclearError(part.rawValue).message };
    }

    if (part.type === "error") {
      return { type: "error", error: describeUnclearError(part.error) };
    }

    return {
      type: "error",
      error: new Error(`Stream part of type ${String(part.type)} could not be serialized`),
    };
  }
}

// --- Helpers -----------------------------------------------------------------

function enterpriseFailure<T>(
  deps: ReasoningHandlerDeps,
  provider: string,
  error: T,
  config: EnterpriseMappingConfig,
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
  ipcMain.handle(
    reasoningChannels.processLocalReasoning,
    async (_event, ...args: unknown[]): Promise<LocalReasoningResult> => {
      const parsed = localReasoningArgsSchema.safeParse(args);

      if (!parsed.success) {
        return { success: false, error: "Invalid local reasoning request" };
      }

      const [text, modelId, , config] = parsed.data;

      try {
        const result = await deps.localService.processText(text, modelId, config ?? {});

        return { success: true, text: result };
      } catch (error) {
        const err = isLocalReasoningFailure(error) ? error : null;
        const message = err !== null && isString(err.message) ? err.message : undefined;
        const code = err !== null && isString(err.code) ? err.code : undefined;

        const details = err !== null && isLocalErrorDetails(err.details) ? err.details : undefined;

        // code/details carry the machine-readable failure across to the
        // renderer, which owns the translation keys. Flattening to a bare
        // string is how llama.cpp JSON used to reach users (#2142).
        return {
          success: false,
          ...(message !== undefined ? { error: message } : {}),
          ...(code !== undefined ? { code } : {}),
          ...(details !== undefined ? { details } : {}),
        };
      }
    }
  );

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
    async (_event, ...args: unknown[]): Promise<AnthropicReasoningResult> => {
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
          const errorBody = parseAnthropicError(errorText);

          const errorField =
            errorBody !== null ? errorBody.error : errorText || response.statusText;

          const message =
            isString(errorField) && errorField
              ? errorField
              : isAnthropicResponseBody(errorField) && isString(errorField.message)
                ? errorField.message
                : undefined;

          throw new Error(message || `Anthropic API error: ${response.status}`);
        }

        const data = await response.json();

        if (
          config.requireCompleteOutput &&
          isAnthropicResponseBody(data) &&
          data.stop_reason === "max_tokens"
        ) {
          throw new Error("Model output was truncated before the selection edit completed");
        }

        const outputText = deps.extractAnthropicText(data);

        if (outputText === null) {
          throw new Error(deps.describeMissingAnthropicText(data));
        }

        return { success: true, text: outputText };
      } catch (error) {
        const err = isMessageCarrier(error) ? error : null;
        deps.logError("Anthropic reasoning error:", error);

        return {
          success: false,
          ...(err !== null && isString(err.message) ? { error: err.message } : {}),
        };
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

      const [text, modelId, , config] = parsed.data;
      const provider = config.provider;
      let runtime: EnterpriseRuntime | undefined;

      try {
        if (!deps.isEnterpriseProvider(provider)) {
          throw new Error(`Unsupported enterprise provider: ${provider}`);
        }

        const isBedrockCleanup = provider === "bedrock" && config.inferenceScope === "cleanup";

        const sender = isBedrockCleanup ? senderFrom(event) : null;
        const requestId = isBedrockCleanup ? randomUUID() : null;

        const controller =
          sender !== null && requestId !== null
            ? deps.bedrockCleanupRequests.begin(sender.id, requestId)
            : null;

        const cancelSenderRequests = () => {
          if (sender !== null) deps.bedrockCleanupRequests.cancelSender(sender.id);
        };

        try {
          if (controller && sender) {
            sender.once("destroyed", cancelSenderRequests);

            if (sender.isDestroyed()) controller.abort();
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

          if (isBedrockCleanup && controller) {
            result = await deps.runBedrockRequest(
              async () => {
                const abortSignal = AbortSignal.any([
                  controller.signal,
                  AbortSignal.timeout(timeoutMs),
                ]);

                const model = await resolveModel(abortSignal);

                return generate(model, abortSignal, true);
              },
              { signal: controller.signal }
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
          if (controller && sender && requestId) {
            sender.removeListener("destroyed", cancelSenderRequests);
            deps.bedrockCleanupRequests.complete(sender.id, requestId, controller);
          }
        }
      } catch (err) {
        return enterpriseFailure(deps, provider, err, config, runtime);
      }
    }
  );

  ipcMain.on(reasoningChannels.cancelEnterpriseReasoning, (event) => {
    deps.bedrockCleanupRequests.cancelSender(senderFrom(event).id);
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
      const sender = senderStreamFrom(event);

      const send = (message: EnterpriseStreamMessage) => {
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
      // a generation nobody receives. The listener matches WebContents'
      // did-start-navigation signature: (details, url, isInPlace, isMainFrame).
      const abortOnGone = (
        _details: ElectronEvent<WebContentsDidStartNavigationEventParams>,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean
      ): void => {
        if (isMainFrame && !isInPlace) controller.abort();
      };

      const abortOnDestroyed = () => controller.abort();
      sender.on("did-start-navigation", abortOnGone);
      sender.once("destroyed", abortOnDestroyed);
      let runtime: EnterpriseRuntime | undefined;

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

  ipcMain.handle(reasoningChannels.enterpriseStreamCancel, (event, ...args: unknown[]) => {
    const streamId = args[0];

    if (!isString(streamId) || !streamId) return;
    // Cancel looks up the stream by the sender of THIS event, so one renderer
    // can never abort another renderer's stream.
    deps.enterpriseStreams.cancel(senderFrom(event).id, streamId);
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
