import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
const { cachedBuild, outputs, cacheOutputs, archiveName }: import("../../../../scripts/lib/build-meeting-resampler.cts").API = require("../../../../scripts/lib/build-meeting-resampler.cts");
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture(t: import("node:test").TestContext) {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-resampler-cache-"));
  t.after(() => fs.rmSync(cacheRoot, { recursive: true, force: true }));
  let downloads = 0, builds = 0;
  let archive = "verified-source";
  const inputs = { checksum: digest(archive), flags: ["--enable-shared"], compiler: "clang-one", architecture: "arm64", deploymentTarget: "12.0", helperHash: "helper", recipeHash: "recipe", helperFlags: ["-Wall"] };
  const options = {
    cacheRoot, inputs,
    download(destination: string) { downloads++; fs.writeFileSync(destination, archive); },
    build(source: string, directory: string) {
      builds++; assert.equal(digest(fs.readFileSync(source, "utf8")), options.inputs.checksum);
      for (const name of cacheOutputs) fs.writeFileSync(path.join(directory, name), `compiled-${builds}-${name}`);
    },
  };
  return { options, counts: () => ({ downloads, builds }), source(value: string) { archive = value; options.inputs.checksum = digest(value); } };
}
test("unchanged verified cache reuses outputs without download/compiler calls", t => {
  const { options, counts } = fixture(t);
  assert.equal(cachedBuild(options).reused, false);
  const before = counts();
  assert.equal(cachedBuild(options).reused, true);
  assert.deepEqual(counts(), before);
});
for (const field of ["checksum", "flags", "compiler", "architecture", "deploymentTarget", "helperHash", "recipeHash", "helperFlags"] as const)
  test(`${field} invalidates cached native output`, t => {
    const { options, counts, source } = fixture(t);
    const first = cachedBuild(options);
    if (field === "checksum") source("new-verified-source");
    else if (field === "flags" || field === "helperFlags") options.inputs[field] = ["--different-flags"];
    else options.inputs[field] = "changed";
    const next = cachedBuild(options);
    assert.notEqual(first.directory, next.directory); assert.equal(next.reused, false);
    assert.equal(counts().builds, 2);
  });
test("corrupt archive is verified again and corrupt output cannot be reused", t => {
  const { options, counts } = fixture(t);
  const first = cachedBuild(options);
  fs.writeFileSync(path.join(options.cacheRoot, archiveName), "corrupt");
  assert.equal(cachedBuild(options).reused, true);
  assert.equal(counts().downloads, 2);
  fs.writeFileSync(path.join(first.directory, outputs[0]), "corrupt");
  assert.equal(cachedBuild(options).reused, false);
  assert.equal(counts().builds, 2);
});
test("complete cache succeeds offline while missing or corrupt source fails clearly", t => {
  const { options, counts } = fixture(t);
  cachedBuild(options);
  const before = counts();
  options.download = () => { throw new Error("offline: network denied"); };
  assert.equal(cachedBuild(options).reused, true);
  assert.deepEqual(counts(), before);
  fs.rmSync(path.join(options.cacheRoot, archiveName));
  assert.throws(() => cachedBuild(options), /verified pinned source archive.*offline/);
  assert.deepEqual(counts(), before);
  fs.writeFileSync(path.join(options.cacheRoot, archiveName), "corrupt");
  assert.throws(() => cachedBuild(options), /verified pinned source archive/);
});
test("missing source offline and bad download/build never publish a valid cache entry", t => {
  const { options } = fixture(t);
  options.download = () => { throw new Error("offline"); };
  assert.throws(() => cachedBuild(options), /unavailable offline/);
  assert.deepEqual(fs.readdirSync(options.cacheRoot), []);
  options.download = destination => fs.writeFileSync(destination, "bad archive");
  assert.throws(() => cachedBuild(options), /checksum mismatch/);
  assert.deepEqual(fs.readdirSync(options.cacheRoot), []);
  options.download = destination => fs.writeFileSync(destination, "verified-source");
  options.build = (_source, directory) => fs.writeFileSync(path.join(directory, outputs[0]), "only-helper");
  assert.throws(() => cachedBuild(options));
  assert.deepEqual(fs.readdirSync(options.cacheRoot), [archiveName]);
});
