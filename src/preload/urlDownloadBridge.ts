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

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

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
    onUrlDownloadProgress: (callback: (progress: UrlDownloadProgress) => void) => {
      if (typeof callback !== "function") {
        return () => {};
      }

      const listener = (_event: unknown, data: unknown) => {
        const result = urlDownloadProgressSchema.safeParse(data);

        if (!result.success) {
          console.error(`[urlDownloadBridge] dropped malformed ${urlDownloadEventChannel} event`);

          return;
        }

        callback(result.data);
      };

      ipcRenderer.on(
        urlDownloadEventChannel,
        listener as (event: unknown, ...args: unknown[]) => void
      );

      return () => {
        ipcRenderer.removeListener(
          urlDownloadEventChannel,
          listener as (event: unknown, ...args: unknown[]) => void
        );
      };
    },
  };
}
