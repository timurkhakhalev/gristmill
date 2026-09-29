// Every PID Gristmill is currently running under, main process included.
//
// The Windows mic listener reports the PID that opened a capture session, and
// dictation opens the mic from Chromium's audio service — a child process — so
// the single --exclude-pid the helper is given can never match it. Without this
// the app detects its own dictation as third-party mic activity (#1392).
interface ElectronAppMetricsLike {
  getAppMetrics?: () => Array<{ pid?: unknown } | undefined>;
}

function getOwnProcessPids(): Set<number> {
  const pids = new Set<number>([process.pid]);
  try {
    // Lazy require keeps every non-Electron consumer (unit tests, tooling)
    // working without the module graph touching electron at load time.
    const { app } = require("electron") as { app: ElectronAppMetricsLike };
    for (const metric of app.getAppMetrics?.() ?? []) {
      if (typeof metric?.pid === "number") pids.add(metric.pid);
    }
  } catch {
    // Outside Electron, or before the app is ready: the main PID is all we have.
  }
  return pids;
}

export { getOwnProcessPids };
module.exports = { getOwnProcessPids };
