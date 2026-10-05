// Renderer-facing local file transcription bridge. Moved out of preload.js
// so the one operation has a typed implementation backed by the shared
// contract. The sandboxed preload can't require local modules, so
// build-main.js bundles the final preload with esbuild before packaging.
import {
  localFileTranscriptionChannels,
  transcriptionResponseSchema,
  type LocalFileTranscriptionApi,
  type TranscriptionResponse,
} from "../contracts/localFileTranscription.js";
import type { LocalTranscriptionProvider } from "../contracts/inferenceSettings.js";

import type { IpcRendererLike } from "./ipcTransport.js";
import type { ZodType } from "zod";

function parseResult<T>(schema: ZodType<T>, raw: unknown, channel: string): T {
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw new Error(`Unexpected response shape from ${channel}`);
  }

  return result.data;
}

// The return type is the shared LocalFileTranscriptionApi, so any drift
// between this implementation and the contract fails compilation.
export function createLocalFileTranscriptionBridge(
  ipcRenderer: IpcRendererLike
): LocalFileTranscriptionApi {
  return {
    transcribeAudioFile: (
      filePath: string,
      options?: {
        provider?: LocalTranscriptionProvider;
        model?: string;
        language?: string;
        requestId?: string;
        skipDecoderThresholds?: boolean;
      }
    ): Promise<TranscriptionResponse> =>
      ipcRenderer
        .invoke(localFileTranscriptionChannels.transcribeAudioFile, filePath, options)
        .then((raw) =>
          parseResult(
            transcriptionResponseSchema,
            raw,
            localFileTranscriptionChannels.transcribeAudioFile
          )
        ),
  };
}
