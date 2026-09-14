// The cancel-upload-transcription handler: the explicit hard cancel of one
// upload execution over the real shared registry. This is the defect fix of
// issue #32 — before it, neither the single upload's Stop nor cancelBatch()
// aborted the active remote transcription; one cancel must now abort every
// operation of its requestId (transcription and diarization run in parallel)
// without touching other ids, and late/repeated cancels stay no-ops.
const assert = require("node:assert/strict");
const test = require("node:test");

let registerUploadCancelHandler;
let registerRemoteTranscriptionHandler;
let registerFileDiarizationHandlers;
let createUploadCancelRegistry;

test.before(async () => {
  ({ registerUploadCancelHandler } = await import("../../src/helpers/uploadCancelIpcHandler.ts"));
  ({ registerRemoteTranscriptionHandler } = await import(
    "../../src/helpers/remoteTranscriptionIpcHandler.ts"
  ));
  ({ registerFileDiarizationHandlers } = await import(
    "../../src/helpers/fileDiarizationIpcHandlers.ts"
  ));
  ({ createUploadCancelRegistry } = await import("../../src/helpers/uploadCancelRegistry.ts"));
});

function setup() {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const registry = createUploadCancelRegistry();
  registerUploadCancelHandler(ipcMain, { uploadCancelRegistry: registry });
  const cancel = (requestId) => handlers.get("cancel-upload-transcription")(null, { requestId });
  return { handlers, registry, cancel };
}

test("one cancel aborts the parallel transcription and diarization of the same id", async () => {
  const { registry, cancel } = setup();

  // Two operations of one upload execution, resolved only by their signals.
  const settle = (signal) =>
    new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });

  const transcriptionSignal = registry.register("upload-1").signal;
  const diarizationSignal = registry.register("upload-1").signal;
  const otherSignal = registry.register("upload-2").signal;

  const races = await Promise.all([
    settle(transcriptionSignal),
    settle(diarizationSignal),
    (async () => {
      const result = await cancel("upload-1");
      assert.deepEqual(result, { success: true, cancelled: 2 });
      return "cancelled";
    })(),
  ]);

  assert.deepEqual(races, ["aborted", "aborted", "cancelled"]);
  assert.equal(otherSignal.aborted, false, "another upload is untouched");
  // Everything registered under the id was aborted and removed.
  assert.equal(registry.cancel("upload-1"), 0);
});

test("late or repeated cancels are safe no-ops", async () => {
  const { cancel } = setup();
  assert.deepEqual(await cancel("never-registered"), { success: true, cancelled: 0 });
  assert.deepEqual(await cancel("never-registered"), { success: true, cancelled: 0 });
});

test("invalid cancel payloads are rejected", async () => {
  const { handlers } = setup();
  const raw = handlers.get("cancel-upload-transcription");
  assert.deepEqual(await raw(null, null), { success: false, error: "Invalid cancel request" });
  assert.deepEqual(await raw(null, { requestId: "" }), {
    success: false,
    error: "Invalid cancel request",
  });
  assert.deepEqual(await raw(null, { requestId: 42 }), {
    success: false,
    error: "Invalid cancel request",
  });
});

test("end to end: cancel aborts a hanging remote transcription and diarization", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-cancel-e2e-")));
  const audioFile = path.join(tmpRoot, "audio.wav");
  fs.writeFileSync(audioFile, Buffer.alloc(64));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const registry = createUploadCancelRegistry();
  registerUploadCancelHandler(ipcMain, { uploadCancelRegistry: registry });

  const abortedSignals = [];
  const hangOnSignal = (options) =>
    new Promise((_resolve, reject) => {
      abortedSignals.push(options.signal);
      options.signal?.addEventListener("abort", () => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        reject(error);
      });
    });

  registerRemoteTranscriptionHandler(ipcMain, {
    resolveAllowedAudioPath: () => audioFile,
    readFile: () => Buffer.alloc(64),
    fileSize: () => 64,
    providerBaseUrls: () => [],
    postMultipart: (_url, _body, _boundary, _headers, options) => hangOnSignal(options),
    transcribeWithTinfoil: async () => ({ text: "t" }),
    transcribeWithGemini: async () => ({ text: "t" }),
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

  registerFileDiarizationHandlers(ipcMain, {
    diarizationManager: {
      isModelDownloaded: () => true,
      diarize: (_wavPath, options) =>
        new Promise((resolve) => {
          options.signal?.addEventListener("abort", () => resolve([]), { once: true });
        }),
      capSpeakerClusters: (segments) => segments,
    },
    resolveAllowedAudioPath: () => audioFile,
    convertToWav: async (_i, _o, options) => {
      await new Promise((resolve) => setImmediate(resolve));
      if (options.signal?.aborted) {
        const error = new Error("Aborted");
        error.name = "AbortError";
        throw error;
      }
    },
    createTempWavPath: () => path.join(tmpRoot, "wav.wav"),
    fileSize: () => 32000,
    resolveClusterThreshold: () => 0.55,
    dropNegligibleClusters: (segments) => segments,
    pcm16Mono16kBytesPerSecond: 32000,
    maxSpeakerCount: 16,
    removeFile: () => {},
    mergeSpeakersWithText: () => [],
    formatSpeakerTranscript: () => "",
    uploadCancelRegistry: registry,
    logDebug: () => {},
    logError: () => {},
  });

  const byok = handlers
    .get("transcribe-audio-file-byok")(null, {
      filePath: audioFile,
      apiKey: "sk",
      provider: "openai",
      transcriptionMode: "providers",
      requestId: "e2e",
    })
    .then(
      (r) => r,
      (e) => ({ success: false, error: String(e) })
    );
  const diarize = handlers.get("diarize-audio-file")(null, audioFile, { requestId: "e2e" });
  await new Promise((resolve) => setImmediate(resolve));

  const cancelled = await handlers.get("cancel-upload-transcription")(null, { requestId: "e2e" });
  assert.deepEqual(cancelled, { success: true, cancelled: 2 });

  assert.deepEqual(await byok, { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" });
  assert.deepEqual(await diarize, {
    success: false,
    error: "Cancelled",
    code: "UPLOAD_CANCELLED",
  });
});
