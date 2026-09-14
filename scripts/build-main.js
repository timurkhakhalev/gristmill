// Emit the Electron dependency graph, including JSON and the separately loaded worker.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
fs.rmSync(path.join(root, "dist-main"), { recursive: true, force: true });
execFileSync(
  process.execPath,
  [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.main.json"],
  {
    cwd: root,
    stdio: "inherit",
  }
);
