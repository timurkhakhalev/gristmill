import { execFileSync } from "child_process";
import debugLogger from "./debugLogger.js";
import { clear as clearPidEntry, readAll } from "./sidecarPidFile.js";

const EXPECTED_BINARY_FRAGMENTS: Record<string, string[]> = {
  parakeet: ["sherpa-onnx-ws-", "sherpa-onnx-online-ws-"],
  whisper: ["whisper-server"],
  llama: ["llama-server"],
  diarization: ["sherpa-onnx-diarize"],
};

// A wedged sidecar can ignore SIGTERM, so reaping must verify death and
// escalate rather than fire-and-forget.
const SIGTERM_GRACE_MS = 5000;

const SIGKILL_GRACE_MS = 1000;

const EXIT_POLL_INTERVAL_MS = 200;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processCommand(pid: number): string {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }).toString();

      const match = out.match(/^"([^"]+)"/);

      return match ? match[1] : "";
    }

    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already dead.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(EXIT_POLL_INTERVAL_MS);
  }

  return true;
}

async function killStaleSidecar(
  name: string,
  pid: number,
  { sigtermGraceMs, sigkillGraceMs }: { sigtermGraceMs: number; sigkillGraceMs: number }
): Promise<boolean> {
  debugLogger.warn("Reaping stale sidecar", { name, pid });
  signalProcess(pid, "SIGTERM");

  if (await waitForExit(pid, sigtermGraceMs)) return true;

  debugLogger.warn("Stale sidecar ignored SIGTERM, escalating to SIGKILL", { name, pid });
  signalProcess(pid, "SIGKILL");

  if (await waitForExit(pid, sigkillGraceMs)) return true;

  debugLogger.error("Stale sidecar survived SIGKILL, keeping PID entry for next launch", {
    name,
    pid,
  });

  return false;
}

interface ReaperOptions {
  sigtermGraceMs?: number;
  sigkillGraceMs?: number;
}

export async function reapStaleSidecars({
  sigtermGraceMs = SIGTERM_GRACE_MS,
  sigkillGraceMs = SIGKILL_GRACE_MS,
}: ReaperOptions = {}): Promise<void> {
  const entries = readAll();
  await Promise.all(
    entries.map(async ({ name, pid }) => {
      const fragments = EXPECTED_BINARY_FRAGMENTS[name];

      if (fragments && isProcessAlive(pid)) {
        const command = processCommand(pid);

        if (fragments.some((fragment) => command.includes(fragment))) {
          const dead = await killStaleSidecar(name, pid, { sigtermGraceMs, sigkillGraceMs });

          if (!dead) return;
        }
      }

      clearPidEntry(name);
    })
  );
}
