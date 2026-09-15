const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");
const configPath = path.join(root, "tsconfig.main.json");

// Compiles a probe source under the strict main settings and returns all
// program diagnostics. Negative probes expect specific codes; positive
// probes expect none.
function probeDiagnostics(source) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsed.options.strict, true);
  const probe = path.join(root, "reasoning-type-probe.ts");
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...args) =>
    file === probe
      ? ts.createSourceFile(file, source, languageVersion, true)
      : readSource(file, languageVersion, ...args);
  const program = ts.createProgram([probe], { ...parsed.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  return {
    codes: diagnostics.map((d) => d.code).sort((a, b) => a - b),
    cleanup: () => {
      if (fs.existsSync(probe)) fs.rmSync(probe, { force: true });
    },
  };
}

const IPC_MAIN = `
declare const ipcMain: {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
};`;

test("an incomplete reasoning dependency set fails compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { registerReasoningHandlers } from "./src/helpers/reasoningIpcHandlers.js";

${IPC_MAIN}

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
`);
  try {
    assert.ok(codes.length > 0, "missing dependencies must not compile");
    assert.ok(
      codes.some((code) => [2322, 2345, 2739, 2741].includes(code)),
      `expected a property/argument diagnostic, got ${codes.join(",")}`
    );
  } finally {
    cleanup();
  }
});

test("wrong request payloads and failure-arm usage fail compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { createReasoningBridge } from "./src/preload/reasoningBridge.js";
import { enterpriseStreamEnvelopeSchema } from "./src/contracts/reasoning.js";

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
};
const bridge = createReasoningBridge(ipcRendererLike);

// text must be a string; the enterprise config requires a provider.
bridge.processLocalReasoning(12, "m", null, {});
bridge.processEnterpriseReasoning("t", "m", null, { systemPrompt: "s" });

// The stream start request requires streamId, provider, modelId and options.
bridge.enterpriseStreamStart({ provider: "bedrock", modelId: "m", options: {} });

async function failureArm(): Promise<string> {
  const result = await bridge.processEnterpriseReasoning("t", "m", null, { provider: "azure" });
  if (!result.success) {
    // text does not exist on the failure arm.
    return result.text;
  }
  return result.text ?? "";
}
void failureArm;

// Envelope parsing yields the discriminated envelope, not an arbitrary object.
const envelope = enterpriseStreamEnvelopeSchema.parse({ streamId: "s", done: true });
const done: boolean = envelope.part;
void done;
`);
  try {
    assert.ok(codes.includes(2345), `wrong positional arguments must fail, got ${codes.join(",")}`);
    assert.ok(codes.includes(2322), `wrong config/request fields must fail, got ${codes.join(",")}`);
    assert.ok(codes.includes(2339), `failure-arm usage must fail, got ${codes.join(",")}`);
  } finally {
    cleanup();
  }
});

test("the full registration and bridge compile under strict settings", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { registerReasoningHandlers } from "./src/helpers/reasoningIpcHandlers.js";
import { createReasoningBridge } from "./src/preload/reasoningBridge.js";
import { AgentStreamRequestRegistry } from "./src/helpers/agentStreamRequestRegistry.js";
import { toCloneableStreamPart } from "./src/helpers/reasoningIpcHandlers.js";

${IPC_MAIN}

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
  return [
    local.text ?? "",
    String(available),
    anthropic.text ?? "",
    enterprise.text ?? "",
    String(started.success),
  ].join();
}
void useAll;

const cloneable = toCloneableStreamPart({ type: "text-delta", id: "t", text: "x" });
void cloneable;
`);
  try {
    assert.deepEqual(codes, []);
  } finally {
    cleanup();
  }
});
