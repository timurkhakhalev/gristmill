const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const path: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");
const { runElectronFixture }: typeof import("../lib/runElectronFixture.ts") = require("../lib/runElectronFixture.ts");

// The product is macOS-only; Linux CI has no display for GUI Electron.
test("dev renderer imports missing file-origin settings before HTTP scripts", { skip: process.platform !== "darwin" }, async (t) => {
  const { stdout } = await runElectronFixture(t, path.join(__dirname, "devRendererOriginElectron.ts"));
  assert.match(stdout, /dev renderer origin smoke passed/);
});
