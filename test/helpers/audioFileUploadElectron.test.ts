const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// Compile the authored TS entrypoint to a CJS artifact for the GUI Electron
// subprocess (it has no tsx loader). Same pattern as preload in build-main.
async function compileElectronEntrypoint(source) {
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
    define: { __dirname: JSON.stringify(path.dirname(path.join(__dirname, "audioFileUploadElectron.ts"))) },
    logLevel: "silent",
  });
  return outfile;
}

test("Electron uploads raw and multipart audio files", async () => {
  const electron = require("electron");
  const script = await compileElectronEntrypoint(path.join(__dirname, "audioFileUploadElectron.ts"));
  const { stdout } = await new Promise((resolve, reject) => {
    const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
    execFile(electron, [script], { timeout: 20_000, env }, (error: unknown, stdout: string, stderr: string) => {
      if (error) reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
  assert.match(stdout, /audio file upload smoke passed/);
});
