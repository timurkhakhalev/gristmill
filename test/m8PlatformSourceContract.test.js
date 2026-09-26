const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

test("M8 packaging exposes only the macOS Apple Silicon target", () => {
  const builder = readJson("electron-builder.json");
  assert.equal("win" in builder, false);
  assert.equal("linux" in builder, false);
  assert.deepEqual(builder.mac.target, [
    { target: "dmg", arch: ["arm64"] },
    { target: "zip", arch: ["arm64"] },
  ]);
});

test("M8 package scripts do not download removed products or platform artifacts", () => {
  const pkg = readJson("package.json");
  const scripts = Object.keys(pkg.scripts);
  assert.equal(scripts.some((name) => /(?:win|linux|x64)/i.test(name)), false);
  assert.equal(
    Object.values(pkg.scripts).some((command) => /(?:yt-dlp|qdrant|minilm|embedding-model|brand-font)/i.test(command)),
    false
  );
  for (const dependency of ["@better-auth/sso", "better-auth", "@qdrant/js-client-rest", "electron-updater"]) {
    assert.equal(dependency in pkg.dependencies, false, dependency);
  }
});

test("M8 keeps required macOS runtime resources in the builder filter", () => {
  const builder = readJson("electron-builder.json");
  const filter = builder.extraResources.find((entry) => entry.from === "resources/bin/").filter;
  for (const resource of ["whisper-cpp-*", "llama-server-*", "sherpa-onnx-*"]) {
    assert.ok(filter.includes(resource), resource);
  }
});

test("issue #89 keeps model assets out of the packaged resources", () => {
  const builder = readJson("electron-builder.json");
  const filter = builder.extraResources.find((entry) => entry.from === "resources/bin/").filter;
  for (const modelAsset of ["diarization-models/**/*", "whisper-vad/**/*"]) {
    assert.ok(!filter.includes(modelAsset), modelAsset);
  }
});
