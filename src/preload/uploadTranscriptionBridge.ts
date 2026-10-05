// Renderer-facing upload execution bridge (remote transcription, file
// diarization, speaker-text merge, hard cancel). Moved out of preload.js so
// the four operations have typed implementations backed by the shared
// contract — the single source of channel names. The sandboxed preload can't
// require local modules, so build-main.js bundles the final preload with
// esbuild before packaging.
import {
  uploadTranscriptionChannels,
  remoteTranscriptionResponseSchema,
  diarizationResponseSchema,
  mergeSpeakerTextResponseSchema,
  uploadCancelResponseSchema,
  type UploadTranscriptionApi,
} from "../contracts/uploadTranscription.js";
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

// The return type is the shared UploadTranscriptionApi, so any drift between
// this implementation and the contract fails compilation.
export function createUploadTranscriptionBridge(
  ipcRenderer: IpcRendererLike
): UploadTranscriptionApi {
  return {
    transcribeAudioFileByok: (request) =>
      ipcRenderer
        .invoke(uploadTranscriptionChannels.transcribeAudioFileByok, request)
        .then((raw) =>
          parseResult(
            remoteTranscriptionResponseSchema,
            raw,
            uploadTranscriptionChannels.transcribeAudioFileByok
          )
        ),
    diarizeAudioFile: (filePath, options) =>
      ipcRenderer
        .invoke(uploadTranscriptionChannels.diarizeAudioFile, filePath, options)
        .then((raw) =>
          parseResult(diarizationResponseSchema, raw, uploadTranscriptionChannels.diarizeAudioFile)
        ),
    mergeSpeakerText: (segments, text, duration) =>
      ipcRenderer
        .invoke(uploadTranscriptionChannels.mergeSpeakerText, { segments, text, duration })
        .then((raw) =>
          parseResult(
            mergeSpeakerTextResponseSchema,
            raw,
            uploadTranscriptionChannels.mergeSpeakerText
          )
        ),
    cancelUploadTranscription: (request) =>
      ipcRenderer
        .invoke(uploadTranscriptionChannels.cancelUploadTranscription, request)
        .then((raw) =>
          parseResult(
            uploadCancelResponseSchema,
            raw,
            uploadTranscriptionChannels.cancelUploadTranscription
          )
        ),
  };
}
