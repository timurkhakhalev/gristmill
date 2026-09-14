const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Characterization for the local file transcription boundary before the
// typed cutover. Drives a real handler body double: the path validation
// rules, provider dispatch, option pass-through, every manager result
// shape (silence, truncation, invalid response, abort) and the registry
// lifecycle. Managers are fakes — no binaries run.

// Reimplements the handler flow with the real resolveAllowedAudioPath
// semantics: fs.realpathSync + allowed-dir/approved-path check. The point
// is to pin the *observable behavior* the typed module must preserve.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-transcribe-"));
const audioFile = path.join(tmpRoot, "audio.wav");
fs.writeFileSync(audioFile, "RIFF....");

const approvedAudioPaths = new Set();
// Canonicalize the allowed dirs the same way the handler module does, so
// macOS /var/folders -> /private/var/folders realpath matches.
const allowedDirs = [fs.realpathSync(tmpRoot)];

function resolveAllowedAudioPath(filePath) {
  const real = fs.realpathSync(path.resolve(filePath));
  if (approvedAudioPaths.has(real)) return real;
  if (allowedDirs.some((dir) => real === dir || real.startsWith(dir + path.sep))) {
    return real;
  }
  return null;
}

function createHarness({ whisper, parakeet, requestId } = {}) {
  const controllers = new Map();
  const registry = {
    register(id) {
      if (typeof id !== "string" || !id) return { signal: undefined, release: () => {} };
      const controller = new AbortController();
      const set = controllers.get(id) || new Set();
      set.add(controller);
      controllers.set(id, set);
      return {
        signal: controller.signal,
        release: () => set.delete(controller),
      };
    },
    cancel(id) {
      const set = controllers.get(id);
      if (!set) return 0;
      controllers.delete(id);
      for (const c of set) c.abort();
      return set.size;
    },
  };

  const calls = { whisper: [], parakeet: [], reads: [] };
  const managerCalls = { whisper: 0, parakeet: 0 };

  async function execute(realPath, options) {
    calls.reads.push(realPath);
    // Stand-in for fs.readFileSync in the shared execution module.
    if (options.__failRead) throw new Error("EACCES: read failed");
    if (isSherpaLocalProvider(options.provider)) {
      managerCalls.parakeet++;
      calls.parakeet.push(options);
      return parakeet(options);
    }
    managerCalls.whisper++;
    calls.whisper.push(options);
    return whisper(options);
  }

  async function handler(filePath, options = {}) {
    const { signal, release } = registry.register(options.requestId);
    try {
      if (typeof filePath !== "string") {
        return { success: false, error: "Invalid file path" };
      }
      const real = resolveAllowedAudioPath(filePath);
      if (!real) return { success: false, error: "File path not allowed" };
      return await execute(real, { ...options, signal });
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) {
        return { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" };
      }
      return { success: false, error: error.message };
    } finally {
      release();
    }
  }

  return { handler, calls, managerCalls, registry, controllers };
}

function isSherpaLocalProvider(provider) {
  return provider === "nvidia" || provider === "cohere";
}

const WHISPER_OK = { success: true, text: "hello world" };

test("approved path reads the file and dispatches to whisper by default", async () => {
  const harness = createHarness({
    whisper: (options) => {
      assert.equal(options.model, "base");
      assert.equal(options.language, "en");
      return WHISPER_OK;
    },
    parakeet: () => {
      throw new Error("fake: parakeet should not run");
    },
  });
  const result = await harness.handler(audioFile, { model: "base", language: "en" });
  assert.deepEqual(result, { success: true, text: "hello world" });
  assert.equal(harness.managerCalls.whisper, 1);
  assert.equal(harness.managerCalls.parakeet, 0);
  assert.match(harness.calls.reads[0], /audio\.wav$/);
});

test("nvidia and cohere providers dispatch to the sherpa stack", async () => {
  for (const provider of ["nvidia", "cohere"]) {
    const harness = createHarness({
      whisper: () => {
        throw new Error("fake: whisper should not run");
      },
      parakeet: (options) => {
        assert.equal(options.model, "parakeet-tdt-0.6b-v3");
        assert.equal(typeof options.signal, "undefined", "no requestId means no signal");
        return { success: true, text: `via ${provider}` };
      },
    });
    const result = await harness.handler(audioFile, { provider, model: "parakeet-tdt-0.6b-v3" });
    assert.deepEqual(result, { success: true, text: `via ${provider}` });
    assert.equal(harness.managerCalls.parakeet, 1);
  }
});

test("non-string and disallowed paths fail before any read", async () => {
  let reads = 0;
  const harness = createHarness({
    whisper: () => {
      reads++;
      return WHISPER_OK;
    },
  });
  assert.deepEqual(await harness.handler(12345), { success: false, error: "Invalid file path" });
  assert.deepEqual(await harness.handler(null), { success: false, error: "Invalid file path" });
  assert.deepEqual(await harness.handler("/etc/hosts"), {
    success: false,
    error: "File path not allowed",
  });
  assert.equal(reads, 0, "no manager call for rejected paths");
  assert.deepEqual(harness.calls.reads, []);
});

test("whisper failure shapes pass through unchanged", async () => {
  const noAudio = {
    whisper: () => ({ success: false, message: "No audio detected" }),
  };
  const h1 = createHarness(noAudio);
  assert.deepEqual(await h1.handler(audioFile, {}), {
    success: false,
    message: "No audio detected",
  });

  const invalid = {
    whisper: () => ({
      success: false,
      error: "invalid_response",
      message: "Transcription engine returned an unexpected response",
    }),
  };
  const h2 = createHarness(invalid);
  assert.deepEqual(await h2.handler(audioFile, {}), {
    success: false,
    error: "invalid_response",
    message: "Transcription engine returned an unexpected response",
  });
});

test("sherpa result shapes: truncated warning and NO_SPEECH_DETECTED", async () => {
  const truncated = createHarness({
    whisper: () => WHISPER_OK,
    parakeet: () => ({ success: true, text: "partial", warning: "truncated" }),
  });
  assert.deepEqual(await truncated.handler(audioFile, { provider: "nvidia" }), {
    success: true,
    text: "partial",
    warning: "truncated",
  });

  const noSpeech = createHarness({
    whisper: () => WHISPER_OK,
    parakeet: () => ({ success: false, code: "NO_SPEECH_DETECTED", message: "No audio detected" }),
  });
  assert.deepEqual(await noSpeech.handler(audioFile, { provider: "cohere" }), {
    success: false,
    code: "NO_SPEECH_DETECTED",
    message: "No audio detected",
  });
});

test("throws become error strings; abort wins with the cancelled shape", async () => {
  const throwing = createHarness({
    whisper: () => {
      throw new Error("whisper-server binary not found");
    },
  });
  assert.deepEqual(await throwing.handler(audioFile, {}), {
    success: false,
    error: "whisper-server binary not found",
  });

  const aborting = createHarness({
    whisper: (options) => {
      const error = new Error("cancelled");
      error.name = "AbortError";
      throw error;
    },
  });
  assert.deepEqual(await aborting.handler(audioFile, { requestId: "req-1" }), {
    success: false,
    error: "Cancelled",
    code: "UPLOAD_CANCELLED",
  });

});

test("requestId registers a signal; flows without one register nothing", async () => {
  const seen = [];
  const harness = createHarness({
    whisper: (options) => {
      seen.push(options.signal);
      return WHISPER_OK;
    },
  });
  await harness.handler(audioFile, { requestId: "req-a" });
  assert.ok(seen[0] instanceof AbortSignal, "signal present");

  await harness.handler(audioFile, {});
  assert.equal(seen[1], undefined, "no requestId means no signal");

  // Cancel aborts every registered controller under the id and the handler
  // maps the abort to the cancelled shape.
  let seenSignal;
  const harness2 = createHarness({
    whisper: (options) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          const error = new Error("cancelled");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });
  harness2.calls.whisper.push = (options) => (seenSignal = options);
  const pending = harness2.handler(audioFile, { requestId: "req-b" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness2.registry.cancel("req-b"), 1);
  assert.deepEqual(await pending, {
    success: false,
    error: "Cancelled",
    code: "UPLOAD_CANCELLED",
  });
});
