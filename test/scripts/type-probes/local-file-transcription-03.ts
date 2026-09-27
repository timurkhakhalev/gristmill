// @probe-name "the full registration and bridge compile under strict settings"
// @probe-codes []
// @probe-origin test/scripts/localFileTranscriptionTypeProbe.test.js
import { registerLocalFileTranscriptionHandler } from "./src/helpers/localFileTranscriptionIpcHandler.js";
import { createLocalFileTranscriptionBridge } from "./src/preload/localFileTranscriptionBridge.js";
import { transcribeLocalFile } from "./src/helpers/localFileTranscription.js";

declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };

registerLocalFileTranscriptionHandler(ipcMain, {
  readFile: (p: string) => Buffer.from(p),
  resolveAllowedAudioPath: (p: string) => (p.endsWith(".wav") ? p : null),
  isSherpaLocalProvider: (provider: unknown) => provider === "nvidia",
  transcribeLocalWhisper: (buffer: Buffer, options: unknown) => {
    void options;
    return { success: true, text: buffer.toString() };
  },
  transcribeLocalParakeet: (buffer: Buffer, options: unknown) => {
    void options;
    return { success: true, text: buffer.toString(), warning: "truncated" };
  },
  resolveWhisperVadOptions: (context: string) => ({ vadEnabled: context === "noteRecording" }),
  uploadCancelRegistry: {
    register: (id: unknown) => {
      void id;
      return { signal: undefined, release: () => {} };
    },
  },
  logDebug: () => {},
  logError: () => {},
});

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
};
const bridge = createLocalFileTranscriptionBridge(ipcRendererLike);
async function useResponse(): Promise<number> {
  const response = await bridge.transcribeAudioFile("/tmp/a.wav", { provider: "whisper" });
  return response.text?.length ?? 0;
}
void useResponse;
