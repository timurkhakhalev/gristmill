const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("macOS packaging uses the OpenHercules icon", () => {
  const builder = JSON.parse(read("electron-builder.json"));
  assert.equal(builder.mac.extendInfo.CFBundleIconName, "openhercules");
  assert.equal(fs.existsSync(path.join(root, "src/assets/openhercules.icon")), true);
  assert.equal(fs.existsSync(path.join(root, "src/assets/openwhispr.icon")), false);
});

test("removed Linux shortcut helpers and dependency stay absent", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal("@homebridge/dbus-native" in (packageJson.dependencies || {}), false);
  for (const helper of [
    "gnomeShortcut.js",
    "gnomeGlobalShortcutsPortal.js",
    "hyprlandShortcut.js",
    "kdeShortcut.js",
  ]) {
    assert.equal(fs.existsSync(path.join(root, "src/helpers", helper)), false, helper);
  }
});

test("complete uninstall is scoped to the OpenHercules profile", () => {
  const script = read("scripts/complete-uninstall.sh");
  assert.match(script, /OpenHercules/);
  assert.doesNotMatch(script, /OpenWhispr|open-whispr|com\.openwhispr/i);
});
