const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const path: typeof import("node:path") = require("node:path");

const test: typeof import("node:test") = require("node:test");

const root = path.join(__dirname, "../..");

const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("macOS packaging uses the Gristmill icon", () => {
  const builder = JSON.parse(read("electron-builder.json"));
  assert.equal(builder.mac.extendInfo.CFBundleIconName, "gristmill");
  assert.equal(fs.existsSync(path.join(root, "src/assets/gristmill.icon")), true);
  assert.equal(fs.existsSync(path.join(root, "src/assets/openwhispr.icon")), false);
});

test("complete uninstall is scoped to the Gristmill profile", () => {
  const script = read("scripts/complete-uninstall.sh");
  assert.match(script, /Gristmill/);
  assert.doesNotMatch(script, /OpenWhispr|open-whispr|com\.openwhispr/i);
});
