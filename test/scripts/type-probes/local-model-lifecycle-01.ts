// @probe-name "missing manager methods fail the lifecycle registration"
// @probe-codes [2740]
// @probe-origin test/scripts/localModelLifecycleTypeProbe.test.js
import { registerLocalModelLifecycleHandlers } from "./src/helpers/localModelLifecycleIpcHandlers.ts";
import type { WhisperVadConfigUpdate, WhisperVadWireConfig } from "./src/contracts/localModelLifecycle.ts";

declare const ipcMain: {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
};

registerLocalModelLifecycleHandlers(ipcMain, {
  whisperManager: {
    checkWhisperInstallation: async () => ({ installed: true, working: true }),
  },
  downloadStatus: {
    has: () => false,
    start: () => undefined,
    finish: () => null,
  },
  progressSender: { sendToControlPanel: () => undefined },
  updateDownloadStatus: () => null,
  getWhisperVadSettings: () => ({} as WhisperVadWireConfig),
  setWhisperVadSettings: (payload: WhisperVadConfigUpdate) => payload as WhisperVadWireConfig,
  persistParakeetProviderSelection: async () => undefined,
  clearParakeetProviderSelection: async () => undefined,
  resolveParakeetProviderName: () => "cohere",
  logError: () => undefined,
});
