// @probe-name "an incomplete reasoning dependency set fails compilation"
// @probe-codes [2345]
// @probe-origin test/scripts/reasoningTypeProbe.test.js
import { registerReasoningHandlers } from "./src/helpers/reasoningIpcHandlers.js";


declare const ipcMain: {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
};

// Missing the registries and the provider factories would silently break
// cancellation and every enterprise route; the compiler must reject it.
registerReasoningHandlers(ipcMain, {
  localService: { isAvailable: async () => true, processText: async () => "t" },
  getAnthropicKey: () => "k",
  proxyFetch: async () => ({ ok: true, status: 200, statusText: "", text: async () => "", json: async () => ({}) }),
  extractAnthropicText: () => "t",
  describeMissingAnthropicText: () => "t",
  isEnterpriseProvider: () => true,
  mapEnterpriseError: () => ({ message: "m" }),
  runAbortableOperation: (operation) => operation(),
  runBedrockRequest: (operation) => operation(),
  validateEnterpriseEndpoint: () => {},
  generateText: async () => ({ text: "t", finishReason: "stop" }),
  logError: () => {},
});
