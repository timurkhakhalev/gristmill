// Single source of truth for the transcription *execution* boundary: the
// mic-buffer local engines, the main-proxied provider transports, retry of a
// stored transcription, voice-draft temp audio, and provider connection/model
// discovery. Channel names, argument order, results and errors are unchanged
// from the previous JS registrations. Reuses the local file transcription
// response schemas — the same manager result shapes cross this boundary.
import { z } from "zod";
import {
  transcriptionOptionsSchema,
  transcriptionResponseSchema,
} from "./localFileTranscription.js";
import { transcriptionItemSchema } from "./transcriptionData.js";

export type TranscriptionResponse = z.infer<typeof transcriptionResponseSchema>;

export { transcriptionResponseSchema };

export type BufferLike = ArrayBuffer | ArrayBufferView;

// Binary payloads (voice drafts) cross structured clone as ArrayBuffer or a
// typed array; Buffer arrives as Uint8Array.
export const binaryLikeSchema = z.custom<BufferLike>(
  (value) => value instanceof ArrayBuffer || ArrayBuffer.isView(value),
  { message: "Expected binary audio data" }
);

// skipVad: dictionary-echo rescue retries decode VAD-free. Unknown extension
// fields must survive to the managers (they read e.g. skipDecoderThresholds).
export const whisperOptionsSchema = transcriptionOptionsSchema
  .extend({
    skipVad: z.boolean().optional(),
  })
  .passthrough();

export type WhisperOptions = z.infer<typeof whisperOptionsSchema>;

export const parakeetOptionsSchema = transcriptionOptionsSchema;

export type ParakeetOptions = z.infer<typeof parakeetOptionsSchema>;

// ---- main-proxied provider transports --------------------------------------

const binaryArg = z.custom<BufferLike>(
  (value) => value instanceof ArrayBuffer || ArrayBuffer.isView(value),
  { message: "Expected binary audio data" }
);

export const proxyXaiArgsSchema = z.object({
  audioBuffer: binaryArg,
  language: z.string().optional(),
  keyterms: z.array(z.string()).optional(),
});

export const proxyMistralArgsSchema = z.object({
  audioBuffer: binaryArg,
  model: z.string().optional(),
  language: z.string().optional(),
  contextBias: z.array(z.string()).optional(),
});

export const proxyCortiArgsSchema = z.object({
  audioBuffer: binaryArg,
  language: z.string().optional(),
  environment: z.string().optional(),
  tenant: z.string().optional(),
});

export const proxyTinfoilArgsSchema = z.object({
  audioBuffer: binaryArg,
  language: z.string().optional(),
  prompt: z.string().optional(),
});

export const proxyGeminiArgsSchema = z.object({
  audioBuffer: binaryArg,
  model: z.string().optional(),
  language: z.string().optional(),
  keyterms: z.array(z.string()).optional(),
});

// ipcMain.handle keeps only the message when a promise rejects, dropping
// custom props — the proxy handlers resolve with a serialized error instead
// ({error, code, messageKey}) so the renderer can rebuild it.
export const proxyTranscriptionResultSchema = z
  .object({
    text: z.string().optional(),
    model: z.string().optional(),
    error: z.string().optional(),
    code: z.string().optional(),
    messageKey: z.string().optional(),
  })
  .passthrough()
  .refine((value) => value.text !== undefined || value.error !== undefined, {
    message: "Proxy transcription returned neither text nor a serialized error",
  });

export type ProxyTranscriptionResult = z.infer<typeof proxyTranscriptionResultSchema>;

// ---- voice draft temp audio -------------------------------------------------

export const saveTempAudioResultSchema = z.object({
  success: z.literal(true),
  path: z.string(),
});

export const deleteTempAudioResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

// ---- retry ------------------------------------------------------------------

// The route resolver reads exactly these fields; extra payload keys were never
// read by the retry path, so they are dropped at the boundary.
export const retryTranscriptionSettingsSchema = z.object({
  transcriptionMode: z.string().optional(),
  useLocalWhisper: z.boolean().optional(),
  remoteTranscriptionUrl: z.string().optional(),
  remoteTranscriptionModel: z.string().optional(),
  cloudTranscriptionProvider: z.string().optional(),
  cloudTranscriptionModel: z.string().optional(),
  cloudTranscriptionBaseUrl: z.string().optional(),
  cortiEnvironment: z.string().optional(),
  cortiTenant: z.string().optional(),
  preferredLanguage: z.string().optional(),
});

export type RetryTranscriptionSettings = z.infer<typeof retryTranscriptionSettingsSchema>;

export const retryTranscriptionArgsSchema = z.object({
  id: z.number().int(),
  settings: retryTranscriptionSettingsSchema.optional(),
});

export type RetryTranscriptionArgs = z.infer<typeof retryTranscriptionArgsSchema>;

export const retryTranscriptionResultSchema = z.union([
  z.object({
    success: z.literal(true),
    transcription: transcriptionItemSchema.nullable(),
  }),
  z
    .object({
      success: z.literal(false),
      error: z.string().optional(),
      code: z.string().optional(),
      messageKey: z.string().optional(),
    })
    .passthrough(),
]);

export type RetryTranscriptionResult = z.infer<typeof retryTranscriptionResultSchema>;

// ---- provider connection / model discovery ----------------------------------

export const providerConnectionConfigSchema = z
  .object({
    scope: z.string().optional(),
    provider: z.string().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    environment: z.string().optional(),
    tenant: z.string().optional(),
  })
  .passthrough();

export type ProviderConnectionConfig = z.infer<typeof providerConnectionConfigSchema>;

export const providerConnectionResultSchema = z
  .object({
    success: z.boolean(),
    error: z.string().optional(),
    errorCode: z.string().optional(),
    status: z.number().optional(),
  })
  .passthrough();

export type ProviderConnectionResult = z.infer<typeof providerConnectionResultSchema>;

export const enterpriseConnectionArgsSchema = z.object({
  provider: z.string(),
  config: z
    .object({
      model: z.string().optional(),
      timeoutMs: z.number().optional(),
    })
    .passthrough()
    .optional(),
});

export type EnterpriseConnectionArgs = z.infer<typeof enterpriseConnectionArgsSchema>;

export const enterpriseConnectionResultSchema = z
  .object({
    success: z.boolean(),
    error: z.string().optional(),
    messageKey: z.string().optional(),
    messageParams: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    action: z.string().optional(),
    actionKey: z.string().optional(),
    copyCommand: z.string().optional(),
    retryable: z.boolean().optional(),
    technicalDetails: z.unknown().optional(),
  })
  .passthrough();

export type EnterpriseConnectionResult = z.infer<typeof enterpriseConnectionResultSchema>;

export const bedrockModelsConfigSchema = z
  .object({
    model: z.string().optional(),
  })
  .passthrough()
  .optional();

export const bedrockModelsResultSchema = z.object({
  success: z.boolean(),
  models: z
    .array(
      z.object({
        value: z.string(),
        label: z.string(),
        vendor: z.string(),
      })
    )
    .optional(),
  error: z.string().optional(),
});

export type BedrockModelsResult = z.infer<typeof bedrockModelsResultSchema>;

export const tinfoilChatModelsResultSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    supportsThinking: z.boolean(),
  })
);

// ---- channels ----------------------------------------------------------------

export const transcriptionExecutionChannels = {
  transcribeLocalWhisper: "transcribe-local-whisper",
  transcribeLocalParakeet: "transcribe-local-parakeet",
  proxyXaiTranscription: "proxy-xai-transcription",
  proxyMistralTranscription: "proxy-mistral-transcription",
  proxyCortiTranscription: "proxy-corti-transcription",
  proxyTinfoilTranscription: "proxy-tinfoil-transcription",
  proxyGeminiTranscription: "proxy-gemini-transcription",
  saveTempAudio: "save-temp-audio",
  deleteTempAudio: "delete-temp-audio",
  retryTranscription: "retry-transcription",
  testProviderConnection: "test-provider-connection",
  testEnterpriseConnection: "test-enterprise-connection",
  listBedrockModels: "bedrock-list-models",
  getTinfoilChatModels: "get-tinfoil-chat-models",
} as const;

// ---- renderer-facing surface ---------------------------------------------------

export interface TranscriptionExecutionApi {
  transcribeLocalWhisper(
    audioBlob: ArrayBuffer,
    options?: {
      provider?: string;
      model?: string;
      language?: string;
      requestId?: string;
      skipVad?: boolean;
      [key: string]: unknown;
    }
  ): Promise<TranscriptionResponse>;
  transcribeLocalParakeet(
    audioBlob: ArrayBuffer,
    options?: {
      model?: string;
      language?: string;
      [key: string]: unknown;
    }
  ): Promise<TranscriptionResponse>;
  proxyXaiTranscription?(data: {
    audioBuffer: ArrayBuffer;
    language?: string;
    keyterms?: string[];
  }): Promise<ProxyTranscriptionResult>;
  proxyMistralTranscription(data: {
    audioBuffer: ArrayBuffer;
    model?: string;
    language?: string;
    contextBias?: string[];
  }): Promise<ProxyTranscriptionResult>;
  proxyCortiTranscription?(data: {
    audioBuffer: ArrayBuffer;
    language: string;
    environment: string;
    tenant: string;
  }): Promise<ProxyTranscriptionResult>;
  proxyTinfoilTranscription?(data: {
    audioBuffer: ArrayBuffer;
    language?: string;
    prompt?: string;
  }): Promise<ProxyTranscriptionResult>;
  proxyGeminiTranscription?(data: {
    audioBuffer: ArrayBuffer;
    model?: string;
    language?: string;
    keyterms?: string[];
  }): Promise<ProxyTranscriptionResult>;
  saveTempAudio(buffer: ArrayBuffer): Promise<{ success: true; path: string }>;
  deleteTempAudio(tempPath: string): Promise<{ success: boolean; error?: string }>;
  retryTranscription(
    id: number,
    settings?: {
      useLocalWhisper: boolean;
      localTranscriptionProvider: string;
      cloudTranscriptionMode: string;
      cloudTranscriptionProvider: string;
      cloudTranscriptionModel: string;
      cloudTranscriptionBaseUrl?: string;
      cortiEnvironment?: string;
      cortiTenant?: string;
      parakeetModel: string;
      cohereModel: string;
      whisperModel: string;
      preferredLanguage?: string;
      transcriptionMode?: string;
      remoteTranscriptionType?: string;
      remoteTranscriptionUrl?: string;
      remoteTranscriptionModel?: string;
    }
  ): Promise<RetryTranscriptionResult>;
  testProviderConnection?(config: {
    scope: "transcription" | "reasoning";
    provider: string;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    clientId?: string;
    clientSecret?: string;
    environment?: string;
    tenant?: string;
  }): Promise<ProviderConnectionResult>;
  testEnterpriseConnection?(
    provider: string,
    config: Record<string, unknown>
  ): Promise<EnterpriseConnectionResult>;
  listBedrockModels?(config: Record<string, unknown>): Promise<BedrockModelsResult>;
  getTinfoilChatModels?(): Promise<
    Array<{ id: string; name: string; description: string; supportsThinking: boolean }>
  >;
}
