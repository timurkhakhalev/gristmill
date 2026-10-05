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
} from "../contracts/transcriptionExecution.js";
import type { ZodType } from "zod";

import type { IpcRendererLike } from "./ipcTransport.js";

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
      ),
    transcribeLocalParakeet: (audioBlob, options?) =>
      invokeParse(
        transcriptionResponseSchema,
        transcriptionExecutionChannels.transcribeLocalParakeet,
        audioBlob,
        options
      ),
    proxyXaiTranscription: (data) =>
      invokeParse(
        proxyTranscriptionResultSchema,
        transcriptionExecutionChannels.proxyXaiTranscription,
        data
      ),
    proxyMistralTranscription: (data) =>
      invokeParse(
        proxyTranscriptionResultSchema,
        transcriptionExecutionChannels.proxyMistralTranscription,
        data
      ),
    proxyCortiTranscription: (data) =>
      invokeParse(
        proxyTranscriptionResultSchema,
        transcriptionExecutionChannels.proxyCortiTranscription,
        data
      ),
    proxyTinfoilTranscription: (data) =>
      invokeParse(
        proxyTranscriptionResultSchema,
        transcriptionExecutionChannels.proxyTinfoilTranscription,
        data
      ),
    proxyGeminiTranscription: (data) =>
      invokeParse(
        proxyTranscriptionResultSchema,
        transcriptionExecutionChannels.proxyGeminiTranscription,
        data
      ),
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
      ),
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
