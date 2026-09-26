const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");

test("whisper-vad and diarization download scripts skip without network when assets exist", () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-asset-skip-"));
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
    [path.join(root, "scripts", "download-whisper-vad-model.js"), "--output-dir", path.join(outDir, "whisper-vad")],
    { encoding: "utf8", env }
  );
  assert.match(vadOut, /already exists/);

  const diarOut = execFileSync(
    process.execPath,
    [
      path.join(root, "scripts", "download-diarization-models.js"),
      "--output-dir",
      path.join(outDir, "diarization-models"),
    ],
    { encoding: "utf8", env }
  );
  assert.match(diarOut, /already exist/i);

  fs.rmSync(outDir, { recursive: true, force: true });
});

test("whisper-cpp and llama-server install checks pass from local state only", () => {
  const binDir = path.join(root, "resources", "bin");

  const whisperMarker = path.join(binDir, ".whisper-cpp-darwin-arm64.json");
  const whisperBinary = path.join(binDir, "whisper-server-darwin-arm64");
  if (fs.existsSync(whisperMarker) && fs.existsSync(whisperBinary)) {
    const { BINARIES, isCompleteInstall } = require(path.join(root, "scripts", "download-whisper-cpp.js"));
    assert.equal(
      isCompleteInstall(whisperMarker, whisperBinary, BINARIES["darwin-arm64"]),
      true,
      "existing whisper-cpp install must satisfy the completeness check"
    );
  }

  const llamaBinary = path.join(binDir, "llama-server-darwin-arm64");
  if (fs.existsSync(llamaBinary)) {
    // llama-server skips on plain file existence; assert the file the skip
    // check looks at is the one the download script would produce.
    const { BINARIES } = require(path.join(root, "scripts", "download-llama-server.js"));
    assert.equal(BINARIES["darwin-arm64"].outputName, path.basename(llamaBinary));
  }
});
