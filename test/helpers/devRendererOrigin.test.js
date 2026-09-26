const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

// The product is macOS-only; Linux CI has no display for GUI Electron.
test("dev renderer imports missing file-origin settings before HTTP scripts", { skip: process.platform !== "darwin" }, async () => {
  const electron = require("electron");
  const script = path.join(__dirname, "devRendererOriginElectron.cjs");
  const { stdout } = await new Promise((resolve, reject) => {
    const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
    execFile(electron, [script], { timeout: 20_000, env }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
  assert.match(stdout, /dev renderer origin smoke passed/);
});
