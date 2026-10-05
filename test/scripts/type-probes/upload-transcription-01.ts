// @probe-name "an incomplete remote handler dependency set fails compilation"
// @probe-codes [2345]
// @probe-origin test/scripts/uploadTranscriptionTypeProbe.test.js
import { registerRemoteTranscriptionHandler } from "./src/helpers/remoteTranscriptionIpcHandler.js";

declare const ipcMain: {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
};

// Missing postMultipart and the provider clients would silently break every
// remote route; the compiler must reject the registration.
registerRemoteTranscriptionHandler(ipcMain, {
  resolveAllowedAudioPath: (p: string) => (p.endsWith(".wav") ? p : null),
  readFile: (p: string) => Buffer.from(p),
  fileSize: (p: string) => p.length,
  providerBaseUrls: () => [],
  getCortiClientId: () => "id",
  getCortiClientSecret: () => "secret",
  getTinfoilKey: () => "key",
  getGeminiKey: () => "key",
  uploadCancelRegistry: {
    register: () => ({ signal: undefined, release: () => {} }),
    cancel: () => 0,
  },
  logDebug: () => {},
  logWarn: () => {},
  logError: () => {},
});
