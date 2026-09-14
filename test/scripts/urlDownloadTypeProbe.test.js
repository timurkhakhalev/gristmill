const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");
const configPath = path.join(root, "tsconfig.main.json");

// Compiles a probe source under the strict main settings and returns the TS
// diagnostic codes. Negative probes expect specific codes; positive probes
// expect none.
function probeDiagnostics(source) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsed.options.strict, true);
  const probe = path.join(root, "url-download-type-probe.ts");
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

test("wrong-shaped arguments and results fail compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import {
  downloadUrlAudioArgsSchema,
  urlDownloadResultSchema,
  type UrlDownloadResult,
} from "./src/contracts/urlDownload.js";

// Wrong argument type at the boundary.
downloadUrlAudioArgsSchema.parse([42, "dl-1"]);
downloadUrlAudioArgsSchema.parse(["https://example.com/a.mp3", 7]);
// Overlong URL fails the schema.
downloadUrlAudioArgsSchema.parse([["x".repeat(2049)]]);
// Unknown stage is not a progress payload the bridge may forward.
import { urlDownloadProgressSchema } from "./src/contracts/urlDownload.js";
urlDownloadProgressSchema.parse({ stage: "sideways", percent: 1 });

// A failure result cannot be narrowed to success by a bare assertion.
const bad: UrlDownloadResult = urlDownloadResultSchema.parse({ success: false, error: "e" });
if (bad.success) {
  const p: string = bad.error;
  console.log(p);
}
console.log(bad);
`);
  try {
    // The probe asserts exactly one failure: inside the `success`-narrowed
    // branch `bad.error` does not exist on the success variant (2339, "Property
    // does not exist"), so a bare narrowing lie cannot leak typed fields.
    assert.deepEqual(codes, [2339]);
  } finally {
    cleanup();
  }
});

test("the correct API/bridge pair compiles under strict settings", () => {
  const { codes, cleanup } = probeDiagnostics(`
import type { IpcRenderer } from "electron";
import {
  urlDownloadResultSchema,
  type UrlDownloadApi,
  type UrlDownloadResult,
} from "./src/contracts/urlDownload.js";
import { createUrlDownloadBridge } from "./src/preload/urlDownloadBridge.js";
import { registerUrlDownloadHandlers } from "./src/helpers/urlDownloadIpcHandlers.js";

declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };
declare const ipcRenderer: IpcRenderer;

// The bridge return type must stay connected to the shared API type.
const bridge: UrlDownloadApi = createUrlDownloadBridge(ipcRenderer);
registerUrlDownloadHandlers(ipcMain, {
  download: async (url, onProgress, signal) => {
    onProgress({ stage: "downloading", percent: 50 });
    return { tempPath: "/t/x", title: "t", durationSeconds: null, sizeBytes: 1 };
  },
  sweepStaleTempArtifacts: () => {},
  getSafeTempDir: () => "/tmp",
  debugLogger: { error() {}, warn() {} },
});

async function use(): Promise<UrlDownloadResult> {
  const result = await bridge.downloadUrlAudio("https://example.com/a.mp3");
  if (result.success) {
    const bytes: number = result.sizeBytes;
    console.log(bytes, result.tempPath);
  } else {
    console.log(result.error, result.code);
  }
  bridge.cancelUrlDownload().then((r) => console.log(r.success));
  bridge.deleteTempFile("/tmp/ow-url-a").then((r) => console.log(r.success));
  const stop = bridge.onUrlDownloadProgress((p) => console.log(p.stage, p.percent));
  stop();
  return urlDownloadResultSchema.parse(result);
}
console.log(use);
`);
  try {
    assert.deepEqual(codes, []);
  } finally {
    cleanup();
  }
});
