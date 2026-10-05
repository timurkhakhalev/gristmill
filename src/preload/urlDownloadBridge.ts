// Renderer-facing bridge for the direct HTTPS download vertical, extracted
// from preload.js like notesBridge before it. The sandboxed preload can't
// require local modules, so build-main.js bundles the final preload with
// esbuild. Results come back as unknown and are parsed with the shared
// contract; a malformed event is dropped instead of reaching the renderer.
import {
  cancelUrlDownloadResultSchema,
  deleteTempFileResultSchema,
  urlDownloadChannels,
  urlDownloadEventChannel,
  urlDownloadProgressSchema,
  urlDownloadResultSchema,
  type UrlDownloadApi,
  type UrlDownloadProgress,
} from "../contracts/urlDownload.js";
import type { ZodType } from "zod";

import { subscribeDropped, type IpcRendererLike } from "./ipcTransport.js";

function parseResult<T>(schema: ZodType<T>, raw: unknown, channel: string): T {
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw new Error(`Unexpected response shape from ${channel}`);
  }

  return result.data;
}

// The return type is the shared UrlDownloadApi, so drift between this
// implementation and the contract fails compilation.
export function createUrlDownloadBridge(ipcRenderer: IpcRendererLike): UrlDownloadApi {
  return {
    downloadUrlAudio: (url: string, downloadId?: string) =>
      ipcRenderer
        .invoke(urlDownloadChannels.downloadUrlAudio, url, downloadId)
        .then((raw) =>
          parseResult(urlDownloadResultSchema, raw, urlDownloadChannels.downloadUrlAudio)
        ),
    cancelUrlDownload: (downloadId?: string) =>
      ipcRenderer
        .invoke(urlDownloadChannels.cancelUrlDownload, downloadId)
        .then((raw) =>
          parseResult(cancelUrlDownloadResultSchema, raw, urlDownloadChannels.cancelUrlDownload)
        ),
    deleteTempFile: (filePath: string) =>
      ipcRenderer
        .invoke(urlDownloadChannels.deleteTempFile, filePath)
        .then((raw) =>
          parseResult(deleteTempFileResultSchema, raw, urlDownloadChannels.deleteTempFile)
        ),
    onUrlDownloadProgress: (callback: (progress: UrlDownloadProgress) => void) =>
      subscribeDropped(
        ipcRenderer,
        urlDownloadEventChannel,
        (raw) => {
          const result = urlDownloadProgressSchema.safeParse(raw);

          if (result.success) return result.data;

          console.error(`[urlDownloadBridge] dropped malformed ${urlDownloadEventChannel} event`);

          return undefined;
        },
        callback
      ),
  };
}
