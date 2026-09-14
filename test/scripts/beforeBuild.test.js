const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("packaging rebuilds native modules even after Node tests replaced the binary", async () => {
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../scripts/beforeBuild.js"), "utf8"), {
    module,
    require(name) {
      if (name === "@electron/rebuild") return { rebuild: async (options) => calls.push(options) };
      if (name === "electron/package.json") return { version: "41.10.5" };
      throw new Error(name);
    },
  });
  const result = await module.exports({ appDir: "/app", platform: { nodeName: "darwin" }, arch: "arm64" });
  assert.equal(result, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{
    buildPath: "/app", electronVersion: "41.10.5", platform: "darwin", arch: "arm64",
    force: true, useCache: false, mode: "sequential",
  }]);
});
