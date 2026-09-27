// @probe-name "an incomplete dependency set fails compilation"
// @probe-codes [2345]
// @probe-origin test/scripts/localFileTranscriptionTypeProbe.test.js
import { registerLocalFileTranscriptionHandler } from "./src/helpers/localFileTranscriptionIpcHandler.js";

declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };

// A handler missing transcribeLocalParakeet (and a wrong readFile) would
// silently break the sherpa route; the compiler must reject it.
registerLocalFileTranscriptionHandler(ipcMain, {
  readFile: (p) => Buffer.from("x"),
  resolveAllowedAudioPath: () => null,
  isSherpaLocalProvider: () => false,
  transcribeLocalWhisper: () => ({ success: true, text: "t" }),
  resolveWhisperVadOptions: () => ({}),
  uploadCancelRegistry: { register: () => ({ signal: undefined, release: () => {} }) },
  logDebug: () => {},
  logError: () => {},
});
