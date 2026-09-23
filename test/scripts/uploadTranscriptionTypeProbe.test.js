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
  const probe = path.join(root, "upload-transcription-type-probe.ts");
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

test("an incomplete remote handler dependency set fails compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { registerRemoteTranscriptionHandler } from "./src/helpers/remoteTranscriptionIpcHandler.js";

${IPC_MAIN}

// Missing postMultipart and the provider clients would silently break every
// remote route; the compiler must reject the registration.
registerRemoteTranscriptionHandler(ipcMain, {
  resolveAllowedAudioPath: (p: string) => (p.endsWith(".wav") ? p : null),
  readFile: (p: string) => Buffer.from(p),
  fileSize: (p: string) => p.length,
  providerBaseUrls: () => [],
  getCortiClientId: () => "id",
  getCortiClientSecret: () => "secret",
  getTinfoilKey: () => "key",
  getGeminiKey: () => "key",
  uploadCancelRegistry: { register: () => ({ signal: undefined, release: () => {} }), cancel: () => 0 },
  logDebug: () => {},
  logWarn: () => {},
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

test("wrong request, response and cancel payloads fail compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { createUploadTranscriptionBridge } from "./src/preload/uploadTranscriptionBridge.js";
import { registerUploadCancelHandler } from "./src/helpers/uploadCancelIpcHandler.js";

${IPC_MAIN}

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
};
const bridge = createUploadTranscriptionBridge(ipcRendererLike);

// filePath is required and diarize must be boolean, not a string.
bridge.transcribeAudioFileByok({ filePath: 12, diarize: "yes" });

// duration must be a number; a string is a compile-time error.
bridge.mergeSpeakerText([{ start: 0, end: 1, speaker: "A" }], "text", "60");

// The registry dep is not optional either.
registerUploadCancelHandler(ipcMain, {});
`);
  try {
    assert.ok(codes.includes(2322), `wrong request fields must fail, got ${codes.join(",")}`);
    assert.ok(codes.includes(2345), `wrong merge argument must fail, got ${codes.join(",")}`);
    assert.ok(
      codes.some((code) => [2345, 2739, 2741].includes(code)),
      `cancel handler without a registry must fail, got ${codes.join(",")}`
    );
  } finally {
    cleanup();
  }
});

test("the full registration set and bridge compile under strict settings", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { registerRemoteTranscriptionHandler } from "./src/helpers/remoteTranscriptionIpcHandler.js";
import { registerFileDiarizationHandlers } from "./src/helpers/fileDiarizationIpcHandlers.js";
import { registerUploadCancelHandler } from "./src/helpers/uploadCancelIpcHandler.js";
import { createUploadTranscriptionBridge } from "./src/preload/uploadTranscriptionBridge.js";
import { buildMultipartBody } from "./src/helpers/remoteTranscriptionIpcHandler.js";

${IPC_MAIN}

const registry = { register: (id: unknown) => ({ signal: undefined, release: () => {} }), cancel: () => 0 };

registerUploadCancelHandler(ipcMain, { uploadCancelRegistry: registry });

registerFileDiarizationHandlers(ipcMain, {
  diarizationManager: {
    isModelDownloaded: () => true,
    diarize: async (wavPath: string, options: { numSpeakers: number; threshold: number }) => {
      void wavPath;
      void options;
      return [];
    },
    capSpeakerClusters: (segments: Array<{ start: number; end: number; speaker: string }>) => segments,
  },
  resolveAllowedAudioPath: (p: string) => (p.endsWith(".wav") ? p : null),
  convertToWav: async (input: string, output: string) => {
    void input;
    void output;
  },
  createTempWavPath: () => "/tmp/w.wav",
  fileSize: () => 32000,
  resolveClusterThreshold: (d: number) => d * 0 + 0.55,
  dropNegligibleClusters: (segments: Array<{ start: number; end: number; speaker: string }>) => segments,
  pcm16Mono16kBytesPerSecond: 32000,
  maxSpeakerCount: 16,
  removeFile: () => {},
  mergeSpeakersWithText: () => [],
  formatSpeakerTranscript: () => "",
  uploadCancelRegistry: registry,
  logDebug: () => {},
  logError: () => {},
});

registerRemoteTranscriptionHandler(ipcMain, {
  resolveAllowedAudioPath: (p: string) => (p.endsWith(".wav") ? p : null),
  readFile: (p: string) => Buffer.from(p),
  fileSize: (p: string) => p.length,
  providerBaseUrls: () => [],
  postMultipart: async (url: URL) => ({ statusCode: 200, data: { text: "t" }, url }),
  postRawAudioFile: async () => ({ statusCode: 200, data: { results: {} } }),
  transcribeWithTinfoil: async () => ({ text: "t" }),
  transcribeGeminiFile: async () => ({ success: true, text: "t" }),
  transcribeWithCorti: async () => ({ text: "t" }),
  getCortiClientId: () => "id",
  getCortiClientSecret: () => "secret",
  getTinfoilKey: () => "key",
  getGeminiKey: () => "key",
  uploadCancelRegistry: registry,
  logDebug: () => {},
  logWarn: () => {},
  logError: () => {},
});

const { body, boundary } = buildMultipartBody(Buffer.from("x"), "a.wav", "audio/wav", {
  model: "m",
});
void body;
void boundary;

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
};
const bridge = createUploadTranscriptionBridge(ipcRendererLike);
async function useAll(): Promise<string> {
  const byok = await bridge.transcribeAudioFileByok({ filePath: "/tmp/a.wav" });
  const diar = await bridge.diarizeAudioFile("/tmp/a.wav", { numSpeakers: 2 });
  const merged = await bridge.mergeSpeakerText([], "text", 1);
  const cancelled = await bridge.cancelUploadTranscription({ requestId: "r" });
  return [byok.text ?? "", String(diar.success), merged.text ?? "", String(cancelled.cancelled)].join();
}
void useAll;
`);
  try {
    assert.deepEqual(codes, []);
  } finally {
    cleanup();
  }
});
