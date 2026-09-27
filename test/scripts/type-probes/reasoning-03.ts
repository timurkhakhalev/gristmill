// @probe-name "the full registration and bridge compile under strict settings"
// @probe-codes []
// @probe-origin test/scripts/reasoningTypeProbe.test.js
import { registerReasoningHandlers } from "./src/helpers/reasoningIpcHandlers.js";
import { createReasoningBridge } from "./src/preload/reasoningBridge.js";
import { AgentStreamRequestRegistry } from "./src/helpers/agentStreamRequestRegistry.js";
import { toCloneableStreamPart } from "./src/helpers/reasoningIpcHandlers.js";


declare const ipcMain: {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
};

registerReasoningHandlers(ipcMain, {
  localService: { isAvailable: async () => true, processText: async () => "t" },
  getAnthropicKey: () => "k",
  proxyFetch: async () => ({ ok: true, status: 200, statusText: "", text: async () => "", json: async () => ({}) }),
  extractAnthropicText: () => "t",
  describeMissingAnthropicText: () => "t",
  isEnterpriseProvider: (value: unknown) => value === "bedrock",
  mapEnterpriseError: () => ({ message: "m" }),
  runAbortableOperation: (operation) => operation(),
  runBedrockRequest: (operation) => operation(),
  validateEnterpriseEndpoint: () => {},
  generateText: async () => ({ text: "t", finishReason: "stop" }),
  getEnterpriseAIModel: async () => ({
    doStream: async () => ({
      stream: { getReader: () => ({ read: async () => ({ done: true }), releaseLock: () => {} }) },
    }),
  }),
  bedrockCleanupRequests: new AgentStreamRequestRegistry(),
  enterpriseStreams: new AgentStreamRequestRegistry(),
  logError: () => {},
});

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
};
const bridge = createReasoningBridge(ipcRendererLike);

async function useAll(): Promise<string> {
  const local = await bridge.processLocalReasoning("t", "m", null, { temperature: 0 });
  const available = await bridge.checkLocalReasoningAvailable();
  const anthropic = await bridge.processAnthropicReasoning("t", "m", null, {});
  const enterprise = await bridge.processEnterpriseReasoning("t", "m", null, { provider: "azure" });
  bridge.cancelEnterpriseReasoning();
  const started = await bridge.enterpriseStreamStart({
    streamId: "s",
    provider: "bedrock",
    modelId: "m",
    options: {},
  });
  await bridge.enterpriseStreamCancel("s");
  const unsubscribe = bridge.onEnterpriseStreamPart((envelope) => {
    if (envelope.done) return;
    if (envelope.error !== undefined) return;
    void envelope.part;
  });
  unsubscribe();
  // Success-arm text access requires the discriminated narrowing to hold.
  if (!local.success || !anthropic.success || !enterprise.success || !started.success) {
    return "";
  }
  return [
    local.text ?? "",
    String(available),
    anthropic.text ?? "",
    enterprise.text ?? "",
    String(started.success),
  ].join();
}
void useAll;

const cloneable = toCloneableStreamPart({ type: "text-delta", id: "t", delta: "x" });
void cloneable;
