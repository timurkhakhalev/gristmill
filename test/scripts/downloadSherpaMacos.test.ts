const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs = require("fs");

const path = require("path");

const sherpaDownloader = require("../../scripts/download-sherpa-onnx.cts");

const UNIVERSAL_VTOOL_OUTPUT = `
/tmp/libonnxruntime.1.27.0.dylib (architecture x86_64):
Load command 10
      cmd LC_BUILD_VERSION
 platform MACOS
    minos 15.5
    sdk 15.5
/tmp/libonnxruntime.1.27.0.dylib (architecture arm64):
Load command 10
      cmd LC_BUILD_VERSION
 platform MACOS
    minos 15.5
    sdk 15.5
`;

test("the sherpa downloader exposes only the macOS Apple Silicon target", () => {
  assert.deepEqual(Object.keys(sherpaDownloader.BINARIES), ["darwin-arm64"]);
  assert.equal(sherpaDownloader.BINARIES["darwin-arm64"].outputName, "sherpa-onnx-ws-darwin-arm64");
});

test("parses deployment targets for both ONNX Runtime architecture slices", () => {
  assert.deepEqual(sherpaDownloader.parseMacosDeploymentTargets(UNIVERSAL_VTOOL_OUTPUT), [
    { architecture: "x86_64", minimumVersion: "15.5" },
    { architecture: "arm64", minimumVersion: "15.5" },
  ]);
});

test("accepts a universal ONNX Runtime library matching the runtime capability gate", () => {
  assert.deepEqual(
    sherpaDownloader.validateMacosDeploymentTargets([
      { architecture: "x86_64", minimumVersion: "15.5" },
      { architecture: "arm64", minimumVersion: "15.5" },
    ]),
    { architectures: ["x86_64", "arm64"], minimumVersion: "15.5" }
  );
});

test("rejects a packaged ONNX Runtime library missing a universal architecture slice", () => {
  assert.throws(
    () =>
      sherpaDownloader.validateMacosDeploymentTargets([
        { architecture: "arm64", minimumVersion: "15.5" },
      ]),
    /missing required architecture: x86_64/
  );
});

test("validates the versioned ONNX Runtime library from a packaged app", () => {
  const appPath = "/tmp/Gristmill.app";
  assert.deepEqual(
    sherpaDownloader.verifyPackagedMacosParakeet(appPath, {
      readDirectory: () => ["libonnxruntime.dylib", "libonnxruntime.1.27.0.dylib"],
      runVtool: () => UNIVERSAL_VTOOL_OUTPUT,
    }),
    {
      architectures: ["x86_64", "arm64"],
      libraryPath: `${appPath}/Contents/Resources/bin/libonnxruntime.1.27.0.dylib`,
      minimumVersion: "15.5",
    }
  );
});

test("macOS install marker requires the arm64 ONNX Runtime replacement", (t: import("node:test").TestContext) => {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "sherpa-macos-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binary = path.join(dir, "sherpa-onnx-ws-darwin-arm64");
  const marker = path.join(dir, ".sherpa-onnx-darwin-arm64.json");
  fs.writeFileSync(binary, "binary");
  fs.writeFileSync(
    marker,
    JSON.stringify({ version: sherpaDownloader.SHERPA_ONNX_VERSION, libraries: [] })
  );
  assert.equal(
    sherpaDownloader.isCompleteInstall(marker, [binary], {
      platformArch: "darwin-arm64",
      binDir: dir,
    }),
    false
  );
  fs.writeFileSync(
    marker,
    JSON.stringify({
      version: sherpaDownloader.SHERPA_ONNX_VERSION,
      libraries: [],
      onnxRuntime: sherpaDownloader.MACOS_ARM64_ONNXRUNTIME.marker,
    })
  );
  assert.equal(
    sherpaDownloader.isCompleteInstall(marker, [binary], {
      platformArch: "darwin-arm64",
      binDir: dir,
    }),
    true
  );
});
