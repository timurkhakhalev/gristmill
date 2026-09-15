import { app } from "electron";
import fs from "fs";
import net from "net";
import path from "path";
import { killProcessGroup } from "./process.js";
import type { ChildProcess } from "child_process";

const GRACEFUL_STOP_TIMEOUT_MS = 5000;

function tryBind(port: number, host: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const s = net.createServer();
    // A host whose address family is absent (e.g. IPv6 disabled) can't conflict on the port.
    s.once("error", (err) =>
      resolve(
        (err as NodeJS.ErrnoException).code === "EADDRNOTAVAIL" ||
          (err as NodeJS.ErrnoException).code === "EAFNOSUPPORT"
      )
    );
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

export async function isPortAvailable(port: number): Promise<boolean> {
  return (
    (await tryBind(port, "0.0.0.0")) &&
    (await tryBind(port, "::")) &&
    (await tryBind(port, "127.0.0.1"))
  );
}

export async function findAvailablePort(rangeStart: number, rangeEnd: number): Promise<number> {
  for (let port = rangeStart; port <= rangeEnd; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available ports in range ${rangeStart}-${rangeEnd}`);
}

export function resolveBinaryPath(binaryName: string): string | null {
  const candidates: string[] = [];

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "bin", binaryName));
  }

  const projectBinDir = path.resolve(app.getAppPath(), "resources", "bin");
  candidates.push(path.join(projectBinDir, binaryName));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        fs.statSync(candidate);
        return candidate;
      } catch {
        // Can't access binary
      }
    }
  }

  return null;
}

export async function gracefulStopProcess(proc: ChildProcess | null): Promise<void> {
  killProcessGroup(proc, "SIGTERM");

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (proc) killProcessGroup(proc, "SIGKILL");
      resolve();
    }, GRACEFUL_STOP_TIMEOUT_MS);

    if (proc) {
      proc.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    } else {
      clearTimeout(timeout);
      resolve();
    }
  });
}
