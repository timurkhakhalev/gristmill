const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const Module = require("node:module");

// Stub electron before any src module loads: whisperVadModel needs
// app.getPath("userData") and app.getAppPath(). The stub's getAppPath points
// at an empty resources dir, so the bundled-copy branch can never shadow the
// userData cache under test.
let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-vad-model-"));
let appPathDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-vad-app-"));

const originalLoad = Module._load;
let downloadCalls = 0;
Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return {
      app: {
        getPath: (name: string) => (name === "userData" ? userDataDir : "/tmp"),
        getAppPath: () => appPathDir,
      },
    };
  }
  if (request.endsWith("downloadUtils.js") || request.endsWith("downloadUtils.ts")) {
    const real = originalLoad.call(this, request, parent, isMain);
    return {
      ...real,
      downloadFile: async (url: string, dest: string) => {
        downloadCalls++;
        assert.match(url, /ggml-silero/);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, "downloaded-model");
        return dest;
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { ensureWhisperVadModel, resetWhisperVadModelForTests }: typeof import("../../src/helpers/whisperVadModel.ts") = require("../../src/helpers/whisperVadModel.ts");

test("ensureWhisperVadModel downloads into the userData cache when absent", async () => {
  resetWhisperVadModelForTests();
  const resolved = await ensureWhisperVadModel();
  assert.equal(resolved, path.join(userDataDir, "models", "whisper-vad", "ggml-silero-v5.1.2.bin"));
  assert.equal(fs.readFileSync(resolved, "utf8"), "downloaded-model");
});

test("ensureWhisperVadModel prefers an existing cached file without downloading", async () => {
  resetWhisperVadModelForTests();
  const cached = path.join(userDataDir, "models", "whisper-vad", "ggml-silero-v5.1.2.bin");
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.writeFileSync(cached, "cached-model");
  const before = downloadCalls;
  const resolved = await ensureWhisperVadModel();
  assert.equal(resolved, cached);
  assert.equal(fs.readFileSync(resolved, "utf8"), "cached-model");
  assert.equal(downloadCalls, before);
});

test("ensureWhisperVadModel returns the bundled copy when resources ship it", async () => {
  resetWhisperVadModelForTests();
  const bundledDir = path.join(appPathDir, "resources", "bin", "whisper-vad");
  fs.mkdirSync(bundledDir, { recursive: true });
  fs.writeFileSync(path.join(bundledDir, "ggml-silero-v5.1.2.bin"), "bundled-model");

  const resolved = await ensureWhisperVadModel();
  assert.equal(resolved, path.join(bundledDir, "ggml-silero-v5.1.2.bin"));
});

test.after(() => {
  Module._load = originalLoad;
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(appPathDir, { recursive: true, force: true });
});
