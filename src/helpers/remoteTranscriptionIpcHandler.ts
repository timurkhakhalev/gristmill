// The transcribe-audio-file-byok IPC handler, moved out of ipcHandlers.js.
// Owns request validation before any path resolution/read/network call, the
// requestId registration in the shared upload cancel registry (one registry
// per app), AbortSignal propagation into every active transport, and the
// projection of untrusted provider payloads onto the checked wire result.
// Routing stays in transcriptionRoute.ts — this handler re-resolves the route
// as the trust boundary and never falls back to a default endpoint.
import { extname, basename } from "path";
import {
  resolveTranscriptionRoute,
  byokSizeCapError,
  MISTRAL_TRANSCRIPTION_URL,
  XAI_STT_URL,
  type TranscriptionRoute,
} from "./transcriptionRoute.js";
import { timestampRequestFields, mapVerboseSegments } from "./uploadTimestamps.js";
import { formatTimestamp } from "./speakerMerge.js";
import { deepgramFileUrl, parseDeepgramFileResponse } from "./deepgramFileTranscription.js";
import {
  ELEVENLABS_TRANSCRIPTION_URL,
  elevenLabsFields,
  parseElevenLabsFileResponse,
} from "./elevenLabsFileTranscription.js";
import {
  remoteTranscriptionRequestSchema,
  remoteTranscriptionResponseSchema,
  uploadTranscriptionChannels,
  type RemoteTranscriptionRequest,
  type RemoteTranscriptionResult,
} from "../contracts/uploadTranscription.js";
import type { UploadCancelRegistry } from "./uploadCancelRegistry.js";
import type { TranscriptionProviderBaseUrl } from "../services/transcriptionBaseUrl.ts";

// JSON values the providers can return over the wire. Provider payloads are
// validated field-by-field through the guards below before any read.
type ProviderJson = string | number | boolean | null | ProviderJson[] | ProviderJsonObject;

interface ProviderJsonObject {
  [key: string]: ProviderJson;
}

interface AudioMimeTypes {
  [extension: string]: string;
}

const AUDIO_MIME_TYPES: AudioMimeTypes = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  webm: "audio/webm",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  opus: "audio/ogg",
};

function isString<T>(value: T): value is T & string {
  return typeof value === "string";
}

function isNumber<T>(value: T): value is T & number {
  return typeof value === "number";
}

function isProviderObject<T>(value: T): value is T & ProviderJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProviderArray<T>(value: T): value is T & ProviderJson[] {
  return Array.isArray(value);
}

function asRecord<T>(value: T): (T & ProviderJsonObject) | null {
  return isProviderObject(value) ? value : null;
}

function errorName<T>(error: T): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function errorCode<T>(error: T): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;

  const code: unknown = error.code;

  return isString(code) ? code : undefined;
}

function errorMessageKey<T>(error: T): string | undefined {
  if (!(error instanceof Error) || !("messageKey" in error)) return undefined;

  const messageKey: unknown = error.messageKey;

  return isString(messageKey) ? messageKey : undefined;
}

// Which diarization dialect a resolved endpoint speaks, for Custom endpoints
// that front a known provider. Null when the host offers no known dialect.
function diarizationHost(endpoint: string): string | null {
  try {
    const host = new URL(endpoint).hostname;

    if (host === "mistral.ai" || host.endsWith(".mistral.ai")) return "mistral";

    if (host === "openai.com" || host.endsWith(".openai.com")) return "openai";
  } catch {
    // Unreachable for resolved routes (they validated the URL), but staying
    // silent costs nothing.
  }

  return null;
}

interface MultipartFields {
  [name: string]: string | number | boolean | null | undefined;
}

export interface MultipartBody {
  body: Buffer;
  boundary: string;
}

export function buildMultipartBody(
  fileBuffer: Buffer,
  fileName: string,
  contentType: string,
  fields: MultipartFields = {}
): MultipartBody {
  const boundary = `----Gristmill${Date.now()}`;
  const parts: Array<string | Buffer> = [];

  parts.push(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
  );
  parts.push(fileBuffer);
  parts.push("\r\n");

  for (const [name, value] of Object.entries(fields)) {
    if (value != null) {
      parts.push(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
          `${value}\r\n`
      );
    }
  }

  parts.push(`--${boundary}--\r\n`);

  const bodyParts = parts.map((p) => (isString(p) ? Buffer.from(p) : p));

  return { body: Buffer.concat(bodyParts), boundary };
}

export interface PostMultipartResult {
  statusCode: number;
  data: unknown;
}

export interface RemoteTranscriptionDeps {
  resolveAllowedAudioPath: (filePath: string) => string | null;
  readFile: (filePath: string) => Buffer;
  fileSize: (filePath: string) => number;
  providerBaseUrls: () => readonly TranscriptionProviderBaseUrl[];
  postMultipart: (
    url: URL,
    body: Buffer,
    boundary: string,
    headers?: Record<string, string>,
    options?: { signal?: AbortSignal }
  ) => Promise<PostMultipartResult>;
  postRawAudioFile: (
    url: URL,
    filePath: string,
    contentType: string,
    apiKey: string,
    options?: {
      signal?: AbortSignal;
      multipart?: { fileName: string; fields: Record<string, string> };
    }
  ) => Promise<PostMultipartResult>;
  transcribeWithTinfoil: (args: {
    audioBuffer: Buffer;
    fileName: string;
    contentType: string;
    language?: string;
    apiKey: string;
    signal?: AbortSignal;
  }) => Promise<{ text: string }>;
  transcribeGeminiFile: (args: {
    filePath: string;
    fileSizeBytes: number;
    model: string;
    contentType: string;
    diarize: boolean;
    apiKey: string;
    signal?: AbortSignal;
    onRawResponse?: <T>(response: T) => Promise<void>;
  }) => Promise<RemoteTranscriptionResult>;
  transcribeWithCorti: (args: {
    environment?: string;
    tenant?: string;
    clientId: string;
    clientSecret: string;
    audioBuffer: Buffer;
    language?: string;
    signal?: AbortSignal;
  }) => Promise<{ text: string }>;
  getCortiClientId: () => string;
  getCortiClientSecret: () => string;
  getTinfoilKey: () => string;
  getGeminiKey: () => string;
  // The shared registry instance — one per app, never per request.
  uploadCancelRegistry: UploadCancelRegistry;
  logDebug: <T>(message: string, data?: T) => void;
  logWarn: <T>(message: string, data?: T) => void;
  logError: <T>(message: string, data?: T) => void;
}

type IpcMainLike = {
  handle<Result>(channel: string, listener: (...args: unknown[]) => Result): void;
};

function parseResult(raw: PostMultipartResult["data"]): RemoteTranscriptionResult {
  const result = remoteTranscriptionResponseSchema.safeParse(raw);

  if (!result.success) {
    throw new Error("Remote transcription returned an unexpected result shape");
  }

  return result.data;
}

function cancelled(): RemoteTranscriptionResult {
  return { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" };
}

function stringifyScalar(value: ProviderJson | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;

  return isProviderObject(value) || isProviderArray(value) ? undefined : String(value);
}

// Project the providers' diarized payloads (Mistral `speakers`, OpenAI
// `segments`) onto checked wire segments; junk items degrade the way the
// original JS did (falsy ids/labels fall back, timing coerces to 0).
function projectDiarizedSegments(
  items: ProviderJson[],
  label: (item: ProviderJsonObject) => string
): Array<{ speaker: string; text: string; start: number; end: number }> {
  return items.map((item) => {
    const record = asRecord(item) ?? {};
    const start = isNumber(record.start) ? record.start : 0;
    const end = isNumber(record.end) ? record.end : 0;

    return {
      speaker: label(record),
      text: isString(record.text) ? record.text : "",
      start,
      end,
    };
  });
}

function formatDiarizedTranscript(
  segments: Array<{ speaker: string; text: string; start: number; end: number }>
): string {
  return segments
    .map((s) => `[${s.speaker}] ${formatTimestamp(s.start)} - ${formatTimestamp(s.end)}\n${s.text}`)
    .join("\n\n");
}

export function parseOpenAIFileResponse<T>(
  raw: T,
  diarize: boolean,
  timestamps = false
): RemoteTranscriptionResult {
  const response = asRecord(raw);

  if (diarize && isProviderArray(response?.segments)) {
    const segments = projectDiarizedSegments(
      response.segments,
      (item) => stringifyScalar(item.speaker) || "Speaker ?"
    );

    const fallback = response.text;
    const text = segments.length ? formatDiarizedTranscript(segments) : fallback;

    return {
      success: true,
      ...(isString(text) ? { text } : {}),
      diarized: true,
      segments,
    };
  }

  const mappedSegments = timestamps ? mapVerboseSegments(raw) : null;

  return {
    success: true,
    ...(isString(response?.text) ? { text: response.text } : {}),
    ...(mappedSegments ? { segments: mappedSegments } : {}),
  };
}

function errorMessageFromStatus(data: PostMultipartResult, prefix: string): string {
  const error = asRecord(data.data)?.error;
  const nested = asRecord(error)?.message;
  const message = (isString(nested) && nested) || (isString(error) && error) || undefined;

  return message || `${prefix} ${data.statusCode}`;
}

export async function transcribeAudioFileByok(
  deps: RemoteTranscriptionDeps,
  payload: RemoteTranscriptionRequest,
  internal: {
    onRawProviderResponse?: <T>(response: T) => Promise<void>;
    signal?: AbortSignal;
  } = {}
): Promise<RemoteTranscriptionResult> {
  const meetingFailureCode = (code: string) => (internal.onRawProviderResponse ? { code } : {});
  const { signal: registrySignal, release } = deps.uploadCancelRegistry.register(payload.requestId);

  const signal =
    registrySignal && internal.signal
      ? AbortSignal.any([registrySignal, internal.signal])
      : (internal.signal ?? registrySignal);

  try {
    if (signal?.aborted) return cancelled();
    const realByok = deps.resolveAllowedAudioPath(payload.filePath);

    if (!realByok) return { success: false, error: "File path not allowed" };

    const route: TranscriptionRoute = resolveTranscriptionRoute({
      settings: {
        transcriptionMode: payload.transcriptionMode,
        remoteTranscriptionUrl: payload.remoteTranscriptionUrl,
        remoteTranscriptionModel: payload.remoteTranscriptionModel,
        cloudTranscriptionProvider: payload.provider,
        cloudTranscriptionModel: payload.model,
        cloudTranscriptionBaseUrl: payload.baseUrl,
        cortiEnvironment: payload.environment,
        cortiTenant: payload.tenant,
      },
      providers: deps.providerBaseUrls(),
      request: { effectiveLanguage: payload.language || undefined },
    });

    // Fail closed: a misconfigured route must never fall through to a default.
    if (route.transport === "error") {
      return {
        success: false,
        error: route.message,
        code: route.code,
        messageKey: route.messageKey,
      };
    }

    // Local dispatch belongs to the transcribe-audio-file channel; a local
    // route here means a malformed request, and it must not fall through to
    // the generic multipart path below.
    if (route.transport === "local") {
      return { success: false, error: "Invalid transcription request" };
    }

    if (route.transport === "http-batch" && route.provider === "self-hosted") {
      // User's own server, so the 25 MB third-party cap does not apply.
      const ext = extname(realByok).toLowerCase().replace(".", "");

      const { body, boundary } = buildMultipartBody(
        deps.readFile(realByok),
        basename(realByok),
        AUDIO_MIME_TYPES[ext] || "audio/mpeg",
        { model: route.model, language: route.language }
      );

      const data = await deps.postMultipart(
        new URL(route.endpoint),
        body,
        boundary,
        {},
        { signal }
      );

      if (data.statusCode !== 200) {
        throw new Error(errorMessageFromStatus(data, "Self-hosted API Error:"));
      }

      const selfHostedText = asRecord(data.data)?.text;

      return parseResult({
        success: true,
        ...(isString(selfHostedText) ? { text: selfHostedText } : {}),
      });
    }

    const fileSize = deps.fileSize(realByok);

    if (route.sizeCapBytes && fileSize > route.sizeCapBytes) {
      return {
        success: false,
        error: byokSizeCapError(route.sizeCapBytes),
        ...meetingFailureCode("PROVIDER_LIMIT"),
      };
    }

    if (fileSize === 0) {
      return { success: false, error: "Audio file is empty" };
    }

    if (route.transport === "proxied" && route.provider === "deepgram") {
      if (!payload.apiKey) {
        return {
          success: false,
          error: "No Deepgram API key configured. Add your key in Settings.",
          ...meetingFailureCode("API_KEY_MISSING"),
        };
      }

      const ext = extname(realByok).toLowerCase().replace(".", "");

      const data = await deps.postRawAudioFile(
        deepgramFileUrl(
          route.model || "nova-3",
          route.language,
          payload.diarize === true,
          payload.multichannel === true
        ),
        realByok,
        AUDIO_MIME_TYPES[ext] || "application/octet-stream",
        payload.apiKey,
        { signal }
      );

      if (data.statusCode === 401 || data.statusCode === 403) {
        return {
          success: false,
          error: "Invalid Deepgram API key. Check your key in Settings.",
          ...meetingFailureCode("INVALID_KEY"),
        };
      }

      if (data.statusCode === 413) {
        return {
          success: false,
          error: "Deepgram rejected the audio size. Choose another provider.",
          ...meetingFailureCode("PROVIDER_LIMIT"),
        };
      }

      if (data.statusCode === 429) {
        return {
          success: false,
          error: "Deepgram rate limit exceeded. Please try again later.",
          ...meetingFailureCode("PROVIDER_RATE_LIMITED"),
        };
      }

      if (data.statusCode === 504) {
        return {
          success: false,
          error: "Deepgram timed out processing this recording. Retry or choose another provider.",
          ...meetingFailureCode("TRANSCRIPTION_TRANSPORT_ERROR"),
        };
      }

      if (data.statusCode !== 200) {
        return {
          success: false,
          error: errorMessageFromStatus(data, "Deepgram API error:"),
          ...meetingFailureCode(
            data.statusCode >= 500 || data.statusCode === 408
              ? "TRANSCRIPTION_TRANSPORT_ERROR"
              : "DEEPGRAM_API_ERROR"
          ),
        };
      }

      await internal.onRawProviderResponse?.(data.data);

      return parseResult(
        parseDeepgramFileResponse(
          data.data,
          payload.diarize === true,
          payload.multichannel === true
        )
      );
    }

    if (route.transport === "proxied" && route.provider === "elevenlabs") {
      if (!payload.apiKey) {
        return {
          success: false,
          error: "No ElevenLabs API key configured. Add your key in Settings.",
          ...meetingFailureCode("API_KEY_MISSING"),
        };
      }

      const ext = extname(realByok).toLowerCase().replace(".", "");

      const data = await deps.postRawAudioFile(
        ELEVENLABS_TRANSCRIPTION_URL,
        realByok,
        AUDIO_MIME_TYPES[ext] || "application/octet-stream",
        payload.apiKey,
        {
          signal,
          multipart: {
            fileName: basename(realByok),
            fields: elevenLabsFields(
              route.model || "scribe_v2",
              route.language,
              payload.diarize === true
            ),
          },
        }
      );

      if (data.statusCode === 401 || data.statusCode === 403) {
        return {
          success: false,
          error: "Invalid ElevenLabs API key. Check your key in Settings.",
          ...meetingFailureCode("INVALID_KEY"),
        };
      }

      if (data.statusCode === 413) {
        return {
          success: false,
          error: "ElevenLabs rejected the audio size. Choose another provider.",
          ...meetingFailureCode("PROVIDER_LIMIT"),
        };
      }

      if (data.statusCode === 429) {
        return {
          success: false,
          error: "ElevenLabs rate limit exceeded. Please try again later.",
          ...meetingFailureCode("PROVIDER_RATE_LIMITED"),
        };
      }

      if (data.statusCode !== 200) {
        return {
          success: false,
          error: errorMessageFromStatus(data, "ElevenLabs API error:"),
          ...meetingFailureCode(
            data.statusCode >= 500 || data.statusCode === 408
              ? "TRANSCRIPTION_TRANSPORT_ERROR"
              : "ELEVENLABS_API_ERROR"
          ),
        };
      }

      await internal.onRawProviderResponse?.(data.data);

      return parseResult(parseElevenLabsFileResponse(data.data, payload.diarize === true));
    }

    if (route.transport === "proxied" && route.provider === "corti") {
      const clientId = deps.getCortiClientId();
      const clientSecret = deps.getCortiClientSecret();

      if (!clientId || !clientSecret) {
        throw new Error("Corti credentials not configured. Add them in Settings.");
      }

      const { text } = await deps.transcribeWithCorti({
        environment: route.cortiEnvironment,
        tenant: route.cortiTenant,
        clientId,
        clientSecret,
        audioBuffer: deps.readFile(realByok),
        language: route.language,
        signal,
      });

      return parseResult({ success: true, text });
    }

    if (route.transport === "proxied" && route.provider === "tinfoil") {
      const ext = extname(realByok).toLowerCase().replace(".", "");

      const { text } = await deps.transcribeWithTinfoil({
        audioBuffer: deps.readFile(realByok),
        fileName: basename(realByok),
        contentType: AUDIO_MIME_TYPES[ext] || "audio/mpeg",
        language: route.language,
        apiKey: deps.getTinfoilKey(),
        signal,
      });

      return parseResult({ success: true, text });
    }

    if (route.transport === "proxied" && route.provider === "gemini") {
      const ext = extname(realByok).toLowerCase().replace(".", "");

      return parseResult(
        await deps.transcribeGeminiFile({
          filePath: realByok,
          fileSizeBytes: fileSize,
          model: route.model || "gemini-3.5-transcribe",
          contentType: AUDIO_MIME_TYPES[ext] || "audio/mpeg",
          diarize: payload.diarize === true,
          apiKey: payload.apiKey || deps.getGeminiKey(),
          signal,
          onRawResponse: internal.onRawProviderResponse,
        })
      );
    }

    const apiKey = payload.apiKey;

    if (!apiKey && route.provider !== "custom") {
      throw new Error("No API key configured. Add your key in Settings.");
    }

    const audioBuffer = deps.readFile(realByok);
    const ext = extname(realByok).toLowerCase().replace(".", "");
    const contentType = AUDIO_MIME_TYPES[ext] || "audio/mpeg";
    const fileName = basename(realByok);
    const batchEndpoint = route.transport === "http-batch" ? route.endpoint : "";

    // mistral/xai have no OpenAI-compatible endpoint — talk to them
    // directly; everything else consumes the route endpoint as-is.
    let transcriptionUrl: string;
    const multipartFields: MultipartFields = {};

    if (route.provider === "xai") {
      transcriptionUrl = XAI_STT_URL;

      // xAI STT accepts no model field; the route pre-filters language
      if (route.language) {
        multipartFields.language = route.language;
        multipartFields.format = "true";
      }
    } else {
      transcriptionUrl = route.provider === "mistral" ? MISTRAL_TRANSCRIPTION_URL : batchEndpoint;
      multipartFields.model = route.model;
      // No language field: an uploaded file may use a different language, and
      // a wrong hint silently mistranscribes it. Providers that require one
      // (Corti) are handled on their own branch above.
    }

    const diarize = payload.diarize === true;

    if (diarize) {
      // A Custom endpoint may front OpenAI or Mistral, so fall back to the
      // resolved host before giving up on speaker labels.
      const diarizeTarget =
        route.provider === "custom" ? diarizationHost(batchEndpoint) : route.provider;

      if (diarizeTarget === "mistral") {
        multipartFields.diarize = "true";
        multipartFields.timestamp_granularities = "segment";
      } else if (diarizeTarget === "openai") {
        multipartFields.model = "gpt-4o-transcribe-diarize";
        // Speaker annotations require diarized_json; verbose_json is not supported by this model.
        multipartFields.response_format = "diarized_json";
        multipartFields.chunking_strategy = "auto";
      } else {
        // Degrade to a plain transcript, never fail the upload.
        deps.logWarn(
          "BYOK diarization requested but provider is not OpenAI/Mistral; transcribing without speakers",
          { provider: route.provider }
        );
      }
    } else if (payload.timestamps === true) {
      // Providers/models that don't support the request keep the
      // plain-text request untouched (helper returns null).
      const fields = timestampRequestFields(route.provider, route.model ?? null);

      if (fields) Object.assign(multipartFields, fields);
    }

    const { body, boundary } = buildMultipartBody(
      audioBuffer,
      fileName,
      contentType,
      multipartFields
    );

    const url = new URL(transcriptionUrl);

    // Mistral authenticates with x-api-key, not Bearer.
    const headers: Record<string, string> | undefined = apiKey
      ? route.provider === "mistral"
        ? { "x-api-key": apiKey }
        : route.transport === "http-batch" && route.auth.scheme === "azure-api-key"
          ? { "api-key": apiKey }
          : { Authorization: `Bearer ${apiKey}` }
      : undefined;

    const data = await deps.postMultipart(url, body, boundary, headers, { signal });

    if (data.statusCode === 401) {
      return { success: false, error: "Invalid API key. Check your key in Settings." };
    }

    if (data.statusCode === 429) {
      return { success: false, error: "Rate limit exceeded. Please try again later." };
    }

    if (data.statusCode !== 200) {
      throw new Error(errorMessageFromStatus(data, "API error:"));
    }

    await internal.onRawProviderResponse?.(data.data);

    if (route.provider === "openai") {
      return parseResult(parseOpenAIFileResponse(data.data, diarize, payload.timestamps === true));
    }

    const payloadRecord = asRecord(data.data);

    if (diarize && isProviderArray(payloadRecord?.speakers)) {
      const segments = projectDiarizedSegments(
        payloadRecord.speakers,
        (item) => stringifyScalar(item.id) || `Speaker ${stringifyScalar(item.speaker) || "?"}`
      );

      return parseResult({
        success: true,
        text: formatDiarizedTranscript(segments),
        diarized: true,
        segments,
      });
    }

    if (diarize) {
      deps.logWarn("BYOK diarization requested but provider returned no speaker data");
    }

    const segments = payload.timestamps === true ? mapVerboseSegments(data.data) : null;
    const text = payloadRecord?.text;

    return parseResult({
      success: true,
      ...(isString(text) ? { text } : {}),
      ...(segments ? { segments } : {}),
    });
  } catch (error) {
    if (errorName(error) === "AbortError" || signal?.aborted) {
      deps.logDebug("BYOK audio file transcription cancelled", { requestId: payload.requestId });

      return cancelled();
    }

    const message = error instanceof Error ? error.message : String(error);
    const code = errorCode(error);
    const messageKey = errorMessageKey(error);

    deps.logError("BYOK audio file transcription error", { error: message });

    return {
      success: false,
      error: message,
      ...(internal.onRawProviderResponse
        ? {
            code:
              code ||
              (errorName(error) === "TypeError"
                ? "TRANSCRIPTION_TRANSPORT_ERROR"
                : "TRANSCRIPTION_ERROR"),
          }
        : code
          ? { code }
          : {}),
      ...(messageKey ? { messageKey } : {}),
    };
  } finally {
    release();
  }
}

export function registerRemoteTranscriptionHandler(
  ipcMain: IpcMainLike,
  deps: RemoteTranscriptionDeps
): void {
  ipcMain.handle(
    uploadTranscriptionChannels.transcribeAudioFileByok,
    async (_event, ...args: unknown[]) => {
      // Invalid payloads are rejected before any path resolution, read or
      // network call; a non-string filePath keeps the historical message.
      const parsed = remoteTranscriptionRequestSchema.safeParse(args[0]);

      if (!parsed.success) {
        const filePath = asRecord(args[0])?.filePath;

        return {
          success: false,
          error: isString(filePath) ? "Invalid transcription request" : "Invalid file path",
        };
      }

      return transcribeAudioFileByok(deps, parsed.data);
    }
  );
}
