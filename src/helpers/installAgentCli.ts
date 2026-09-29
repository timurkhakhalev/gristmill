import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

const MARKER = "# Gristmill Notes CLI launcher";
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export function installAgentCli(): string {
  const script = app.isPackaged
    ? path.join(process.resourcesPath, "cli", "gristmill-cli.cjs")
    : path.join(app.getAppPath(), "scripts", "gristmill-cli.cjs");
  if (!fs.existsSync(script)) throw new Error("Gristmill CLI script is missing from the app");
  const directory = path.join(os.homedir(), ".local", "bin");
  const target = path.join(directory, "gristmill");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.existsSync(target) && !fs.readFileSync(target, "utf8").includes(MARKER)) {
    throw new Error(`${target} exists and is not a Gristmill launcher`);
  }
  const content = `#!/bin/sh\n${MARKER}\nELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(script)} "$@"\n`;
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
