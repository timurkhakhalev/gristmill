import fs from "fs";
import path from "path";
import { app } from "electron";

const SUBDIR = "sidecar-pids";

export interface SidecarPidEntry {
  name: string;
  pid: number;
}

function pidDir(): string {
  return path.join(app.getPath("userData"), SUBDIR);
}

function pidPath(name: string): string {
  return path.join(pidDir(), `${name}.pid`);
}

export function write(name: string, pid: number): void {
  if (!Number.isInteger(pid)) return;
  try {
    fs.mkdirSync(pidDir(), { recursive: true });
    fs.writeFileSync(pidPath(name), String(pid), "utf-8");
  } catch {
    // Best-effort; the registry is the primary shutdown path.
  }
}

export function clear(name: string): void {
  try {
    fs.unlinkSync(pidPath(name));
  } catch {
    // Already gone.
  }
}

// The pid file is untrusted on-disk state: raw contents are read as unknown
// and only integer-looking positive values become entries.
export function readAll(): SidecarPidEntry[] {
  const dir = pidDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const entries: SidecarPidEntry[] = [];
  for (const file of files) {
    if (!file.endsWith(".pid")) continue;
    try {
      const name = path.basename(file, ".pid");
      const raw: unknown = fs.readFileSync(path.join(dir, file), "utf-8");
      const pid = typeof raw === "string" ? Number(raw.trim()) : NaN;
      if (!Number.isInteger(pid) || pid <= 0) continue;
      entries.push({ name, pid });
    } catch {
      // Best-effort recovery metadata; skip entries that vanished or cannot be read.
    }
  }
  return entries;
}
