const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const path: typeof import("node:path") = require("node:path");

const { pathToFileURL }: typeof import("node:url") = require("node:url");

const { spawnSync }: typeof import("node:child_process") = require("node:child_process");

// ipcHandlers.js reaches raw .ts through Electron's bare Node ESM loader, which
// rejects JSON imports without `with { type: "json" }`. The suite runs under
// tsx, which resolves them anyway, so importing these from a normal test proves
// nothing — each entry needs a child process with no loader hooks (#1908).
const MAIN_PROCESS_ESM_ENTRIES = ["src/helpers/transcriptionRoute.ts"];

const repoRoot = path.resolve(__dirname, "../..");

const bareEnv = { ...process.env };

delete bareEnv.NODE_OPTIONS;

for (const entry of MAIN_PROCESS_ESM_ENTRIES) {
  test(`${entry} imports under a bare Node ESM loader`, () => {
    const specifier = pathToFileURL(path.join(repoRoot, entry)).href;

    const result = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(specifier)})`], {
      env: bareEnv,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
  });
}
