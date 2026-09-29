import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { app } from "electron";
import debugLogger from "./debugLogger.js";
import { getLocalEngineBinDir } from "../utils/serverUtils.js";

type LocalEngine = "whisper-cpp" | "llama-server" | "sherpa-onnx";

const scripts: Record<LocalEngine, string> = {
  "whisper-cpp": "download-whisper-cpp",
  "llama-server": "download-llama-server",
  "sherpa-onnx": "download-sherpa-onnx",
};

const inFlight = new Map<LocalEngine, Promise<void>>();

export async function ensureLocalEngine(engine: LocalEngine): Promise<void> {
  const existing = inFlight.get(engine);
  if (existing) return existing;

  const pending = (async () => {
    const name = scripts[engine];
    const scriptPath = app.isPackaged
      ? path.join(process.resourcesPath, "local-engine-installers", `${name}.cjs`)
      : path.join(app.getAppPath(), "scripts", `${name}.js`);
    if (!fs.existsSync(scriptPath)) throw new Error(`Local engine installer missing: ${engine}`);

    const binDir = getLocalEngineBinDir();
    fs.mkdirSync(binDir, { recursive: true });
    debugLogger.info("Installing local engine", { engine }, "assets");

    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath, "--current"], {
        cwd: app.isPackaged ? app.getPath("userData") : app.getAppPath(),
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          GRISTMILL_LOCAL_BIN_DIR: binDir,
        },
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-2048);
      });
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`Timed out installing ${engine}`));
      }, 10 * 60 * 1000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(`Failed to install ${engine}: ${stderr.trim() || `exit ${code}`}`));
      });
    });
    debugLogger.info("Local engine installed", { engine }, "assets");
  })().finally(() => inFlight.delete(engine));

  inFlight.set(engine, pending);
  return pending;
}
