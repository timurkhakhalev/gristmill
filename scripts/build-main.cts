// Emit the Electron dependency graph, including JSON and the separately loaded worker.
// The sandboxed preload cannot require local modules, so after tsc succeeds the
// preload is bundled into one file with esbuild (electron external, CJS, node).
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const { execFileSync }: typeof import("node:child_process") = require("node:child_process");

const root = path.resolve(__dirname, "..");
fs.rmSync(path.join(root, "dist-main"), { recursive: true, force: true });
execFileSync(path.join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.main.json"], {
  cwd: root,
  stdio: "inherit",
});

const bundledPreload = path.join(root, "dist-main", "preload.js");
try {
  execFileSync(
    path.join(root, "node_modules", ".bin", "esbuild"),
    [
      path.join(root, "preload.ts"),
      `--outfile=${bundledPreload}`,
      "--bundle",
      "--format=cjs",
      "--platform=node",
      "--target=node24",
      "--external:electron",
    ],
    { cwd: root, stdio: "inherit" }
  );
} catch (error) {
  // Never leave an unbundled preload behind: it would not load in a sandboxed
  // renderer, so treat the bundle failure as a build failure.
  fs.rmSync(bundledPreload, { force: true });
  throw error;
}

// Dev launchers and packaged resources consume the same standalone CJS tools.
execFileSync(process.execPath, [path.join(__dirname, "build-runtime-tools.cts")], {
  cwd: root,
  stdio: "inherit",
});

export type {};
