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
import { resolveEnterpriseRuntime } from "./reasoningIpcHandlers.js";
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
import type { TranscriptionRow } from "./database.js";

type IpcEventListener = (event: unknown, ...args: unknown[]) => void;

// Azure Responses rejects probes with fewer than 16 output tokens. The probe
// only needs one word, but this is the provider's minimum accepted value.
const CONNECTION_TEST_MAX_OUTPUT_TOKENS = 16;

export interface Logger {
  log: (message: string, data?: unknown) => void;
  debug: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown, tag?: string) => void;
}

export interface TranscriptionExecutionDeps {
  whisperManager: {
    transcribeLocalWhisper: (audioBlob: unknown, options: unknown) => Promise<unknown>;
  };
  parakeetManager: {
    transcribeLocalParakeet: (audioBlob: unknown, options: unknown) => Promise<unknown>;
  };
  resolveWhisperVadOptions: (context: string) => Record<string, unknown>;
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
  // owned by the composition root like the postMultipart transport.
  proxyFetch: (
    url: string | URL,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
    }
  ) => Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
    json: () => Promise<unknown>;
  }>;
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
  mintStoredCortiToken: (options: { environment?: string; tenant?: string }) => Promise<unknown>;
  // Lazy `ai` SDK entry point — keeps startup free of the SDK.
  generateText: (options: Record<string, unknown>) => Promise<unknown>;
  // Lazy enterprise model factory from enterpriseAiProviders.
  getEnterpriseAIModel: (
    provider: string,
    model: string,
    apiKey: string,
    enterprise: Record<string, unknown>
  ) => unknown;
  // Lazy AWS SDK surfaces — heavy dependencies, loaded on first use only.
  bedrockSdk: () => Promise<{
    BedrockClient: new (config: { region: string; credentials?: unknown }) => {
      send: (command: unknown) => Promise<{ modelSummaries?: unknown }>;
    };
    ListFoundationModelsCommand: new (args: { byOutputModality: string }) => unknown;
    paginateListInferenceProfiles: (
      config: { client: unknown },
      args: { typeEquals: string }
    ) => AsyncIterable<{ inferenceProfileSummaries?: unknown[] }>;
  }>;
  bedrockProfileCredentials: (profile: string) => unknown;
  providerBaseUrls: () => readonly TranscriptionProviderBaseUrl[];
  audioStorage: {
    getAudioBuffer: (id: number) => Buffer | null;
  };
  database: {
    updateTranscriptionText: (id: number, text: string, rawText: string | null) => unknown;
    updateTranscriptionStatus: (id: number, status: string) => unknown;
    updateTranscriptionAudio: (
      id: number,
      update: {
        hasAudio: number;
        audioDurationMs: number | null;
        provider: string | null;
        model: string | null;
      }
    ) => unknown;
    getTranscriptionById: (id: number) => (TranscriptionRow & Record<string, unknown>) | null;
  };
  broadcast: (channel: string, payload: unknown) => void;
  logger: Logger;
}

// ipcMain.handle keeps only the message when a promise rejects, dropping custom
// props — proxy handlers return {error, code, messageKey} so the renderer can
// rebuild the error.
function serializeIpcError(fn: (event: unknown, payload: unknown) => Promise<unknown>) {
  return async (event: unknown, payload: unknown): Promise<unknown> => {
    try {
      return await fn(event, payload);
    } catch (error) {
      const err = error as { message?: string; code?: string; messageKey?: string };

      return { error: err?.message, code: err?.code, messageKey: err?.messageKey };
    }
  };
}

function toBuffer(value: BufferLike): Buffer {
  if (value instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(value));
  }

  return Buffer.from(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
}

// Blob parts require a view over a plain ArrayBuffer; Buffer's underlying
// allocation is typed ArrayBufferLike, so wrap explicitly.
function toBlobPart(value: BufferLike): Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  return new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
}

function parseProxyResult(raw: unknown): ProxyTranscriptionResult {
  const result = proxyTranscriptionResultSchema.safeParse(raw);

  if (!result.success) {
    throw new Error("Provider returned an unexpected response shape");
  }

  return result.data;
}

export function registerTranscriptionExecutionHandlers(
  ipcMain: { handle(channel: string, listener: IpcEventListener): void },
  deps: TranscriptionExecutionDeps
): void {
  const { logger } = deps;

  // ---- local mic-buffer engines ------------------------------------------------

  ipcMain.handle(
    transcriptionExecutionChannels.transcribeLocalWhisper,
    async (_event, audioBlob: unknown, rawOptions: unknown): Promise<TranscriptionResponse> => {
      logger.log("transcribe-local-whisper called", {
        audioBlobType: typeof audioBlob,
        audioBlobSize:
          (audioBlob as { byteLength?: number })?.byteLength ||
          (audioBlob as { length?: number })?.length ||
          0,
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
          success: (result as { success?: boolean })?.success,
          hasText: !!(result as { text?: string })?.text,
          message: (result as { message?: string })?.message,
          error: (result as { error?: string })?.error,
        });

        const parsed = transcriptionResponseSchema.safeParse(result);

        if (!parsed.success) {
          throw new Error("Whisper returned an unexpected result shape");
        }

        return parsed.data;
      } catch (error) {
        logger.error("Local Whisper transcription error", error);
        const errorMessage = (error as Error)?.message || "Unknown error";

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
    async (_event, audioBlob: unknown, rawOptions: unknown): Promise<TranscriptionResponse> => {
      logger.log("transcribe-local-parakeet called", {
        audioBlobType: typeof audioBlob,
        audioBlobSize:
          (audioBlob as { byteLength?: number })?.byteLength ||
          (audioBlob as { length?: number })?.length ||
          0,
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
          success: (result as { success?: boolean })?.success,
          hasText: !!(result as { text?: string })?.text,
          message: (result as { message?: string })?.message,
          error: (result as { error?: string })?.error,
        });

        const parsed = transcriptionResponseSchema.safeParse(result);

        if (!parsed.success) {
          throw new Error("Parakeet returned an unexpected result shape");
        }

        return parsed.data;
      } catch (error) {
        logger.error("Local Parakeet transcription error", error);
        const errorMessage = (error as Error)?.message || "Unknown error";

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

        if ((error as { code?: string })?.code === PARAKEET_UNSUPPORTED_OS_CODE) {
          return {
            success: false,
            error: (error as { code?: string }).code,
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

  ipcMain.handle(transcriptionExecutionChannels.saveTempAudio, async (_event, buffer: unknown) => {
    const parsed = binaryLikeSchema.safeParse(buffer);

    if (!parsed.success) {
      return { success: false as const, error: "Invalid audio data" };
    }

    const tempPath = path.join(
      os.tmpdir(),
      `ow-voice-draft-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.webm`
    );

    fs.writeFileSync(tempPath, toBuffer(parsed.data));

    return { success: true as const, path: tempPath };
  });

  ipcMain.handle(
    transcriptionExecutionChannels.deleteTempAudio,
    async (_event, tempPath: unknown) => {
      if (typeof tempPath !== "string") {
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
    async (_event, id: unknown, settings: unknown): Promise<RetryTranscriptionResult> => {
      const parsedArgs = retryTranscriptionArgsSchema.safeParse({ id, settings });

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
          // directly; everything else consumes the route endpoint as-is. The
          // loose shape keeps the historical behavior for transports that do
          // not carry these fields (a stale local-mode retry fails the same
          // fetch/key way it did before the typed boundary).
          const loose = route as {
            provider?: "mistral" | "xai" | "self-hosted" | "custom" | "openai" | "groq";
            endpoint?: string;
            model?: string | null;
            language?: string;
            auth?: { scheme?: string; keyRef?: string | null };
          };

          const provider = loose.provider;

          const endpoint =
            provider === "mistral"
              ? MISTRAL_TRANSCRIPTION_URL
              : provider === "xai"
                ? XAI_STT_URL
                : loose.endpoint;

          const apiKey =
            provider === "mistral"
              ? deps.environmentManager.getMistralKey()
              : provider === "xai"
                ? deps.environmentManager.getXaiKey()
                : loose.auth?.keyRef === "custom"
                  ? deps.environmentManager.getCustomTranscriptionKey()
                  : loose.auth?.keyRef === "groq"
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
            if (loose.language) {
              formData.append("language", loose.language);
              formData.append("format", "true");
            }
          } else {
            formData.append("model", (loose.model ?? undefined) as string);

            if (loose.language) formData.append("language", loose.language);
          }

          const headers: Record<string, string> = {};

          if (provider === "mistral") {
            headers["x-api-key"] = apiKey;
          } else if (apiKey) {
            if (loose.auth?.scheme === "azure-api-key") {
              headers["api-key"] = apiKey;
            } else {
              headers.Authorization = `Bearer ${apiKey}`;
            }
          }

          const response = await deps.proxyFetch(endpoint ?? ("" as string), {
            method: "POST",
            headers,
            body: formData,
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`${provider} API Error: ${response.status} ${errorText}`);
          }

          const data = (await response.json()) as { text?: string };

          if (data?.text) {
            result = { text: data.text, source: provider, model: loose.model ?? undefined };
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
        const err = error as Error & { code?: string; messageKey?: string };
        logger.error(
          "Retry transcription failed",
          { id: retryId, error: err?.message, code: err?.code },
          "audio-storage"
        );

        if (err?.code) {
          return { success: false, error: err?.message, code: err.code, ...err };
        }

        return { success: false, error: err?.message };
      }
    }
  );

  // ---- provider connection / model discovery ---------------------------------------

  ipcMain.handle(
    transcriptionExecutionChannels.testProviderConnection,
    async (_event, config: unknown) => {
      const parsed = providerConnectionConfigSchema.safeParse(config);

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
          if ((error as Error)?.name === "AbortError") {
            return {
              success: false,
              errorCode: "timeout",
              error: "The connection test timed out.",
            };
          }

          if (
            !/^(Corti authentication failed|Invalid Corti)/.test((error as Error)?.message || "")
          ) {
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
    async (_event, provider: unknown, config: unknown): Promise<EnterpriseConnectionResult> => {
      const parsed = enterpriseConnectionArgsSchema.safeParse({ provider, config });

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
  ipcMain.handle(transcriptionExecutionChannels.listBedrockModels, async (_event, config) => {
    const parsed = enterpriseConnectionArgsSchema.safeParse({
      provider: "bedrock",
      config: config ?? {},
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
      let credentials: unknown;

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
          const summaries: unknown[] = [];

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
        models: normalizeBedrockCatalog(
          foundationModels.modelSummaries as never,
          profileSummaries as never
        ),
      };
    } catch (err) {
      logger.error("Bedrock model listing error:", err);
      const mapped = mapEnterpriseError("bedrock", err, bedrockConfig);

      return { success: false as const, error: mapped.message };
    }
  });

  ipcMain.handle(transcriptionExecutionChannels.getTinfoilChatModels, async () => {
    return getTinfoilChatModels();
  });
}
