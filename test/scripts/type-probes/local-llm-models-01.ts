// @probe-name "an incomplete model manager fails the registration"
// @probe-codes [2739,2739,2740]
// @probe-origin test/scripts/localLlmModelsTypeProbe.test.js
import { registerLocalLlmModelHandlers } from "./src/helpers/localLlmModelIpcHandlers.ts";

declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };

registerLocalLlmModelHandlers(ipcMain, {
  modelManager: {
    ensureInitialized() {},
  },
  llamaCppInstaller: {},
  downloadStatus: {},
  progressSender: { sendToControlPanel: () => undefined },
  joinPath: (...segments: string[]) => segments.join("/"),
  persistEnvAfterServerStart: () => undefined,
  logError: () => undefined,
});
