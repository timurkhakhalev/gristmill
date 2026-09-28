const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const { execFileSync }: typeof import("node:child_process") = require("node:child_process");

const root = path.resolve(__dirname, "../..");

test("whisper-vad and diarization scripts skip complete synthetic assets without network", (t: import("node:test").TestContext) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-asset-skip-"));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const networkGuard = path.join(outDir, "no-network.cjs");
  fs.writeFileSync(networkGuard, `
    global.fetch = () => { throw new Error("unexpected network request"); };
    for (const protocol of ["node:http", "node:https"]) {
      const client = require(protocol);
      client.get = client.request = () => { throw new Error("unexpected network request"); };
    }
  `);
  fs.mkdirSync(path.join(outDir, "whisper-vad"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "whisper-vad", "ggml-silero-v5.1.2.bin"), "x");
  fs.mkdirSync(path.join(outDir, "diarization-models", "sherpa-onnx-pyannote-segmentation-3-0"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(outDir, "diarization-models", "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx"),
    "x"
  );
  fs.writeFileSync(
    path.join(
      outDir,
      "diarization-models",
      "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx"
    ),
    "x"
  );
  fs.writeFileSync(path.join(outDir, "diarization-models", "silero_vad.onnx"), "x");

  const env = {
    ...process.env,
    DIARIZATION_MODEL_DIR: path.join(outDir, "diarization-models"),
  };

  const vadOut = execFileSync(
    process.execPath,
    ["--require", networkGuard, path.join(root, "scripts", "download-whisper-vad-model.js"), "--output-dir", path.join(outDir, "whisper-vad")],
    { encoding: "utf8", env }
  );
  assert.match(vadOut, /already exists/);

  const diarOut = execFileSync(
    process.execPath,
    [
      "--require",
      networkGuard,
      path.join(root, "scripts", "download-diarization-models.js"),
      "--output-dir",
      path.join(outDir, "diarization-models"),
    ],
    { encoding: "utf8", env }
  );
  assert.match(diarOut, /already exist/i);
});

test("whisper-cpp detects a complete synthetic install", (t: import("node:test").TestContext) => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-whisper-install-"));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
  const { BINARIES, WHISPER_CPP_TAG, isCompleteInstall }: {
    BINARIES: Record<"darwin-arm64", { outputName: string }>;
    WHISPER_CPP_TAG: string;
    isCompleteInstall(markerPath: string, binaryPath: string, config: { outputName: string }): boolean;
  } = require(path.join(root, "scripts", "download-whisper-cpp.js"));
  const config = BINARIES["darwin-arm64"];
  const marker = path.join(binDir, ".whisper-cpp-darwin-arm64.json");
  const binary = path.join(binDir, config.outputName);
  fs.writeFileSync(binary, "synthetic-binary");
  fs.writeFileSync(marker, JSON.stringify({ version: WHISPER_CPP_TAG, libraries: [] }));
  assert.equal(isCompleteInstall(marker, binary, config), true);
  fs.rmSync(binary);
  assert.equal(isCompleteInstall(marker, binary, config), false);
});
