// The typed transcribe-audio-file handler after the cutover: real path
// resolution over a temp dir, fake managers, real shared cancel registry.
// Pins path rejection before reads, the cancelled shape, cleanup release on
// success/throw/abort and per-operation result validation.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let registerLocalFileTranscriptionHandler;

test.before(async () => {
  ({ registerLocalFileTranscriptionHandler } = await import(
    "../../src/helpers/localFileTranscriptionIpcHandler.ts"
  ));
});

test.after(() => {
  Module._load = originalLoad;
});

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => "/tmp", getAppPath: () => process.cwd(), isReady: () => false },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-transcribe-typed-")));
const audioFile = path.join(tmpRoot, "audio.wav");
fs.writeFileSync(audioFile, "RIFF....");

function createRegistry() {
  const controllers = new Map();
  return {
    controllers,
    register(id) {
      if (typeof id !== "string" || !id) return { signal: undefined, release: () => {} };
      let set = controllers.get(id);
      if (!set) {
        set = new Set();
        controllers.set(id, set);
      }
      const controller = new AbortController();
      set.add(controller);
      return {
        signal: controller.signal,
        release: () => set.delete(controller),
      };
    },
  };
}

const logs = { debug: [], error: [] };

function setup({ whisper, parakeet } = {}) {
  const handlers = new Map();
  const registry = createRegistry();
  const calls = { whisper: [], parakeet: [], reads: [] };
  registerLocalFileTranscriptionHandler(
    { handle: (channel, fn) => handlers.set(channel, fn) },
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
      transcribeLocalWhisper: async (audioBuffer, options) => {
        calls.whisper.push({ audioBuffer, options });
        return whisper ? whisper(audioBuffer, options) : { success: true, text: "whisper text" };
      },
      transcribeLocalParakeet: async (audioBuffer, options) => {
        calls.parakeet.push({ audioBuffer, options });
        return parakeet ? parakeet(audioBuffer, options) : { success: true, text: "sherpa text" };
      },
      resolveWhisperVadOptions: (context) => ({ vadEnabled: context === "noteRecording" }),
      uploadCancelRegistry: registry,
      logDebug: (message, data) => logs.debug.push({ message, data }),
      logError: (message, data) => logs.error.push({ message, data }),
    }
  );
  const call = (...args) => handlers.get("transcribe-audio-file")(null, ...args);
  return { call, calls, registry };
}

test("happy path: whisper dispatch with VAD merge, result validated", async () => {
  const { call, calls } = setup({
    whisper: (_buffer, options) => ({ success: true, text: "hello", model: options.model }),
  });
  const result = await call(audioFile, { model: "base", requestId: "r1" });
  assert.equal(result.success, true);
  assert.equal(result.text, "hello");
  assert.equal(calls.whisper[0].options.vadEnabled, true, "noteRecording VAD merged in");
  assert.equal(calls.whisper[0].options.model, "base");
  assert.equal(calls.whisper[0].options.requestId, "r1");
  assert.ok(calls.reads[0].endsWith("audio.wav"));
  assert.ok(Buffer.isBuffer(calls.whisper[0].audioBuffer));
});

test("nvidia/cohere dispatch to sherpa with the signal, whisper options untouched", async () => {
  const { call, calls } = setup({
    parakeet: () => ({ success: true, text: "sherpa" }),
  });
  const result = await call(audioFile, { provider: "nvidia", requestId: "r2" });
  assert.deepEqual(result, { success: true, text: "sherpa" });
  assert.ok(calls.parakeet[0].options.signal instanceof AbortSignal);
  assert.equal(calls.whisper.length, 0);
});

test("options omitted or undefined default to empty; explicit null rejects", async () => {
  const { call, calls } = setup();
  // undefined reaches the manager as an empty options object.
  assert.deepEqual(await call(audioFile), { success: true, text: "whisper text" });
  assert.equal(calls.whisper[0].options.requestId, undefined);
  // An explicit null must keep the old TypeError path: it fails before any
  // read or manager call, never as an accepted empty config.
  let thrown = false;
  try {
    await call(audioFile, null);
  } catch {
    thrown = true;
  }
  assert.equal(thrown, true, "null options throw like the pre-cutover handler");
  assert.equal(calls.reads.length, 1, "no additional read for the null call");
  assert.equal(calls.whisper.length, 1, "no manager call for the null call");
});

test("path checks reject before any read", async () => {
  const { call, calls } = setup();
  assert.deepEqual(await call(12345, {}), { success: false, error: "Invalid file path" });
  assert.deepEqual(await call(null), { success: false, error: "Invalid file path" });
  assert.deepEqual(await call("/etc/hosts", {}), { success: false, error: "File path not allowed" });
  assert.deepEqual(await call("./missing.wav", {}), { success: false, error: "File path not allowed" });
  assert.deepEqual(calls.reads, []);
});

test("failure shapes survive validation; throws map to error strings", async () => {
  const noAudio = setup({
    whisper: () => ({ success: false, message: "No audio detected" }),
  });
  assert.deepEqual(await noAudio.call(audioFile, {}), {
    success: false,
    message: "No audio detected",
  });

  const invalid = setup({
    whisper: () => ({ success: false, error: "invalid_response", message: "bad engine output" }),
  });
  assert.deepEqual(await invalid.call(audioFile, {}), {
    success: false,
    error: "invalid_response",
    message: "bad engine output",
  });

  const truncated = setup({
    parakeet: () => ({ success: true, text: "partial", warning: "truncated" }),
  });
  assert.deepEqual(await truncated.call(audioFile, { provider: "cohere" }), {
    success: true,
    text: "partial",
    warning: "truncated",
  });

  const throwing = setup({
    whisper: () => {
      throw new Error("whisper-server binary not found");
    },
  });
  assert.deepEqual(await throwing.call(audioFile, {}), {
    success: false,
    error: "whisper-server binary not found",
  });
});

test("abort maps to the cancelled shape and release always runs", async () => {
  const { call, registry } = setup({
    whisper: () =>
      new Promise((_resolve, reject) => {
        const error = new Error("cancelled");
        error.name = "AbortError";
        reject(error);
      }),
  });
  assert.deepEqual(await call(audioFile, { requestId: "req-x" }), {
    success: false,
    error: "Cancelled",
    code: "UPLOAD_CANCELLED",
  });
  const releasedSet = registry.controllers.get("req-x");
  assert.ok(!releasedSet || releasedSet.size === 0, "controller released");
});

test("a junk manager result becomes an error result, never a fake success", async () => {
  const junk = setup({ whisper: () => ({ success: "yes" }) });
  const result = await junk.call(audioFile, {});
  assert.equal(result.success, false, "junk never masquerades as success");
  assert.equal(result.text, undefined);
});
