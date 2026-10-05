// Renderer-facing transcription execution bridge. Moved out of preload.js so
// the fourteen operations have one typed implementation backed by the shared
// contract. Results are validated before they reach the renderer; a malformed
// result surfaces as a rejected invoke instead of a junk payload. The
// sandboxed preload can't require local modules, so build-main.js bundles the
// final preload with esbuild before packaging.
import {
  transcriptionExecutionChannels,
  proxyTranscriptionResultSchema,
  retryTranscriptionResultSchema,
  deleteTempAudioResultSchema,
  saveTempAudioResultSchema,
  transcriptionResponseSchema,
  providerConnectionResultSchema,
  enterpriseConnectionResultSchema,
  bedrockModelsResultSchema,
  tinfoilChatModelsResultSchema,
  type TranscriptionExecutionApi,
  type ProxyTranscriptionResult,
  type RetryTranscriptionResult,
  type TranscriptionResponse,
} from "../contracts/transcriptionExecution.js";
import type { ZodType } from "zod";

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

function parseResult<T>(schema: ZodType<T>, raw: unknown, channel: string): T {
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw new Error(`Unexpected response shape from ${channel}`);
  }

  return result.data;
}

// The return type is the shared TranscriptionExecutionApi, so any drift
// between this implementation and the contract fails compilation.
export function createTranscriptionExecutionBridge(
  ipcRenderer: IpcRendererLike
): TranscriptionExecutionApi {
  const invokeParse = <T>(schema: ZodType<T>, channel: string, ...args: unknown[]): Promise<T> =>
    ipcRenderer.invoke(channel, ...args).then((raw) => parseResult(schema, raw, channel));

  return {
    transcribeLocalWhisper: (audioBlob, options?) =>
      invokeParse(
        transcriptionResponseSchema,
        transcriptionExecutionChannels.transcribeLocalWhisper,
        audioBlob,
        options
      ) as Promise<TranscriptionResponse>,
    transcribeLocalParakeet: (audioBlob, options?) =>
      invokeParse(
        transcriptionResponseSchema,
        transcriptionExecutionChannels.transcribeLocalParakeet,
        audioBlob,
        options
      ) as Promise<TranscriptionResponse>,
    proxyXaiTranscription: (data) =>
      invokeParse(
        proxyTranscriptionResultSchema,
        transcriptionExecutionChannels.proxyXaiTranscription,
        data
      ) as Promise<ProxyTranscriptionResult>,
    proxyMistralTranscription: (data) =>
      invokeParse(
        proxyTranscriptionResultSchema,
        transcriptionExecutionChannels.proxyMistralTranscription,
        data
      ) as Promise<ProxyTranscriptionResult>,
    proxyCortiTranscription: (data) =>
      invokeParse(
        proxyTranscriptionResultSchema,
        transcriptionExecutionChannels.proxyCortiTranscription,
        data
      ) as Promise<ProxyTranscriptionResult>,
    proxyTinfoilTranscription: (data) =>
      invokeParse(
        proxyTranscriptionResultSchema,
        transcriptionExecutionChannels.proxyTinfoilTranscription,
        data
      ) as Promise<ProxyTranscriptionResult>,
    proxyGeminiTranscription: (data) =>
      invokeParse(
        proxyTranscriptionResultSchema,
        transcriptionExecutionChannels.proxyGeminiTranscription,
        data
      ) as Promise<ProxyTranscriptionResult>,
    saveTempAudio: (buffer) =>
      invokeParse(saveTempAudioResultSchema, transcriptionExecutionChannels.saveTempAudio, buffer),
    deleteTempAudio: (tempPath) =>
      invokeParse(
        deleteTempAudioResultSchema,
        transcriptionExecutionChannels.deleteTempAudio,
        tempPath
      ),
    retryTranscription: (id, settings) =>
      invokeParse(
        retryTranscriptionResultSchema,
        transcriptionExecutionChannels.retryTranscription,
        id,
        settings
      ) as Promise<RetryTranscriptionResult>,
    testProviderConnection: (config) =>
      invokeParse(
        providerConnectionResultSchema,
        transcriptionExecutionChannels.testProviderConnection,
        config
      ),
    testEnterpriseConnection: (provider, config) =>
      invokeParse(
        enterpriseConnectionResultSchema,
        transcriptionExecutionChannels.testEnterpriseConnection,
        provider,
        config
      ),
    listBedrockModels: (config) =>
      invokeParse(
        bedrockModelsResultSchema,
        transcriptionExecutionChannels.listBedrockModels,
        config
      ),
    getTinfoilChatModels: () =>
      invokeParse(
        tinfoilChatModelsResultSchema,
        transcriptionExecutionChannels.getTinfoilChatModels
      ),
  };
}
