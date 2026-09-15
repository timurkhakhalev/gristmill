// Strict-mode probes for the diarization/speaker/ONNX cutover: the worker
// protocol guards, the client surface and the handler deps must reject wrong
// shapes instead of falling back to any.
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
  const probe = path.join(root, "speaker-onnx-type-probe.ts");
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

test("an unknown method string cannot ride the typed request union", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { OnnxWorkerClient } from "./src/helpers/onnxWorkerClient.ts";

declare const client: OnnxWorkerClient;
async function main() {
  await client.request("speaker.embed", {});
}
void main;
`);
  assert.deepEqual(codes, [2345]);
  cleanup();
});

test("an incomplete database fails the speaker registration", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { registerSpeakerHandlers } from "./src/helpers/speakerIpcHandlers.ts";

declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };

registerSpeakerHandlers(ipcMain, {
  databaseManager: {
    searchContacts: () => [],
  },
  liveSpeakerIdentifier: {},
  diarizationManager: {},
  retroactiveMapping: () => undefined,
  tryAutoLabelOneOnOne: () => undefined,
  logError: () => undefined,
});
`);
  assert.deepEqual(codes, [2739, 2740, 2740]);
  cleanup();
});

test("contract parse guards return the discriminated unions, not any", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { parseOnnxWorkerRequest } from "./src/contracts/onnxWorker.ts";

const request = parseOnnxWorkerRequest({ id: 1, method: "ping" });
if (request === null) throw new Error("null");
// method is the literal union; a bogus method literal must not compile.
const bad: "speaker.embed" = request.method;
void bad;
`);
  assert.deepEqual(codes, [2322]);
  cleanup();
});
