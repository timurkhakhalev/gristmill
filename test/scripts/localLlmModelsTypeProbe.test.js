// Strict-mode probes for the local LLM model cutover: the registration deps
// surface, the contract result interfaces and the llamaServer manager fields
// must reject wrong shapes instead of falling back to any.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");
const configPath = path.join(root, "tsconfig.main.json");

function probeDiagnostics(source) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsed.options.strict, true);
  const probe = path.join(root, "local-llm-type-probe.ts");
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

test("an incomplete model manager fails the registration", () => {
  const { codes, cleanup } = probeDiagnostics(`
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
`);
  assert.deepEqual(codes, [2739, 2739, 2740]);
  cleanup();
});

test("bridged result types reject untyped consumption", () => {
  const { codes, cleanup } = probeDiagnostics(`
import type { LocalLlmModelsApi } from "./src/contracts/localLlmModels.ts";

declare const api: LocalLlmModelsApi;

async function main() {
  const models = await api.modelGetAll();
  // LocalLlmModelStatus guarantees known fields; reading isDownloaded as a
  // boolean[] must not compile.
  const broken: boolean[] = models[0].isDownloaded;
}
void main;
`);
  assert.deepEqual(codes, [2322]);
  cleanup();
});

test("llamaServer options keep numeric/context fields narrowed", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { LlamaServerManager } from "./src/helpers/llamaServer.ts";

const manager = new LlamaServerManager();
// draftModelPath is string | null | undefined, not an arbitrary object.
const bad: { path: string } = manager.draftModelPath;
void bad;
`);
  assert.deepEqual(codes, [2322]);
  cleanup();
});
