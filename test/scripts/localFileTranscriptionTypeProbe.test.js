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
  const probe = path.join(root, "transcription-type-probe.ts");
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

const IPC_MAIN = `declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };`;

test("an incomplete dependency set fails compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { registerLocalFileTranscriptionHandler } from "./src/helpers/localFileTranscriptionIpcHandler.js";

${IPC_MAIN}

// A handler missing transcribeLocalParakeet (and a wrong readFile) would
// silently break the sherpa route; the compiler must reject it.
registerLocalFileTranscriptionHandler(ipcMain, {
  readFile: (p) => Buffer.from("x"),
  resolveAllowedAudioPath: () => null,
  isSherpaLocalProvider: () => false,
  transcribeLocalWhisper: () => ({ success: true, text: "t" }),
  resolveWhisperVadOptions: () => ({}),
  uploadCancelRegistry: { register: () => ({ signal: undefined, release: () => {} }) },
  logDebug: () => {},
  logError: () => {},
});
`);
  try {
    assert.deepEqual(codes, [2345]);
  } finally {
    cleanup();
  }
});

test("a wrong bridge-level call fails compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { createLocalFileTranscriptionBridge } from "./src/preload/localFileTranscriptionBridge.js";

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
};
const bridge = createLocalFileTranscriptionBridge(ipcRendererLike);

// filePath must be a string; a number is a compile-time error.
bridge.transcribeAudioFile(1234);
`);
  try {
    assert.deepEqual(codes, [2345]);
  } finally {
    cleanup();
  }
});

test("the full registration and bridge compile under strict settings", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { registerLocalFileTranscriptionHandler } from "./src/helpers/localFileTranscriptionIpcHandler.js";
import { createLocalFileTranscriptionBridge } from "./src/preload/localFileTranscriptionBridge.js";
import { transcribeLocalFile } from "./src/helpers/localFileTranscription.js";

${IPC_MAIN}

registerLocalFileTranscriptionHandler(ipcMain, {
  readFile: (p: string) => Buffer.from(p),
  resolveAllowedAudioPath: (p: string) => (p.endsWith(".wav") ? p : null),
  isSherpaLocalProvider: (provider: unknown) => provider === "nvidia",
  transcribeLocalWhisper: (buffer: Buffer, options: unknown) => {
    void options;
    return { success: true, text: buffer.toString() };
  },
  transcribeLocalParakeet: (buffer: Buffer, options: unknown) => {
    void options;
    return { success: true, text: buffer.toString(), warning: "truncated" };
  },
  resolveWhisperVadOptions: (context: string) => ({ vadEnabled: context === "noteRecording" }),
  uploadCancelRegistry: {
    register: (id: unknown) => {
      void id;
      return { signal: undefined, release: () => {} };
    },
  },
  logDebug: () => {},
  logError: () => {},
});

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
};
const bridge = createLocalFileTranscriptionBridge(ipcRendererLike);
async function useResponse(): Promise<number> {
  const response = await bridge.transcribeAudioFile("/tmp/a.wav", { provider: "whisper" });
  return response.text?.length ?? 0;
}
void useResponse;
`);
  try {
    assert.deepEqual(codes, []);
  } finally {
    cleanup();
  }
});
