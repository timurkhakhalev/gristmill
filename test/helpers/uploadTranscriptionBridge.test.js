// The real bundled preload talks to the real typed upload execution handlers
// over fake transports/managers (no binaries, no Electron net): full response
// shapes crossing the wire for all four operations, malformed main responses
// rejected at the preload boundary, and the shared main registration
// duplicate-channel guard.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

const root = path.resolve(__dirname, "../..");
const bundledPreload = path.join(root, "dist-main", "preload.js");

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-upload-bridge-")));
const audioFile = path.join(tmpRoot, "audio.wav");
fs.writeFileSync(audioFile, Buffer.alloc(64));

let activeHandlers = new Map();

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => tmpRoot,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
      ipcMain: {
        handle: (channel, listener) => {
          if (activeHandlers.has(channel)) {
            throw new Error(`Attempted to register a second handler for '${channel}'`);
          }
          activeHandlers.set(channel, listener);
        },
        on() {},
        removeHandler() {},
        emit() {},
      },
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
process.env.NODE_ENV = "test";

test.after(() => {
  Module._load = originalLoad;
});

function loadBundledPreload(invoke) {
  let api;
  vm.runInNewContext(fs.readFileSync(bundledPreload, "utf8"), {
    require(name) {
      assert.equal(name, "electron", "the bundled preload must only require electron");
      return {
        contextBridge: {
          exposeInMainWorld: (_name, value) => {
            api = value;
          },
        },
        ipcRenderer: {
          invoke,
          send() {},
          on() {},
          removeListener() {},
        },
        webUtils: { getPathForFile: () => "" },
      };
    },
    process: { platform: "darwin", versions: {} },
    console,
  });
  return api;
}

// Objects from vm.runInNewContext have a different prototype; compare by JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

async function createFixture() {
  assert.ok(fs.existsSync(bundledPreload), "Run pnpm run build:main first");
  activeHandlers = new Map();
  const ipcMain = { handle: (channel, listener) => activeHandlers.set(channel, listener) };

  const { createUploadCancelRegistry } = await import("../../src/helpers/uploadCancelRegistry.ts");
  const { registerUploadCancelHandler } = await import("../../src/helpers/uploadCancelIpcHandler.ts");
  const { registerRemoteTranscriptionHandler } = await import(
    "../../src/helpers/remoteTranscriptionIpcHandler.ts"
  );
  const { registerFileDiarizationHandlers } = await import(
    "../../src/helpers/fileDiarizationIpcHandlers.ts"
  );
  const { mergeSpeakersWithText, formatSpeakerTranscript } = require("../../src/helpers/speakerMerge");

  const registry = createUploadCancelRegistry();
  registerUploadCancelHandler(ipcMain, { uploadCancelRegistry: registry });

  registerRemoteTranscriptionHandler(ipcMain, {
    resolveAllowedAudioPath: (filePath) => (filePath === audioFile ? audioFile : null),
    readFile: () => Buffer.alloc(64),
    fileSize: () => 64,
    providerBaseUrls: () => [],
    postMultipart: async () => ({
      statusCode: 200,
      data: {
        text: "plain",
        segments: [{ speaker: "A", text: "hello", start: 0, end: 1 }],
      },
    }),
    transcribeWithTinfoil: async () => ({ text: "tinfoil" }),
    transcribeWithGemini: async () => ({ text: "gemini" }),
    transcribeWithCorti: async () => ({ text: "corti" }),
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
      diarize: async () => [{ start: 0, end: 2, speaker: "speaker_0" }],
      capSpeakerClusters: (segments) => segments,
    },
    resolveAllowedAudioPath: (filePath) => (filePath === audioFile ? audioFile : null),
    convertToWav: async () => {},
    createTempWavPath: () => path.join(tmpRoot, "wav.wav"),
    fileSize: () => 64000,
    resolveClusterThreshold: () => 0.55,
    dropNegligibleClusters: (segments) => segments,
    pcm16Mono16kBytesPerSecond: 32000,
    maxSpeakerCount: 16,
    removeFile: () => {},
    mergeSpeakersWithText: (segments, text, duration) =>
      mergeSpeakersWithText(segments, text, duration),
    formatSpeakerTranscript: (merged) => formatSpeakerTranscript(merged),
    uploadCancelRegistry: registry,
    logDebug: () => {},
    logError: () => {},
  });

  const handlersSnapshot = new Map(activeHandlers);
  const invoke = async (channel, ...args) => {
    const handler = handlersSnapshot.get(channel);
    if (!handler) throw new Error(`No handler registered for ${channel}`);
    return handler(null, ...args);
  };
  const api = loadBundledPreload(invoke);
  return { api, registry };
}

test("all four operations cross the bundled preload boundary", async () => {
  const { api, registry } = await createFixture();

  assert.deepEqual(
    plain(
      await api.transcribeAudioFileByok({
        filePath: audioFile,
        apiKey: "sk",
        provider: "openai",
        diarize: true,
        transcriptionMode: "providers",
      })
    ),
    {
      success: true,
      diarized: true,
      segments: [{ speaker: "A", text: "hello", start: 0, end: 1 }],
      text: "[A] 0:00 - 0:01\nhello",
    }
  );

  assert.deepEqual(
    plain(await api.diarizeAudioFile(audioFile, { requestId: "d1" })),
    {
      success: true,
      segments: [{ start: 0, end: 2, speaker: "speaker_0" }],
      durationSeconds: 2,
    }
  );

  const merged = await api.mergeSpeakerText(
    [{ start: 0, end: 1, speaker: "speaker_0" }],
    "Hello.",
    2
  );
  assert.equal(merged.success, true);
  assert.equal(typeof merged.text, "string");

  // One live registration under the id: the cancel reports it and a repeat
  // is a no-op.
  registry.register("live");
  assert.deepEqual(plain(await api.cancelUploadTranscription({ requestId: "live" })), {
    success: true,
    cancelled: 1,
  });
  assert.deepEqual(plain(await api.cancelUploadTranscription({ requestId: "live" })), {
    success: true,
    cancelled: 0,
  });
});

test("failure shapes cross the boundary intact", async () => {
  const { api } = await createFixture();
  assert.deepEqual(
    plain(await api.transcribeAudioFileByok({ filePath: "/etc/hosts" })),
    { success: false, error: "File path not allowed" }
  );
  assert.deepEqual(plain(await api.diarizeAudioFile("/etc/hosts", {})), {
    success: false,
    error: "File path not allowed",
  });
  assert.deepEqual(await api.mergeSpeakerText([], "t", Number.POSITIVE_INFINITY), {
    success: false,
    error: "Invalid arguments",
  });
});

test("a junk main response rejects at the preload boundary", async () => {
  await createFixture();
  const realHandlers = new Map(activeHandlers);
  const api = loadBundledPreload(async (channel, ...args) => {
    if (channel === "transcribe-audio-file-byok") return { silentlyWrong: true };
    if (channel === "cancel-upload-transcription") return { nope: 1 };
    return realHandlers.get(channel)(null, ...args);
  });
  await assert.rejects(api.transcribeAudioFileByok({ filePath: audioFile }));
  await assert.rejects(api.cancelUploadTranscription({ requestId: "x" }));
});

test("the shared main registration registers each upload channel exactly once", async () => {
  activeHandlers = new Map();

  const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;

  const anything = () =>
    new Proxy(function () {}, {
      get: (_target, property) => {
        if (property === Symbol.toPrimitive || property === "toString") return () => "";
        if (property === "then") return undefined;
        if (property === "apply" || property === "call" || property === "bind") {
          return () => anything();
        }
        return anything();
      },
      apply: () => anything(),
    });

  const target = {};
  Ctor.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );

  for (const channel of [
    "transcribe-audio-file-byok",
    "diarize-audio-file",
    "merge-speaker-text",
    "cancel-upload-transcription",
  ]) {
    assert.equal(typeof activeHandlers.get(channel), "function", channel);
  }
});
