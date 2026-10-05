import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { isDevelopmentChannel } from "./appChannel.js";

const MARKER = "# Gristmill Notes CLI launcher";

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

function launcher() {
  const script = app.isPackaged
    ? path.join(process.resourcesPath, "cli", "gristmill-cli.cjs")
    : path.join(app.getAppPath(), "resources", "cli", "gristmill-cli.cjs");

  const defaultProfile = isDevelopmentChannel() ? "development" : "production";
  const content = `#!/bin/sh\n${MARKER}\nexport GRISTMILL_CLI_DEFAULT_PROFILE=${quote(defaultProfile)}\nELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(script)} "$@"\n`;

  return { script, target: path.join(os.homedir(), ".local", "bin", "gristmill"), content };
}

export function getAgentCliStatus(): { installed: boolean; path: string } {
  const { target, content, script } = launcher();

  if (!fs.existsSync(target) || !fs.existsSync(script)) return { installed: false, path: target };

  const installed =
    fs.readFileSync(target, "utf8") === content && (fs.statSync(target).mode & 0o111) !== 0;

  return { installed, path: target };
}

export function installAgentCli(): string {
  const { script, target, content } = launcher();

  if (!fs.existsSync(script)) throw new Error("Gristmill CLI script is missing from the app");
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  if (fs.existsSync(target) && !fs.readFileSync(target, "utf8").includes(MARKER)) {
    throw new Error(`${target} exists and is not a Gristmill launcher`);
  }

  const temporary = path.join(directory, `.gristmill-${process.pid}.tmp`);

  try {
    fs.writeFileSync(temporary, content, { mode: 0o755 });
    fs.chmodSync(temporary, 0o755);
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }

  return target;
}
