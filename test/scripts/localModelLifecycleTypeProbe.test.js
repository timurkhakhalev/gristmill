// Strict-mode probes for the local Whisper/Parakeet lifecycle cutover: the
// contract result interfaces, the registration deps surface, and the preload
// bridge must reject wrong shapes instead of falling back to any.
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
  const probe = path.join(root, "local-model-type-probe.ts");
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

test("missing manager methods fail the lifecycle registration", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { registerLocalModelLifecycleHandlers } from "./src/helpers/localModelLifecycleIpcHandlers.ts";

declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };

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
  getWhisperVadSettings: () => ({}),
  setWhisperVadSettings: (payload: Record<string, unknown>) => payload,
  persistParakeetProviderSelection: async () => undefined,
  clearParakeetProviderSelection: async () => undefined,
  resolveParakeetProviderName: () => "cohere",
  logError: () => undefined,
});
`);
  assert.deepEqual(codes, [2740]);
  cleanup();
});

test("bridged result types reject untyped consumption", () => {
  const { codes, cleanup } = probeDiagnostics(`
import type { LocalModelLifecycleApi } from "./src/contracts/localModelLifecycle.ts";

declare const api: LocalModelLifecycleApi;

async function main() {
  const status = await api.listWhisperModels();
  // LocalModelListResult only guarantees success/models/cache_dir + index
  // access; reading a model row as a boolean must not compile.
  const broken: boolean = status.models;
}
void main;
`);
  assert.deepEqual(codes, [2322]);
  cleanup();
});

test("download progress events carry discriminated types through the api", () => {
  const { codes, cleanup } = probeDiagnostics(`
import type { LocalModelLifecycleApi } from "./src/contracts/localModelLifecycle.ts";

declare const api: LocalModelLifecycleApi;

const dispose = api.onWhisperDownloadProgress((data) => {
  const pct: number | undefined = data.percentage;
  // "percent" is not a field of the event union.
  const bad: number = data.percent;
  void pct;
  void bad;
});
void dispose;
`);
  assert.deepEqual(codes, [2339]);
  cleanup();
});
