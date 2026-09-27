// @probe-name "the correct API/bridge pair compiles under strict settings"
// @probe-codes []
// @probe-origin test/scripts/urlDownloadTypeProbe.test.js
import type { IpcRenderer } from "electron";
import {
  urlDownloadResultSchema,
  type UrlDownloadApi,
  type UrlDownloadResult,
} from "./src/contracts/urlDownload.js";
import { createUrlDownloadBridge } from "./src/preload/urlDownloadBridge.js";
import { registerUrlDownloadHandlers } from "./src/helpers/urlDownloadIpcHandlers.js";

declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };
declare const ipcRenderer: IpcRenderer;

// The bridge return type must stay connected to the shared API type.
const bridge: UrlDownloadApi = createUrlDownloadBridge(ipcRenderer);
registerUrlDownloadHandlers(ipcMain, {
  download: async (url, onProgress, signal) => {
    onProgress({ stage: "downloading", percent: 50 });
    return { tempPath: "/t/x", title: "t", durationSeconds: null, sizeBytes: 1 };
  },
  sweepStaleTempArtifacts: () => {},
  getSafeTempDir: () => "/tmp",
  debugLogger: { error() {}, warn() {} },
});

async function use(): Promise<UrlDownloadResult> {
  const result = await bridge.downloadUrlAudio("https://example.com/a.mp3");
  if (result.success) {
    const bytes: number = result.sizeBytes;
    console.log(bytes, result.tempPath);
  } else {
    console.log(result.error, result.code);
  }
  bridge.cancelUrlDownload().then((r) => console.log(r.success));
  bridge.deleteTempFile("/tmp/ow-url-a").then((r) => console.log(r.success));
  const stop = bridge.onUrlDownloadProgress((p) => console.log(p.stage, p.percent));
  stop();
  return urlDownloadResultSchema.parse(result);
}
console.log(use);
