// The typed transcribe-audio-file handler after the cutover: real path
// resolution over a temp dir, fake managers, real shared cancel registry.
// Pins path rejection before reads, the cancelled shape, cleanup release on
// success/throw/abort and per-operation result validation.
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test") = require("node:test");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const Module = require("node:module");
import { transcriptionResponseSchema } from "../../src/contracts/localFileTranscription.ts";

let registerLocalFileTranscriptionHandler: typeof import("../../src/helpers/localFileTranscriptionIpcHandler.ts").registerLocalFileTranscriptionHandler;
let createUploadCancelRegistry: typeof import("../../src/helpers/uploadCancelRegistry.ts").createUploadCancelRegistry;

test.before(async () => {
  ({ registerLocalFileTranscriptionHandler } = await import(
    "../../src/helpers/localFileTranscriptionIpcHandler.ts"
  ));
  ({ createUploadCancelRegistry } = await import("../../src/helpers/uploadCancelRegistry.ts"));
});

test.after(() => {
  Module._load = originalLoad;
});

const originalLoad = Module._load;
Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return {
      app: { getPath: () => "/tmp", getAppPath: () => process.cwd(), isReady: () => false },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-transcribe-typed-")));
const audioFile = path.join(tmpRoot, "audio.wav");
fs.writeFileSync(audioFile, "RIFF....");

const logs: { debug: { message: string; data?: unknown }[]; error: { message: string; data?: unknown }[] } = { debug: [], error: [] };

function optionsRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function setup({ whisper, parakeet }: {
  whisper?: (audioBuffer: Buffer, options: Record<string, unknown>) => unknown;
  parakeet?: (audioBuffer: Buffer, options: Record<string, unknown>) => unknown;
} = {}) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const registry = createUploadCancelRegistry();
  const calls: {
    whisper: { audioBuffer: Buffer; options: Record<string, unknown> }[];
    parakeet: { audioBuffer: Buffer; options: Record<string, unknown> }[];
    reads: string[];
  } = { whisper: [], parakeet: [], reads: [] };
  registerLocalFileTranscriptionHandler(
    { handle: (channel, fn) => { handlers.set(channel, fn); } },
    {
      readFile: (filePath: string) => {
        calls.reads.push(filePath);
        return fs.readFileSync(filePath);
      },
      resolveAllowedAudioPath: (filePath: string) => {
        try {
          const real = fs.realpathSync(path.resolve(filePath));
          return real.startsWith(tmpRoot + path.sep) ? real : null;
        } catch {
          return null;
        }
      },
      isSherpaLocalProvider: (provider) => provider === "nvidia" || provider === "cohere",
      transcribeLocalWhisper: async (audioBuffer, options) => {
        const parsedOptions = optionsRecord(options);
        calls.whisper.push({ audioBuffer, options: parsedOptions });
        return whisper ? whisper(audioBuffer, parsedOptions) : { success: true, text: "whisper text" };
      },
      transcribeLocalParakeet: async (audioBuffer, options) => {
        const parsedOptions = optionsRecord(options);
        calls.parakeet.push({ audioBuffer, options: parsedOptions });
        return parakeet ? parakeet(audioBuffer, parsedOptions) : { success: true, text: "sherpa text" };
      },
      resolveWhisperVadOptions: (context: unknown) => ({ vadEnabled: context === "noteRecording" }),
      uploadCancelRegistry: registry,
      logDebug: (message, data) => { logs.debug.push({ message, data }); },
      logError: (message, data) => { logs.error.push({ message, data }); },
    }
  );
  const call = async (...args: unknown[]) => {
    const handler = handlers.get("transcribe-audio-file");
    if (!handler) throw new Error("Transcription handler was not registered");
    return transcriptionResponseSchema.parse(await handler(null, ...args));
  };
  return { call, calls, registry };
}

test("happy path: whisper dispatch with VAD merge, result validated", async () => {
  const { call, calls } = setup({
    whisper: (_buffer, options) => ({ success: true, text: "hello", model: options.model }),
  });
  const result = await call(audioFile, { model: "base", language: "en", requestId: "r1" });
  assert.equal(result.success, true);
  assert.equal(result.text, "hello");
  assert.equal(calls.whisper[0].options.vadEnabled, true, "noteRecording VAD merged in");
  assert.equal(calls.whisper[0].options.model, "base");
  assert.equal(calls.whisper[0].options.language, "en");
  assert.equal(calls.whisper[0].options.requestId, "r1");
  assert.ok(calls.reads[0].endsWith("audio.wav"));
  assert.ok(Buffer.isBuffer(calls.whisper[0].audioBuffer));
});

test("nvidia/cohere dispatch to sherpa, with a signal only when requestId is present", async () => {
  for (const provider of ["nvidia", "cohere"]) {
    const { call, calls } = setup({
      parakeet: (_buffer, options) => ({ success: true, text: options.model }),
    });
    const result = await call(audioFile, { provider, model: "parakeet-tdt-0.6b-v3" });
    assert.deepEqual(result, { success: true, text: "parakeet-tdt-0.6b-v3" });
    assert.equal(calls.parakeet[0].options.signal, undefined);
    assert.equal(calls.whisper.length, 0);
    await call(audioFile, { provider, requestId: "r2" });
    assert.ok(calls.parakeet[1].options.signal instanceof AbortSignal);
    assert.equal(calls.whisper.length, 0);
  }
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

  const noSpeech = setup({
    parakeet: () => ({ success: false, code: "NO_SPEECH_DETECTED", message: "No audio detected" }),
  });
  assert.deepEqual(await noSpeech.call(audioFile, { provider: "cohere" }), {
    success: false,
    code: "NO_SPEECH_DETECTED",
    message: "No audio detected",
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
  assert.equal(registry.cancel("req-x"), 0, "controller released");
});

test("shared registry cancels a pending real handler and leaves no registration", async () => {
  let signal: AbortSignal | undefined;
  const { call, registry } = setup({
    whisper: (_buffer, options) => {
      const abortSignal = options.signal;
      assert.ok(abortSignal instanceof AbortSignal);
      signal = abortSignal;
      return new Promise((_resolve, reject) => {
        abortSignal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })));
      });
    },
  });
  const pending = call(audioFile, { requestId: "pending-1", language: "en" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(signal instanceof AbortSignal);
  assert.equal(registry.cancel("pending-1"), 1);
  assert.deepEqual(await pending, { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" });
  assert.equal(registry.cancel("pending-1"), 0);
});

test("a junk manager result becomes an error result, never a fake success", async () => {
  const junk = setup({ whisper: () => ({ success: "yes" }) });
  const result = await junk.call(audioFile, {});
  assert.equal(result.success, false, "junk never masquerades as success");
  assert.equal(result.text, undefined);
});
