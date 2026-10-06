import path from "path";
import { spawn } from "child_process";
import { TIMEOUTS, killProcess } from "../utils/process.js";

const TAR_KILL_GRACE_MS = 1000;

function tarExtractionFlags(archivePath: string): string {
  const lower = archivePath.toLowerCase();

  if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) return "-xjf";

  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "-xzf";

  // bsdtar and modern GNU tar auto-detect the format on extraction (zip included).
  return "-xf";
}

export interface SystemTarEnvironment {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: Record<string, string | undefined>;
}

export function resolveSystemTarExecutable({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
}: SystemTarEnvironment = {}): string {
  if (platform !== "win32") return "tar";

  const windowsDir = env.SystemRoot || env.SYSTEMROOT || env.WINDIR || env.windir || "C:\\Windows";
  // A 32-bit process is redirected from System32 to SysWOW64, where tar.exe
  // is not normally present. Sysnative is Windows' alias for the native
  // system directory in that situation.
  const systemDir = arch === "ia32" && env.PROCESSOR_ARCHITEW6432 ? "Sysnative" : "System32";

  return path.win32.join(windowsDir, systemDir, "tar.exe");
}

import type { ChildProcess } from "child_process";

type SpawnLike = typeof spawn;

export interface RunSystemTarOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  killGraceMs?: number;
  spawnImpl?: SpawnLike;
}

export function runSystemTar(
  archivePath: string,
  destDir: string,
  {
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    timeoutMs = TIMEOUTS.INSTALL,
    killGraceMs = TAR_KILL_GRACE_MS,
    spawnImpl = spawn,
  }: RunSystemTarOptions = {}
): Promise<void> {
  // Windows' bundled bsdtar can lack bz2lib and hang while invoking an
  // external bzip2 from PATH. Callers already provide a bundled JS fallback.
  if (platform === "win32" && tarExtractionFlags(archivePath) === "-xjf") {
    return Promise.reject(
      new Error("Use bundled JavaScript extraction for Windows bzip2 archives")
    );
  }

  return new Promise((resolve, reject) => {
    const executable = resolveSystemTarExecutable({ platform, arch, env });
    // Relative arguments avoid GNU tar interpreting a Windows drive-letter
    // colon as a remote archive separator on non-standard PATH tar builds.
    const pathApi = platform === "win32" ? path.win32 : path;
    const cwd = pathApi.dirname(archivePath);
    const archiveArg = pathApi.basename(archivePath);
    const destArg = pathApi.relative(cwd, destDir) || ".";
    let tarProcess: ChildProcess;

    try {
      tarProcess = spawnImpl(
        executable,
        [tarExtractionFlags(archivePath), archiveArg, "-C", destArg],
        {
          cwd,
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        }
      );
    } catch (err) {
      reject(
        new Error(
          `Failed to start tar process: ${err instanceof Error ? err.message : String(err)}`
        )
      );

      return;
    }

    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killGraceTimer: NodeJS.Timeout | null = null;

    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);

      if (killGraceTimer) clearTimeout(killGraceTimer);
      settle();
    };

    const timeoutError = () => new Error(`tar extraction timed out after ${timeoutMs}ms`);

    const timeoutTimer: NodeJS.Timeout = setTimeout(() => {
      timedOut = true;
      killProcess(tarProcess, "SIGKILL");

      // Normally close follows kill immediately. Do not let a broken process
      // implementation turn the safety timeout into another indefinite wait.
      killGraceTimer = setTimeout(() => finish(() => reject(timeoutError())), killGraceMs);
    }, timeoutMs);

    const stderrStream = tarProcess.stderr;

    if (!stderrStream) {
      finish(() => reject(new Error("tar process produced no stderr stream")));

      return;
    }

    stderrStream.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    tarProcess.on("close", (code) => {
      if (timedOut) {
        finish(() => reject(timeoutError()));
      } else if (code === 0) {
        finish(() => resolve());
      } else {
        finish(() => reject(new Error(`tar extraction failed with code ${code}: ${stderr}`)));
      }
    });

    tarProcess.on("error", (err) => {
      finish(() =>
        reject(
          new Error(
            `Failed to start tar process: ${err instanceof Error ? err.message : String(err)}`
          )
        )
      );
    });
  });
}
