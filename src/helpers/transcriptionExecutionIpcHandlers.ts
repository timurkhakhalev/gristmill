// The transcription execution IPC handlers, moved out of ipcHandlers.js:
// mic-buffer local engines (whisper/parakeet), the main-proxied provider
// transports (xAI/Mistral/Corti/Tinfoil/Gemini), retry of a stored
// transcription, voice-draft temp audio, and provider connection / model
// discovery. Channels, arguments, results and errors are unchanged; untrusted
// payloads are parsed at the boundary and only validated values reach the
// managers. The heavy `ai`/AWS SDKs and the Corti client stay lazy via
// injected factories so startup never eager-loads them.
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import {
  resolveTranscriptionRoute,
  byokSizeCapError,
  MISTRAL_TRANSCRIPTION_URL,
  XAI_STT_URL,
  XAI_STT_LANGUAGES,
} from "./transcriptionRoute.js";
import type { TranscriptionProviderBaseUrl } from "../services/transcriptionBaseUrl.js";
import { PARAKEET_UNSUPPORTED_OS_CODE } from "./parakeetCapability.js";
import { getCortiToken } from "./cortiAuth.js";
import { testProviderConnection } from "./providerConnectionTest.js";
import { getTinfoilChatModels } from "./tinfoilCatalog.js";
import { transcribeWithTinfoil } from "./tinfoilTranscription.js";
import { transcribeWithGemini } from "./geminiTranscription.js";
import { deepgramFileUrl, parseDeepgramFileResponse } from "./deepgramFileTranscription.js";
import {
  ELEVENLABS_TRANSCRIPTION_URL,
  elevenLabsFields,
  parseElevenLabsFileResponse,
} from "./elevenLabsFileTranscription.js";
import { buildMultipartBody } from "./remoteTranscriptionIpcHandler.js";
import type { RemoteTranscriptionResult } from "../contracts/uploadTranscription.js";
import { normalizeBedrockCatalog } from "./bedrockCatalog.js";
import { resolveEnterpriseRuntime, type EnterpriseRuntime } from "./reasoningIpcHandlers.js";
import type { WhisperLocalTranscribeOptions } from "./whisper.js";
import type { ParakeetTranscribeOptions } from "./parakeet.js";
import {
  mapEnterpriseError,
  runAbortableOperation,
  runBedrockRequest,
  validateEnterpriseEndpoint,
} from "./enterpriseProviderErrors.js";
import {
  transcriptionExecutionChannels,
  binaryLikeSchema,
  enterpriseConnectionArgsSchema,
  providerConnectionConfigSchema,
  proxyCortiArgsSchema,
  proxyGeminiArgsSchema,
  proxyMistralArgsSchema,
  proxyTinfoilArgsSchema,
  proxyTranscriptionResultSchema,
  proxyXaiArgsSchema,
  retryTranscriptionArgsSchema,
  transcriptionResponseSchema,
  whisperOptionsSchema,
  parakeetOptionsSchema,
  type BufferLike,
  type EnterpriseConnectionResult,
  type ProxyTranscriptionResult,
  type RetryTranscriptionResult,
  type TranscriptionResponse,
} from "../contracts/transcriptionExecution.js";
import type { SuccessResult, TranscriptionRow } from "./database.js";

type IpcMainLike = {
  handle<Result>(channel: string, listener: (...args: unknown[]) => Result): void;
};

// Azure Responses rejects probes with fewer than 16 output tokens. The probe
// only needs one word, but this is the provider's minimum accepted value.
const CONNECTION_TEST_MAX_OUTPUT_TOKENS = 16;

// The primitive tags `typeof` can report, in the order the helper probes them.
const RUNTIME_TYPES = [
  "undefined",
  "boolean",
  "number",
  "bigint",
  "string",
  "symbol",
  "function",
] as const;

function isRuntimeType<T, Name extends string>(
  value: T,
  name: Name
): value is T & Record<Name, true> {
  return typeof value === name;
}

// Reproduce the historical `typeof` log value while keeping the probe inside a
// declared type guard (null and containers collapse to "object").
function runtimeTypeOf<T>(value: T): string {
  for (const name of RUNTIME_TYPES) {
    if (isRuntimeType(value, name)) return name;
  }

  return "object";
}

// The audio payloads the local managers accept carry a byte/length readout.
function hasAudioSize<T>(value: T): value is T & { byteLength?: number; length?: number } {
  return (typeof value === "object" && value !== null) || typeof value === "string";
}

// The error envelope proxy handlers resolve with when the transport throws.
interface SerializedIpcError {
  error?: string;
  code?: string;
  messageKey?: string;
}

// The retry failure shape, including the provider extras the historical spread
// carried (messageKey and any coded fields). A type alias (not an interface) so
// it keeps the implicit index signature the passthrough result schema expects.
type RetryFailure = {
  success: false;
  error?: string;
  code?: string;
  messageKey?: string;
};

// The conventional `message`/`code` reads on a thrown value; each is guarded so
// junk rejections degrade the same way the previous unchecked reads did.
function messageOf<T>(error: T): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function errorNameOf<T>(error: T): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function isString<T>(value: T): value is T & string {
  return typeof value === "string";
}

// A provider JSON body is an object until its fields are checked; junk bodies
// (arrays, null) degrade to "no text" exactly as the loose read did.
function isProviderTextBody<T>(value: T): value is T & { text?: unknown } {
  return typeof value === "object" && value !== null;
}

function codeOf<T>(error: T): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;

  const code: unknown = error.code;

  return isString(code) ? code : undefined;
}

function messageKeyOf<T>(error: T): string | undefined {
  if (!(error instanceof Error) || !("messageKey" in error)) return undefined;

  const messageKey: unknown = error.messageKey;

  return isString(messageKey) ? messageKey : undefined;
}

export interface Logger {
  log: <T>(message: string, data?: T) => void;
  debug: <T>(message: string, data?: T) => void;
  warn: <T>(message: string, data?: T) => void;
  error: <T>(message: string, data?: T, tag?: string) => void;
}

// The whisper-server VAD resolver reads vadEnabled plus its sanitized numeric
// config keys off this record; every value is a scalar.
export interface WhisperVadOptions {
  vadEnabled: boolean;
  vadConfig?: Record<string, number>;
}

// The narrow slice this module drives on an enterprise model: it is only
// forwarded to generateText's `model` option, so the read surface stays weak
// enough for both the real SDK model and the connection-test fixtures.
export interface EnterpriseModelLike {
  doStream?: (...args: never[]) => object;
}

// The `ai` generateText options this module builds for its connection probes.
export interface GenerateTextOptions extends Record<string, unknown> {
  model?: EnterpriseModelLike;
  system?: string;
  prompt?: string;
  maxOutputTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
  maxRetries?: number;
}

export interface GenerateTextResult {
  text?: string;
  finishReason?: string;
}

export interface StoredCortiToken {
  token: string;
  environment?: string;
  tenant?: string;
}

// The Bedrock SDK list payloads this module projects through
// normalizeBedrockCatalog. Provider-boundary shapes, read field-by-field by the
// catalog normalizer.
export interface BedrockModelSummary {
  modelId?: string;
  outputModalities?: string[];
  modelLifecycle?: { status?: string };
  inferenceTypesSupported?: string[];
  modelName?: string;
  providerName?: string;
}

export interface BedrockInferenceProfileSummary {
  inferenceProfileId?: string;
  models?: Array<{ modelArn?: string }>;
}

export interface BedrockCommand {
  readonly __command?: unknown;
}

export interface BedrockClientLike {
  send(command: BedrockCommand): Promise<{ modelSummaries?: BedrockModelSummary[] }>;
}

export interface BedrockCredentialProvider {
  provider: (options?: { forceRefresh?: boolean }) => Promise<{
    accessKeyId: string;
    secretAccessKey: string;
  }>;
}

// A Bedrock client accepts either a lazy credential provider (a named profile)
// or static credentials; the listing builder passes the profile chain or the
// access-key triple.
export type BedrockCredentials =
  | BedrockCredentialProvider
  | {
      accessKeyId?: string;
      secretAccessKey?: string;
      sessionToken?: string;
    };

// The Electron-session fetch response slice this module reads; the body is a
// caller-named generic (parsed by the provider schemas before any use).
export interface ProxyFetchResponse<Body = unknown> {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<Body>;
}

export interface TranscriptionExecutionDeps {
  whisperManager: {
    transcribeLocalWhisper: <Audio>(
      audioBlob: Audio,
      options: WhisperLocalTranscribeOptions
    ) => Promise<TranscriptionResponse>;
  };
  parakeetManager: {
    transcribeLocalParakeet: <Audio>(
      audioBlob: Audio,
      options: ParakeetTranscribeOptions
    ) => Promise<TranscriptionResponse>;
  };
  resolveWhisperVadOptions: (context: string) => WhisperVadOptions;
  environmentManager: {
    getXaiKey: () => string;
    getMistralKey: () => string;
    getTinfoilKey: () => string;
    getGeminiKey: () => string;
    getDeepgramKey: () => string;
    getElevenLabsKey: () => string;
    getCortiClientId: () => string;
    getCortiClientSecret: () => string;
    getCustomTranscriptionKey: () => string;
    getGroqKey: () => string;
    getOpenAIKey: () => string;
  };
  // The Electron-session fetch used by the direct transports and retry —
  // owned by the composition root like the postMultipart transport. The body
  // stays a generic so the real Electron Response and test fakes both fit.
  proxyFetch: (
    url: string | URL,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
    }
  ) => Promise<ProxyFetchResponse>;
  transcribeGeminiFile: (args: {
    filePath: string;
    fileSizeBytes: number;
    contentType: string;
    model: string;
    apiKey: string;
    diarize: boolean;
  }) => Promise<RemoteTranscriptionResult>;
  // Lazy Corti client — only loaded when a Corti route actually runs.
  transcribeWithCorti: (args: {
    environment?: string;
    tenant?: string;
    clientId: string;
    clientSecret: string;
    audioBuffer: Buffer;
    language?: string;
  }) => Promise<{ text: string }>;
  // Mints a Corti access token from stored BYOK credentials (shared with the
  // dictation streaming handlers, which own the real implementation).
  mintStoredCortiToken: (options: {
    environment?: string;
    tenant?: string;
  }) => Promise<StoredCortiToken>;
  // Lazy `ai` SDK entry point — keeps startup free of the SDK; the wrapped
  // generateText still returns text/finishReason on a settled generation.
  generateText: (options: GenerateTextOptions) => Promise<GenerateTextResult>;
  // Lazy enterprise model factory from enterpriseAiProviders; the model is
  // only forwarded to generateText here, so the narrow read surface suffices.
  // A sync object is accepted alongside the promise so the composition root and
  // the connection-test fixtures share this contract.
  getEnterpriseAIModel: (
    provider: string,
    model: string,
    apiKey: string,
    enterprise: EnterpriseRuntime["enterprise"]
  ) => EnterpriseModelLike | Promise<EnterpriseModelLike>;
  // Lazy AWS SDK surfaces — heavy dependencies, loaded on first use only.
  bedrockSdk: () => Promise<{
    BedrockClient: new (config: {
      region: string;
      credentials?: BedrockCredentials;
    }) => BedrockClientLike;
    ListFoundationModelsCommand: new (args: { byOutputModality: string }) => BedrockCommand;
    paginateListInferenceProfiles: (
      config: { client: BedrockClientLike },
      args: { typeEquals: string }
    ) => AsyncIterable<{ inferenceProfileSummaries?: BedrockInferenceProfileSummary[] }>;
  }>;
  bedrockProfileCredentials: (profile: string) => BedrockCredentialProvider | null;
  providerBaseUrls: () => readonly TranscriptionProviderBaseUrl[];
  audioStorage: {
    getAudioBuffer: (id: number) => Buffer | null;
  };
  database: {
    updateTranscriptionText: (
      id: number,
      text: string,
      rawText: string | null
    ) => SuccessResult | void;
    updateTranscriptionStatus: (id: number, status: string) => SuccessResult | void;
    updateTranscriptionAudio: (
      id: number,
      update: {
        hasAudio: number;
        audioDurationMs: number | null;
        provider: string | null;
        model: string | null;
      }
    ) => SuccessResult | void;
    getTranscriptionById: (id: number) => TranscriptionRow | null;
  };
  broadcast: <Payload>(channel: string, payload: Payload) => void;
  logger: Logger;
}

// ipcMain.handle keeps only the message when a promise rejects, dropping custom
// props — proxy handlers return {error, code, messageKey} so the renderer can
// rebuild the error.
function serializeIpcError<Args extends unknown[], Result extends object>(
  fn: (...args: Args) => Promise<Result>
): (...args: Args) => Promise<Result | SerializedIpcError> {
  return async (...args: Args): Promise<Result | SerializedIpcError> => {
    try {
      return await fn(...args);
    } catch (error) {
      return { error: messageOf(error), code: codeOf(error), messageKey: messageKeyOf(error) };
    }
  };
}

function toBuffer(value: BufferLike): Buffer {
  if (value instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(value));
  }

  // SAFETY: BufferLike's other arm is an ArrayBufferView; its `buffer` is the
  // backing store the view was constructed over. The 3-arg Buffer.from form
  // needs a non-shared ArrayBuffer, which is what binary IPC supplies.
  return Buffer.from(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
}

// Blob parts require a view over a plain ArrayBuffer; Buffer's underlying
// allocation is typed ArrayBufferLike, so wrap explicitly.
function toBlobPart(value: BufferLike): Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  // SAFETY: same ArrayBufferView arm as toBuffer; the view's backing store is
  // the ArrayBuffer the binary IPC payload was cloned over.
  return new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
}

function parseProxyResult<T>(raw: T): ProxyTranscriptionResult {
  const result = proxyTranscriptionResultSchema.safeParse(raw);

  if (!result.success) {
    throw new Error("Provider returned an unexpected response shape");
  }

  return result.data;
}

export function registerTranscriptionExecutionHandlers(
  ipcMain: IpcMainLike,
  deps: TranscriptionExecutionDeps
): void {
  const { logger } = deps;

  // ---- local mic-buffer engines ------------------------------------------------

  ipcMain.handle(
    transcriptionExecutionChannels.transcribeLocalWhisper,
    async (_event, ...args: unknown[]): Promise<TranscriptionResponse> => {
      const audioBlob = args[0];
      const rawOptions = args[1];

      logger.log("transcribe-local-whisper called", {
        audioBlobType: runtimeTypeOf(audioBlob),
        audioBlobSize: hasAudioSize(audioBlob) ? audioBlob.byteLength || audioBlob.length || 0 : 0,
        options: rawOptions,
      });

      try {
        const parsedOptions = whisperOptionsSchema.safeParse(
          rawOptions === undefined ? {} : rawOptions
        );

        if (!parsedOptions.success) {
          return { success: false, error: "Invalid transcription options" };
        }

        // skipVad: dictionary-echo rescue retries decode VAD-free, since VAD
        // stripping the speech is what turned the transcript into prompt echo.
        const { skipVad, ...requestOptions } = parsedOptions.data;

        const vadOptions = skipVad
          ? { vadEnabled: false }
          : deps.resolveWhisperVadOptions("noteRecording");

        const result = await deps.whisperManager.transcribeLocalWhisper(audioBlob, {
          ...requestOptions,
          ...vadOptions,
        });

        logger.log("Whisper result", {
          success: result.success,
          hasText: !!result.text,
          message: result.message,
          error: result.error,
        });

        const parsed = transcriptionResponseSchema.safeParse(result);

        if (!parsed.success) {
          throw new Error("Whisper returned an unexpected result shape");
        }

        return parsed.data;
      } catch (error) {
        logger.error("Local Whisper transcription error", error);
        const errorMessage = messageOf(error) || "Unknown error";

        // Return specific error types for better user feedback
        if (errorMessage.includes("FFmpeg not found")) {
          return {
            success: false,
            error: "ffmpeg_not_found",
            message: "FFmpeg is missing. Please reinstall the app or install FFmpeg manually.",
          };
        }

        if (
          errorMessage.includes("FFmpeg conversion failed") ||
          errorMessage.includes("FFmpeg process error")
        ) {
          return {
            success: false,
            error: "ffmpeg_error",
            message: "Audio conversion failed. The recording may be corrupted.",
          };
        }

        if (
          errorMessage.includes("whisper.cpp not found") ||
          errorMessage.includes("whisper-cpp")
        ) {
          return {
            success: false,
            error: "whisper_not_found",
            message: "Whisper binary is missing. Please reinstall the app.",
          };
        }

        if (
          errorMessage.includes("Audio buffer is empty") ||
          errorMessage.includes("Audio data too small")
        ) {
          return {
            success: false,
            error: "no_audio_data",
            message: "No audio detected",
          };
        }

        if (errorMessage.includes("model") && errorMessage.includes("not downloaded")) {
          return {
            success: false,
            error: "model_not_found",
            message: errorMessage,
          };
        }

        throw error;
      }
    }
  );

  ipcMain.handle(
    transcriptionExecutionChannels.transcribeLocalParakeet,
    async (_event, ...args: unknown[]): Promise<TranscriptionResponse> => {
      const audioBlob = args[0];
      const rawOptions = args[1];

      logger.log("transcribe-local-parakeet called", {
        audioBlobType: runtimeTypeOf(audioBlob),
        audioBlobSize: hasAudioSize(audioBlob) ? audioBlob.byteLength || audioBlob.length || 0 : 0,
        options: rawOptions,
      });

      try {
        const parsedOptions = parakeetOptionsSchema.safeParse(
          rawOptions === undefined ? {} : rawOptions
        );

        if (!parsedOptions.success) {
          return { success: false, error: "Invalid transcription options" };
        }

        const result = await deps.parakeetManager.transcribeLocalParakeet(
          audioBlob,
          parsedOptions.data
        );

        logger.log("Parakeet result", {
          success: result.success,
          hasText: !!result.text,
          message: result.message,
          error: result.error,
        });

        const parsed = transcriptionResponseSchema.safeParse(result);

        if (!parsed.success) {
          throw new Error("Parakeet returned an unexpected result shape");
        }

        return parsed.data;
      } catch (error) {
        logger.error("Local Parakeet transcription error", error);
        const errorMessage = messageOf(error) || "Unknown error";

        if (errorMessage.includes("sherpa-onnx") && errorMessage.includes("not found")) {
          return {
            success: false,
            error: "parakeet_not_found",
            message: "Parakeet binary is missing. Please reinstall the app.",
          };
        }

        if (errorMessage.includes("model") && errorMessage.includes("not downloaded")) {
          return {
            success: false,
            error: "model_not_found",
            message: errorMessage,
          };
        }

        const parakeetCode = codeOf(error);

        if (parakeetCode === PARAKEET_UNSUPPORTED_OS_CODE) {
          return {
            success: false,
            error: parakeetCode,
            message: errorMessage,
          };
        }

        throw error;
      }
    }
  );

  // ---- main-proxied provider transports ----------------------------------------

  ipcMain.handle(
    transcriptionExecutionChannels.proxyXaiTranscription,
    serializeIpcError(async (_event, payload) => {
      const parsed = proxyXaiArgsSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error("Invalid transcription request");
      }

      const { audioBuffer, language, keyterms } = parsed.data;
      const apiKey = deps.environmentManager.getXaiKey();

      if (!apiKey) {
        throw new Error("xAI API key not configured");
      }

      const formData = new FormData();
      const audioBlob = new Blob([toBlobPart(audioBuffer)], { type: "audio/webm" });
      formData.append("file", audioBlob, "audio.webm");

      if (language && language !== "auto" && XAI_STT_LANGUAGES.has(language)) {
        formData.append("language", language);
        formData.append("format", "true");
      }

      if (keyterms && keyterms.length > 0) {
        for (const term of keyterms) {
          formData.append("keyterm", term);
        }
      }

      const response = await deps.proxyFetch(XAI_STT_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`xAI API Error: ${response.status} ${errorText}`);
      }

      return parseProxyResult(await response.json());
    })
  );

  ipcMain.handle(
    transcriptionExecutionChannels.proxyMistralTranscription,
    serializeIpcError(async (_event, payload) => {
      const parsed = proxyMistralArgsSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error("Invalid transcription request");
      }

      const { audioBuffer, model, language, contextBias } = parsed.data;
      const apiKey = deps.environmentManager.getMistralKey();

      if (!apiKey) {
        throw new Error("Mistral API key not configured");
      }

      const formData = new FormData();
      const audioBlob = new Blob([toBlobPart(audioBuffer)], { type: "audio/webm" });
      formData.append("file", audioBlob, "audio.webm");
      formData.append("model", model || "voxtral-mini-latest");

      if (language && language !== "auto") {
        formData.append("language", language);
      }

      if (contextBias && contextBias.length > 0) {
        for (const token of contextBias) {
          formData.append("context_bias", token);
        }
      }

      const response = await deps.proxyFetch(MISTRAL_TRANSCRIPTION_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Mistral API Error: ${response.status} ${errorText}`);
      }

      return parseProxyResult(await response.json());
    })
  );

  ipcMain.handle(
    transcriptionExecutionChannels.proxyCortiTranscription,
    serializeIpcError(async (_event, payload) => {
      const parsed = proxyCortiArgsSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error("Invalid transcription request");
      }

      const { audioBuffer, language, environment, tenant } = parsed.data;
      const clientId = deps.environmentManager.getCortiClientId();
      const clientSecret = deps.environmentManager.getCortiClientSecret();

      if (!clientId || !clientSecret) {
        throw new Error("Corti credentials not configured");
      }

      const result = await deps.transcribeWithCorti({
        environment,
        tenant,
        clientId,
        clientSecret,
        audioBuffer: toBuffer(audioBuffer),
        language,
      });

      return parseProxyResult(result);
    })
  );

  // Enclave attestation is Node-only, so batch transcription is proxied through main.
  ipcMain.handle(
    transcriptionExecutionChannels.proxyTinfoilTranscription,
    serializeIpcError(async (_event, payload) => {
      const parsed = proxyTinfoilArgsSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error("Invalid transcription request");
      }

      const { audioBuffer, language, prompt } = parsed.data;

      const result = await transcribeWithTinfoil({
        audioBuffer: toBuffer(audioBuffer),
        fileName: "audio.webm",
        contentType: "audio/webm",
        language,
        prompt,
        apiKey: deps.environmentManager.getTinfoilKey(),
      });

      return parseProxyResult(result);
    })
  );

  // Gemini's Interactions API takes JSON with inline base64 audio, not
  // OpenAI-compatible multipart, so batch transcription is proxied through main.
  ipcMain.handle(
    transcriptionExecutionChannels.proxyGeminiTranscription,
    serializeIpcError(async (_event, payload) => {
      const parsed = proxyGeminiArgsSchema.safeParse(payload);

      if (!parsed.success) {
        throw new Error("Invalid transcription request");
      }

      const { audioBuffer, model, language, keyterms } = parsed.data;

      const result = await transcribeWithGemini({
        audioBuffer: toBuffer(audioBuffer),
        model: model ?? null,
        contentType: "audio/webm",
        language,
        keyterms,
        apiKey: deps.environmentManager.getGeminiKey(),
      });

      return parseProxyResult(result);
    })
  );

  // ---- voice draft temp audio ----------------------------------------------------

  ipcMain.handle(
    transcriptionExecutionChannels.saveTempAudio,
    async (_event, ...args: unknown[]) => {
      const parsed = binaryLikeSchema.safeParse(args[0]);

      if (!parsed.success) {
        return { success: false as const, error: "Invalid audio data" };
      }

      const tempPath = path.join(
        os.tmpdir(),
        `ow-voice-draft-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.webm`
      );

      fs.writeFileSync(tempPath, toBuffer(parsed.data));

      return { success: true as const, path: tempPath };
    }
  );

  ipcMain.handle(
    transcriptionExecutionChannels.deleteTempAudio,
    async (_event, ...args: unknown[]) => {
      const tempPath = args[0];

      if (!isString(tempPath)) {
        return { success: false, error: "Invalid temp path" };
      }

      // Only files this handler family created are deletable.
      const resolved = path.resolve(tempPath);
      const validPrefix = path.join(os.tmpdir(), "ow-voice-draft-");

      if (!resolved.startsWith(validPrefix)) {
        return { success: false, error: "Invalid temp path" };
      }

      try {
        fs.unlinkSync(resolved);
      } catch {
        // Already gone — fine.
      }

      return { success: true };
    }
  );

  // ---- retry ---------------------------------------------------------------------

  ipcMain.handle(
    transcriptionExecutionChannels.retryTranscription,
    async (_event, ...args: unknown[]): Promise<RetryTranscriptionResult> => {
      const parsedArgs = retryTranscriptionArgsSchema.safeParse({
        id: args[0],
        settings: args[1],
      });

      if (!parsedArgs.success) {
        return { success: false, error: "Invalid retry request" };
      }

      const retryId = parsedArgs.data.id;
      const retrySettings = parsedArgs.data.settings;
      const buffer = deps.audioStorage.getAudioBuffer(retryId);

      if (!buffer) return { success: false, error: "Audio file not found" };

      try {
        let result: { text: string; source?: string; model?: string } | undefined;
        const preferredLanguage = retrySettings?.preferredLanguage;

        const language =
          preferredLanguage && preferredLanguage !== "auto"
            ? preferredLanguage.split("-")[0]
            : undefined;

        // Renderer pre-flight owns policy; retry re-routes stored audio through
        // whatever is selected NOW.
        const route = resolveTranscriptionRoute({
          settings: retrySettings ?? {},
          providers: deps.providerBaseUrls(),
          request: { effectiveLanguage: language },
        });

        // A misconfigured direct route fails closed.
        if (route.transport === "error") {
          const err: Error & { code?: string; messageKey?: string } = new Error(route.message);

          if (route.code) err.code = route.code;

          if (route.messageKey) err.messageKey = route.messageKey;
          throw err;
        }

        if (route.transport === "proxied" && route.provider === "tinfoil") {
          // Attested transport, so this can't reuse the generic fetch below.
          const { text, model } = await transcribeWithTinfoil({
            audioBuffer: buffer,
            fileName: "audio.webm",
            contentType: "audio/webm",
            language: route.language,
            apiKey: deps.environmentManager.getTinfoilKey(),
          });

          if (text) result = { text, source: "tinfoil", model };
        } else if (route.transport === "proxied" && route.provider === "corti") {
          // Corti uses OAuth + an interaction-based REST flow, so it can't use
          // the generic fetch below.
          const clientId = deps.environmentManager.getCortiClientId();
          const clientSecret = deps.environmentManager.getCortiClientSecret();

          if (!clientId || !clientSecret) {
            throw new Error("Corti credentials not configured. Add them in Settings.");
          }

          const { text } = await deps.transcribeWithCorti({
            environment: route.cortiEnvironment,
            tenant: route.cortiTenant,
            clientId,
            clientSecret,
            audioBuffer: buffer,
            language: route.language,
          });

          if (text) result = { text, source: "corti", model: route.model ?? undefined };
        } else if (route.transport === "proxied" && route.provider === "gemini") {
          if (route.sizeCapBytes && buffer.byteLength > route.sizeCapBytes) {
            throw new Error(byokSizeCapError(route.sizeCapBytes));
          }

          const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-gemini-retry-"));

          try {
            const filePath = path.join(tempDir, "recording.webm");
            fs.writeFileSync(filePath, buffer);

            const transcription = await deps.transcribeGeminiFile({
              filePath,
              fileSizeBytes: buffer.byteLength,
              model: route.model || "gemini-3.5-transcribe",
              contentType: "audio/webm",
              apiKey: deps.environmentManager.getGeminiKey(),
              diarize: false,
            });

            if (!transcription.success) {
              throw Object.assign(new Error(transcription.error || "Gemini transcription failed"), {
                code: transcription.code,
              });
            }

            if (transcription.text) {
              result = {
                text: transcription.text,
                source: "gemini",
                model: route.model ?? undefined,
              };
            }
          } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        } else if (route.transport === "proxied" && route.provider === "deepgram") {
          if (buffer.byteLength > route.sizeCapBytes) {
            throw new Error(byokSizeCapError(route.sizeCapBytes));
          }

          const apiKey = deps.environmentManager.getDeepgramKey();

          if (!apiKey) throw new Error("Deepgram API key not configured. Add it in Settings.");

          const response = await deps.proxyFetch(
            deepgramFileUrl(route.model || "nova-3", route.language, false),
            {
              method: "POST",
              headers: { Authorization: `Token ${apiKey}`, "Content-Type": "audio/webm" },
              body: buffer,
            }
          );

          if (!response.ok) {
            throw new Error(`Deepgram API Error: ${response.status} ${await response.text()}`);
          }

          const parsed = parseDeepgramFileResponse(await response.json(), false);

          if (!parsed.success) throw new Error(parsed.error);

          if (parsed.text)
            result = { text: parsed.text, source: "deepgram", model: route.model ?? undefined };
        } else if (route.transport === "proxied" && route.provider === "elevenlabs") {
          if (buffer.byteLength > route.sizeCapBytes) {
            throw new Error(byokSizeCapError(route.sizeCapBytes));
          }

          const apiKey = deps.environmentManager.getElevenLabsKey();

          if (!apiKey) throw new Error("ElevenLabs API key not configured. Add it in Settings.");

          const { body, boundary } = buildMultipartBody(
            buffer,
            "recording.webm",
            "audio/webm",
            elevenLabsFields(route.model || "scribe_v2", route.language, false)
          );

          const response = await deps.proxyFetch(ELEVENLABS_TRANSCRIPTION_URL, {
            method: "POST",
            headers: {
              "xi-api-key": apiKey,
              "Content-Type": `multipart/form-data; boundary=${boundary}`,
            },
            body,
          });

          if (!response.ok) {
            throw new Error(`ElevenLabs API Error: ${response.status} ${await response.text()}`);
          }

          const parsed = parseElevenLabsFileResponse(await response.json(), false);

          if (!parsed.success) throw new Error(parsed.error);

          if (parsed.text)
            result = { text: parsed.text, source: "elevenlabs", model: route.model ?? undefined };
        } else {
          // mistral/xai have no OpenAI-compatible endpoint — main talks to them
          // directly; everything else consumes the route endpoint as-is. Only
          // the proxied mistral/xai and http-batch arms carry these fields; a
          // stale local-mode retry resolves none and fails the same fetch/key
          // way it did before the typed boundary.
          const isDirectProxy =
            route.transport === "proxied" &&
            (route.provider === "mistral" || route.provider === "xai");

          const isHttpBatch = route.transport === "http-batch";
          const provider = isDirectProxy || isHttpBatch ? route.provider : undefined;

          const endpoint = isHttpBatch
            ? route.endpoint
            : provider === "mistral"
              ? MISTRAL_TRANSCRIPTION_URL
              : provider === "xai"
                ? XAI_STT_URL
                : undefined;

          const model = isDirectProxy || isHttpBatch ? route.model : undefined;
          const language = isDirectProxy || isHttpBatch ? route.language : undefined;
          const keyRef = isHttpBatch ? route.auth.keyRef : undefined;
          const scheme = isHttpBatch ? route.auth.scheme : undefined;

          const apiKey =
            provider === "mistral"
              ? deps.environmentManager.getMistralKey()
              : provider === "xai"
                ? deps.environmentManager.getXaiKey()
                : keyRef === "custom"
                  ? deps.environmentManager.getCustomTranscriptionKey()
                  : keyRef === "groq"
                    ? deps.environmentManager.getGroqKey()
                    : deps.environmentManager.getOpenAIKey();

          if (!apiKey && provider !== "custom") {
            throw new Error(`${provider} API key not configured`);
          }

          const formData = new FormData();
          formData.append(
            "file",
            new Blob([toBlobPart(buffer)], { type: "audio/webm" }),
            "audio.webm"
          );

          if (provider === "xai") {
            // xAI STT does not accept a model field; the route pre-filters language
            if (language) {
              formData.append("language", language);
              formData.append("format", "true");
            }
          } else {
            // Preserve the historical runtime value: a null/absent model was
            // passed as undefined and FormData stringified it to "undefined".
            formData.append("model", String(model ?? undefined));

            if (language) formData.append("language", language);
          }

          const headers: Record<string, string> = {};

          if (provider === "mistral") {
            headers["x-api-key"] = apiKey;
          } else if (apiKey) {
            if (scheme === "azure-api-key") {
              headers["api-key"] = apiKey;
            } else {
              headers.Authorization = `Bearer ${apiKey}`;
            }
          }

          const response = await deps.proxyFetch(endpoint ?? "", {
            method: "POST",
            headers,
            body: formData,
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`${provider} API Error: ${response.status} ${errorText}`);
          }

          const data = await response.json();

          if (isProviderTextBody(data) && isString(data.text)) {
            result = { text: data.text, source: provider, model: model ?? undefined };
          }
        }

        if (!result?.text) {
          return { success: false, error: "No transcription engine available" };
        }

        deps.database.updateTranscriptionText(retryId, result.text, result.text);
        deps.database.updateTranscriptionStatus(retryId, "completed");
        const providerName = result.source || "local";
        const modelName = result.model || null;
        const existingRow = deps.database.getTranscriptionById(retryId);
        deps.database.updateTranscriptionAudio(retryId, {
          hasAudio: 1,
          audioDurationMs: existingRow?.audio_duration_ms ?? null,
          provider: providerName,
          model: modelName,
        });
        const updated = deps.database.getTranscriptionById(retryId);

        if (updated) {
          setImmediate(() => {
            deps.broadcast("transcription-updated", updated);
            // A row that just reached "completed" is newly eligible.
          });
        }

        return { success: true, transcription: updated };
      } catch (error) {
        const errorMessage = messageOf(error);
        const code = codeOf(error);

        logger.error(
          "Retry transcription failed",
          { id: retryId, error: errorMessage, code },
          "audio-storage"
        );

        const failure: RetryFailure = { success: false, error: errorMessage };

        if (code) {
          failure.code = code;

          // The historical branch spread the Error's own enumerable fields
          // (messageKey and any provider extras) onto the failure.
          Object.assign(failure, error);

          return failure;
        }

        return failure;
      }
    }
  );

  // ---- provider connection / model discovery ---------------------------------------

  ipcMain.handle(
    transcriptionExecutionChannels.testProviderConnection,
    async (_event, ...args: unknown[]) => {
      const parsed = providerConnectionConfigSchema.safeParse(args[0]);

      if (!parsed.success) {
        return { success: false, error: "Invalid connection test request" };
      }

      const cfg = parsed.data;

      if (cfg.provider === "corti" && cfg.scope === "transcription") {
        try {
          const clientId = String(cfg.clientId || "").trim();
          const clientSecret = String(cfg.clientSecret || "").trim();

          if (clientId && clientSecret) {
            await getCortiToken({
              environment: cfg.environment || "us",
              tenant: String(cfg.tenant || "").trim() || "base",
              clientId,
              clientSecret,
            });
          } else {
            await deps.mintStoredCortiToken({
              environment: cfg.environment,
              tenant: cfg.tenant,
            });
          }

          return { success: true };
        } catch (error) {
          // errorCode is the machine-readable field the renderer maps to i18n;
          // the English string stays for logs/back-compat. Only a response
          // Corti actually sent counts as a rejection (getCortiToken prefixes
          // those); a fetch that never reached it is a network problem, and
          // reporting it as "credentials rejected" sends the user to re-type a
          // key that was never the issue.
          if (errorNameOf(error) === "AbortError") {
            return {
              success: false,
              errorCode: "timeout",
              error: "The connection test timed out.",
            };
          }

          if (!/^(Corti authentication failed|Invalid Corti)/.test(messageOf(error) || "")) {
            return {
              success: false,
              errorCode: "network",
              error: "The provider could not be reached.",
            };
          }

          return {
            success: false,
            errorCode: "credentialsRejected",
            error: "Corti rejected these credentials.",
          };
        }
      }

      return testProviderConnection(cfg);
    }
  );

  ipcMain.handle(
    transcriptionExecutionChannels.testEnterpriseConnection,
    async (_event, ...args: unknown[]): Promise<EnterpriseConnectionResult> => {
      const parsed = enterpriseConnectionArgsSchema.safeParse({
        provider: args[0],
        config: args[1],
      });

      if (!parsed.success) {
        return { success: false, error: "Invalid connection test request" };
      }

      const { provider: enterpriseProvider, config: enterpriseConfig } = parsed.data;
      let runtime: ReturnType<typeof resolveEnterpriseRuntime> | undefined;

      try {
        const resolveModel = (abortSignal?: AbortSignal) =>
          runAbortableOperation(async () => {
            runtime = resolveEnterpriseRuntime(
              enterpriseProvider,
              enterpriseConfig?.model || "test",
              enterpriseConfig
            );
            abortSignal?.throwIfAborted();
            validateEnterpriseEndpoint(runtime.enterprise.azureEndpoint ?? null);

            return deps.getEnterpriseAIModel(
              runtime.provider,
              runtime.model,
              runtime.apiKey,
              runtime.enterprise
            );
          }, abortSignal);

        if (enterpriseProvider === "bedrock") {
          await runBedrockRequest(async () => {
            const abortSignal = AbortSignal.timeout(enterpriseConfig?.timeoutMs || 30_000);
            const model = await resolveModel(abortSignal);

            return deps.generateText({
              model,
              prompt: "Say hello in one word.",
              maxOutputTokens: CONNECTION_TEST_MAX_OUTPUT_TOKENS,
              abortSignal,
              maxRetries: 0,
            });
          });
        } else {
          const model = await resolveModel();
          await deps.generateText({
            model,
            prompt: "Say hello in one word.",
            maxOutputTokens: CONNECTION_TEST_MAX_OUTPUT_TOKENS,
          });
        }

        return { success: true };
      } catch (err) {
        const runtimeConfig =
          runtime?.provider === "bedrock" && runtime.enterprise.bedrockRegion
            ? { ...(enterpriseConfig || {}), bedrockRegion: runtime.enterprise.bedrockRegion }
            : enterpriseConfig;

        const mapped = mapEnterpriseError(enterpriseProvider, err, runtimeConfig ?? {});

        const result: EnterpriseConnectionResult = {
          success: false,
          error: mapped.message,
          messageKey: mapped.messageKey,
          messageParams: mapped.messageParams,
          action: mapped.action,
          actionKey: mapped.actionKey,
          copyCommand: mapped.copyCommand,
          retryable: mapped.retryable,
          technicalDetails: mapped.technicalDetails,
        };

        return result;
      }
    }
  );

  // Lists the text models the account serves in the selected region,
  // resolved to invocable IDs (bare on-demand or geo-scoped profile IDs).
  ipcMain.handle(
    transcriptionExecutionChannels.listBedrockModels,
    async (_event, ...args: unknown[]) => {
      const parsed = enterpriseConnectionArgsSchema.safeParse({
        provider: "bedrock",
        config: args[0] ?? {},
      });

      const bedrockConfig = parsed.success ? (parsed.data.config ?? {}) : {};

      try {
        const runtime = resolveEnterpriseRuntime(
          "bedrock",
          bedrockConfig.model || "test",
          bedrockConfig
        );

        const { BedrockClient, ListFoundationModelsCommand, paginateListInferenceProfiles } =
          await deps.bedrockSdk();

        const region = runtime.enterprise.bedrockRegion || "us-east-1";
        let credentials: BedrockCredentials | null | undefined;

        if (runtime.enterprise.bedrockProfile) {
          credentials = deps.bedrockProfileCredentials(runtime.enterprise.bedrockProfile);
        } else if (
          runtime.enterprise.bedrockAccessKeyId &&
          runtime.enterprise.bedrockSecretAccessKey
        ) {
          credentials = {
            accessKeyId: runtime.enterprise.bedrockAccessKeyId,
            secretAccessKey: runtime.enterprise.bedrockSecretAccessKey,
            sessionToken: runtime.enterprise.bedrockSessionToken || undefined,
          };
        }

        const client = new BedrockClient({ region, ...(credentials ? { credentials } : {}) });

        const [foundationModels, profileSummaries] = await Promise.all([
          client.send(new ListFoundationModelsCommand({ byOutputModality: "TEXT" })),
          (async () => {
            const summaries: BedrockInferenceProfileSummary[] = [];

            const paginator = paginateListInferenceProfiles(
              { client },
              { typeEquals: "SYSTEM_DEFINED" }
            );

            for await (const page of paginator) {
              summaries.push(...(page.inferenceProfileSummaries || []));
            }

            return summaries;
          })(),
        ]);

        return {
          success: true as const,
          models: normalizeBedrockCatalog(foundationModels.modelSummaries, profileSummaries),
        };
      } catch (err) {
        logger.error("Bedrock model listing error:", err);
        const mapped = mapEnterpriseError("bedrock", err, bedrockConfig);

        return { success: false as const, error: mapped.message };
      }
    }
  );

  ipcMain.handle(transcriptionExecutionChannels.getTinfoilChatModels, async () => {
    return getTinfoilChatModels();
  });
}
