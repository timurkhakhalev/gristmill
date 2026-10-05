// @probe-name "wrong request, response and cancel payloads fail compilation"
// @probe-codes [2322,2322,2345,2345]
// @probe-origin test/scripts/uploadTranscriptionTypeProbe.test.js
import { createUploadTranscriptionBridge } from "./src/preload/uploadTranscriptionBridge.js";
import { registerUploadCancelHandler } from "./src/helpers/uploadCancelIpcHandler.js";

declare const ipcMain: {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
};

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
};
const bridge = createUploadTranscriptionBridge(ipcRendererLike);

// filePath is required and diarize must be boolean, not a string.
bridge.transcribeAudioFileByok({ filePath: 12, diarize: "yes" });

// duration must be a number; a string is a compile-time error.
bridge.mergeSpeakerText([{ start: 0, end: 1, speaker: "A" }], "text", "60");

// The registry dep is not optional either.
registerUploadCancelHandler(ipcMain, {});
