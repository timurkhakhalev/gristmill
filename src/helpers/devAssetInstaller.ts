import { spawn } from "child_process";
import path from "path";
import fs from "fs";
const { app } = require("electron");
import debugLogger from "./debugLogger.js";

// Dev-only runtime installer for local-route binaries. Packaged builds ship
// every binary in Resources/bin, so a missing binary there is an install
// error and is reported as-is. In dev, `pnpm start` no longer prefetches
// local-route assets (issue #89): the first use of a local route downloads
// just that route's binary via the existing pinned download script.
const SCRIPTS: Record<string, string> = {
  "whisper-cpp": "download-whisper-cpp.js",
  "llama-server": "download-llama-server.js",
  "sherpa-onnx": "download-sherpa-onnx.js",
};

const inFlight = new Map<string, Promise<void>>();
const timeouts: NodeJS.Timeout[] = [];

export function isDevAssetInstallSupported(): boolean {
  return !app.isPackaged && process.platform === "darwin" && process.arch === "arm64";
}

export async function ensureDevBinary(asset: string): Promise<void> {
  if (!isDevAssetInstallSupported()) return;
  const script = SCRIPTS[asset];
  if (!script) return;

  const existing = inFlight.get(asset);
  if (existing) return existing;

  const pending = (async () => {
    const scriptPath = path.join(app.getAppPath(), "scripts", script);
    if (!fs.existsSync(scriptPath)) return;
    debugLogger.info("Installing local-route binary", { asset }, "assets");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath, "--current"], {
        cwd: app.getAppPath(),
        stdio: "ignore",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`Timed out installing ${asset} binary`));
      }, 10 * 60 * 1000);
      timeouts.push(timeout);
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(`Failed to install ${asset} binary (exit ${code})`));
      });
    });
    debugLogger.info("Local-route binary installed", { asset }, "assets");
  })().finally(() => {
    inFlight.delete(asset);
  });

  inFlight.set(asset, pending);
  return pending;
}

export function shutdownDevAssetInstaller(): void {
  for (const timeout of timeouts.splice(0)) clearTimeout(timeout);
}

export function resetDevAssetInstallerForTests(): void {
  inFlight.clear();
  timeouts.splice(0).forEach(clearTimeout);
}
