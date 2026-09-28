const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { execFile }: typeof import("node:child_process") = require("node:child_process");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");

// Compile the authored TS entrypoint to a CJS artifact for the GUI Electron
// subprocess (it has no tsx loader). Same pattern as preload in build-main.
async function compileElectronEntrypoint(source: string) {
  const esbuild = require("esbuild");
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-electron-entry-"));
  const outfile = path.join(outDir, path.basename(source, ".ts") + ".cjs");
  await esbuild.build({
    entryPoints: [source],
    outfile,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node24",
    external: ["electron"],
    // Bundled artifact lives in a tmpdir; give it the real repo root the
    // authored entrypoint computed from its own __dirname.
    define: { __dirname: JSON.stringify(path.dirname(path.join(__dirname, "devRendererOriginElectron.ts"))) },
    logLevel: "silent",
  });
  return outfile;
}

// The product is macOS-only; Linux CI has no display for GUI Electron.
test("dev renderer imports missing file-origin settings before HTTP scripts", { skip: process.platform !== "darwin" }, async () => {
  const electron = require("electron");
  const script = await compileElectronEntrypoint(path.join(__dirname, "devRendererOriginElectron.ts"));
  const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
    execFile(electron, [script], { timeout: 20_000, env }, (error: unknown, stdout: string, stderr: string) => {
      if (error) reject(new Error(`${(error as Error).message}\n${stdout}\n${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
  assert.match(stdout, /dev renderer origin smoke passed/);
});
