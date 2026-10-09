const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const { deduplicateOnnxruntimeLibraries } = require("../../../../scripts/afterPack.cts");

test("ONNX packaging links identical libraries and keeps different binaries", (t: import("node:test").TestContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-onnx-packaging-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const library = path.join(directory, "libonnxruntime.1.dylib");
  const duplicate = path.join(directory, "libonnxruntime.1.27.0.dylib");
  const different = path.join(directory, "libonnxruntime.1.28.0.dylib");
  fs.writeFileSync(library, "shared-library");
  fs.writeFileSync(duplicate, "shared-library");
  fs.writeFileSync(different, "different-library");
  deduplicateOnnxruntimeLibraries(directory);
  assert.equal(fs.readlinkSync(duplicate), "libonnxruntime.1.dylib");
  assert.equal(fs.readFileSync(duplicate, "utf8"), "shared-library");
  assert.equal(fs.lstatSync(different).isFile(), true);
  assert.equal(fs.readFileSync(different, "utf8"), "different-library");
  deduplicateOnnxruntimeLibraries(directory);
  assert.equal(fs.readlinkSync(duplicate), "libonnxruntime.1.dylib");
  deduplicateOnnxruntimeLibraries(path.join(directory, "missing"));
});
