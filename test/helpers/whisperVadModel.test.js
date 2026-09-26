const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// Stub electron before any src module loads: whisperVadModel needs
// app.getPath("userData") and app.getAppPath(). The stub's getAppPath points
// at an empty resources dir, so the bundled-copy branch can never shadow the
// userData cache under test.
let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-vad-model-"));
let appPathDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-vad-app-"));

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: (name) => (name === "userData" ? userDataDir : "/tmp"),
        getAppPath: () => appPathDir,
      },
    };
  }
  if (request.endsWith("downloadUtils.js") || request.endsWith("downloadUtils.ts")) {
    const real = originalLoad.call(this, request, parent, isMain);
    return {
      ...real,
      downloadFile: async (url, dest) => {
        assert.match(url, /ggml-silero/);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, "downloaded-model");
        return dest;
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { ensureWhisperVadModel, resetWhisperVadModelForTests } = require("../../src/helpers/whisperVadModel.ts");

test("ensureWhisperVadModel downloads into the userData cache when absent", async () => {
  resetWhisperVadModelForTests();
  const resolved = await ensureWhisperVadModel();
  assert.equal(resolved, path.join(userDataDir, "models", "whisper-vad", "ggml-silero-v5.1.2.bin"));
  assert.equal(fs.readFileSync(resolved, "utf8"), "downloaded-model");
});

test("ensureWhisperVadModel prefers an existing cached file without downloading", async () => {
  resetWhisperVadModelForTests();
  const resolved = await ensureWhisperVadModel();
  assert.equal(fs.readFileSync(resolved, "utf8"), "downloaded-model");
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
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(appPathDir, { recursive: true, force: true });
});
