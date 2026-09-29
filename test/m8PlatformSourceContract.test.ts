const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");

const root = path.join(__dirname, "..");
const readJson = (file: string): Record<string, any> => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

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
  assert.equal(scripts.some((name: string) => /(?:win|linux|x64)/i.test(name)), false);
  assert.equal(
    (Object.values(pkg.scripts) as string[]).some((command: string) => /(?:yt-dlp|qdrant|minilm|embedding-model|brand-font)/i.test(command)),
    false
  );
  for (const dependency of ["@better-auth/sso", "better-auth", "@qdrant/js-client-rest", "electron-updater"]) {
    assert.equal(dependency in pkg.dependencies, false, dependency);
  }
});

test("local inference engines are absent from the package until explicitly selected", () => {
  const builder = readJson("electron-builder.json");
  const pkg = readJson("package.json");
  const filter = (builder.extraResources as Array<{ from: string; filter: string[] }>).find((entry: { from: string }) => entry.from === "resources/bin/")!.filter;
  for (const resource of ["whisper-cpp-*", "whisper-server-*", "llama-server-*", "sherpa-onnx-*", "*.dylib"]) {
    assert.ok(!filter.includes(resource), resource);
  }
  assert.ok((builder.extraResources as Array<{ from: string }>).some((entry) => entry.from === "resources/local-engine-installers/"));
  assert.doesNotMatch(pkg.scripts["prebuild:mac:arm64"], /download:/);
});

test("issue #89 keeps model assets out of the packaged resources", () => {
  const builder = readJson("electron-builder.json");
  const filter = (builder.extraResources as Array<{ from: string; filter: string[] }>).find((entry: { from: string }) => entry.from === "resources/bin/")!.filter;
  for (const modelAsset of ["diarization-models/**/*", "whisper-vad/**/*"]) {
    assert.ok(!filter.includes(modelAsset), modelAsset);
  }
});
