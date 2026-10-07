import { getOwnProcessPids } from "./ownProcessPids.js";

// The macOS audio tap helper is a plain child process, so it never appears in the Electron
// process tree — yet the OS attributes their capture to their own pids.
// Without excluding them, the app's own system-audio capture reads as an
// external mic user and auto-end can never arm its end detection.
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function collectAudioCaptureHelperPids(
  managers: Array<{ process?: { pid?: unknown } | null } | null | undefined>
): number[] {
  return managers.map((manager) => manager?.process?.pid).filter(isPositiveInteger);
}

export function createExcludedProcessIdProvider(
  getAudioCaptureHelperPids: () => number[] = () => [],
  getOwnPids: () => Set<number> = getOwnProcessPids
): () => number[] {
  return () => [...getOwnPids(), ...getAudioCaptureHelperPids()];
}

module.exports = { collectAudioCaptureHelperPids, createExcludedProcessIdProvider };
