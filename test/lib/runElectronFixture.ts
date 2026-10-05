import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { build } from "esbuild";

// Parent owns output and profile even when compilation or the GUI child fails.
export async function runElectronFixture(
  t: Pick<TestContext, "after">,
  source: string,
  { timeout = 20_000 } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-electron-fixture-"));
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  t.after(cleanup);

  try {
    const profile = path.join(root, "profile");
    fs.mkdirSync(profile);
    const outfile = path.join(root, path.basename(source, ".ts") + ".cjs");
    await build({
      entryPoints: [source],
      outfile,
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node24",
      external: ["electron"],
      define: { __dirname: JSON.stringify(path.dirname(source)) },
      logLevel: "silent",
    });
    const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
    const electron: string = require("electron");

    return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = execFile(
        electron,
        [outfile],
        { timeout, env: { ...env, GRISTMILL_ELECTRON_FIXTURE_PROFILE: profile } },
        (error, stdout, stderr) => {
          if (error || child.killed)
            reject(
              new Error(`${error?.message ?? "Electron fixture timed out"}\n${stdout}\n${stderr}`)
            );
          else resolve({ stdout, stderr });
        }
      );
    });
  } finally {
    cleanup();
  }
}
