// The real bundled preload talks to the real typed transcription handler
// over fake managers (no binaries): full response shapes crossing the wire,
// path rejection, the cancelled shape, and the shared main registration
// duplicate-channel guard.
const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const vm: typeof import("node:vm") = require("node:vm");
const Module = require("node:module");

const root = path.resolve(__dirname, "../..");
const bundledPreload = path.join(root, "dist-main", "preload.js");

let activeHandlers: Map<string, (...args: unknown[]) => unknown> | null = null;
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-transcribe-bridge-"));
const originalNodeEnv = process.env.NODE_ENV;

const originalLoad = Module._load;
Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return {
      app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false },
      ipcMain: {
        handle: (channel: string, listener: any) => {
          if (!activeHandlers) activeHandlers = new Map();
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
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function loadBundledPreload(invoke: unknown) {
  let api: Record<string, any> | undefined;
  vm.runInNewContext(fs.readFileSync(bundledPreload, "utf8"), {
    // The bundle keeps CJS interop for hybrid manifest modules, so the
    // sandbox needs the same bindings Node's CJS loader provides.
    module: { exports: {} },
    exports: {},
    require(name: string) {
      assert.equal(name, "electron", "the bundled preload must only require electron");
      return {
        contextBridge: {
          exposeInMainWorld: (_name: string, value: any) => {
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
  if (!api) throw new Error("Bundled preload did not expose its API");
  return api;
}

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-transcribe-bridge-")));
const audioFile = path.join(tmpRoot, "audio.wav");
fs.writeFileSync(audioFile, "RIFF....");

// Objects from vm.runInNewContext have a different prototype; compare by JSON.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

async function createFixture(t: import("node:test").TestContext, managers: {
  whisper?: (...args: unknown[]) => unknown;
  parakeet?: (...args: unknown[]) => unknown;
} = {}) {
  activeHandlers = new Map();
  t.after(() => { activeHandlers = null; });

  const calls : any = { whisper: [], parakeet: [], reads: [] };
  const { registerLocalFileTranscriptionHandler } = await import(
    "../../src/helpers/localFileTranscriptionIpcHandler.ts"
  );
  const { createUploadCancelRegistry } = await import("../../src/helpers/uploadCancelRegistry.ts");
  registerLocalFileTranscriptionHandler(
    { handle: (channel, listener) => activeHandlers!.set(channel, listener) },
    {
      readFile: (filePath) => {
        calls.reads.push(filePath);
        return fs.readFileSync(filePath);
      },
      resolveAllowedAudioPath: (filePath) => {
        try {
          const real = fs.realpathSync(path.resolve(filePath));
          return real.startsWith(tmpRoot + path.sep) ? real : null;
        } catch {
          return null;
        }
      },
      isSherpaLocalProvider: (provider) => provider === "nvidia" || provider === "cohere",
      transcribeLocalWhisper: async (audioBuffer, options) =>
        managers.whisper ? managers.whisper(audioBuffer, options) : { success: true, text: "w" },
      transcribeLocalParakeet: async (audioBuffer, options) =>
        managers.parakeet ? managers.parakeet(audioBuffer, options) : { success: true, text: "s" },
      resolveWhisperVadOptions: (context) => ({ vadEnabled: context === "noteRecording" }),
      uploadCancelRegistry: createUploadCancelRegistry(),
      logDebug: () => {},
      logError: () => {},
    }
  );

  const handlersSnapshot = new Map(activeHandlers);
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlersSnapshot.get(channel);
    if (!handler) throw new Error(`No handler registered for ${channel}`);
    return handler(null, ...args);
  };
  const api = loadBundledPreload(invoke);
  return { api, calls };
}

test("full response shapes cross the bundled preload boundary", async (t: import("node:test").TestContext) => {
  let ctx = await createFixture(t, {
    whisper: () => ({ success: true, text: "whisper text" }),
  });
  if (!ctx) return;
  assert.deepEqual(plain(await ctx.api.transcribeAudioFile(audioFile, { model: "base" })), {
    success: true,
    text: "whisper text",
  });

  // A fresh fixture per shape keeps manager results isolated.
  ctx = await createFixture(t, {
    parakeet: () => ({ success: true, text: "partial", warning: "truncated" }),
  });
  assert.deepEqual(
    plain(await ctx.api.transcribeAudioFile(audioFile, { provider: "nvidia" })),
    { success: true, text: "partial", warning: "truncated" }
  );

  ctx = await createFixture(t, {
    whisper: () => ({ success: false, message: "No audio detected" }),
  });
  assert.deepEqual(plain(await ctx.api.transcribeAudioFile(audioFile, {})), {
    success: false,
    message: "No audio detected",
  });

  ctx = await createFixture(t, {
    parakeet: () => ({ success: false, code: "NO_SPEECH_DETECTED", message: "No audio detected" }),
  });
  assert.deepEqual(plain(await ctx.api.transcribeAudioFile(audioFile, { provider: "cohere" })), {
    success: false,
    code: "NO_SPEECH_DETECTED",
    message: "No audio detected",
  });

  ctx = await createFixture(t, {
    whisper: () => ({ success: false, error: "invalid_response", message: "bad" }),
  });
  assert.deepEqual(plain(await ctx.api.transcribeAudioFile(audioFile, {})), {
    success: false,
    error: "invalid_response",
    message: "bad",
  });
});

test("path rejection and the cancelled shape through the bridge", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { api } = ctx;

  assert.deepEqual(plain(await api.transcribeAudioFile("/etc/hosts")), {
    success: false,
    error: "File path not allowed",
  });
  assert.deepEqual(plain(await api.transcribeAudioFile(12345)), {
    success: false,
    error: "Invalid file path",
  });

  const aborting = await createFixture(t, {
    whisper: () =>
      new Promise((_resolve, reject) => {
        const error = new Error("cancelled");
        error.name = "AbortError";
        reject(error);
      }),
  });
  assert.deepEqual(
    plain(await aborting.api.transcribeAudioFile(audioFile, { requestId: "r9" })),
    {
      success: false,
      error: "Cancelled",
      code: "UPLOAD_CANCELLED",
    }
  );
});

test("a junk main response rejects at the preload boundary", async (t: import("node:test").TestContext) => {
  await createFixture(t);
  const realHandler = activeHandlers?.get("transcribe-audio-file");
  if (!realHandler) {
    return t.skip("handler missing");
  }
  const api = loadBundledPreload(async (channel: string, ...args: unknown[]) => {
    if (channel === "transcribe-audio-file") return { silentlyWrong: true };
    return realHandler(null, ...args);
  });
  await assert.rejects(api.transcribeAudioFile(audioFile, {}));
});

test("the shared main registration registers the transcription channel once", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);
  if (!ctx) return;

  activeHandlers = new Map();

  const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
  delete require.cache[handlersModulePath];
  const Ctor: typeof import("../../src/helpers/ipcHandlers.ts").IPCHandlers = require(handlersModulePath);

  const anything = (): unknown =>
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

  const target: Record<PropertyKey, unknown> = {
    databaseManager: {
      recoverRunningMeetingProcessingRuns: () => 0,
      listAllMeetingProcessingRuns: () => [],
    },
  };
  Ctor.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );

  assert.equal(typeof activeHandlers.get("transcribe-audio-file"), "function");
});
