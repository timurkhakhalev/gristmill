// The shared audio-path allowlist behind file selection, drag-drop approval,
// and every transcription path resolution. Moved out of ipcHandlers.js so the
// typed handler modules and the JS composition root resolve paths identically.
// Canonicalize allowed dirs so realpath'd inputs match on macOS (/var -> /private/var).
// Deliberately narrow: user-picked paths anywhere else are approved individually via
// approvedAudioPaths, so a compromised renderer can't read arbitrary files.
import { app } from "electron";
import fs from "fs";
import os from "os";
import path from "path";
import { getSafeTempDir } from "./safeTempDir.js";

function getCanonicalAllowedAudioDirs(): string[] {
  const dirs = [os.tmpdir(), getSafeTempDir(), app.getPath("userData")];

  return dirs.map((d) => {
    try {
      return fs.realpathSync(d);
    } catch {
      return d;
    }
  });
}

// User-picked paths (OS file dialog, real drag-dropped files) may live outside the
// static dirs (external volumes, /mnt, D:\) and are approved individually.
const approvedAudioPaths = new Set<string>();

function isNonEmptyPath<T>(value: T): value is T & string {
  return typeof value === "string" && value !== "";
}

export function approveAudioPath<T>(filePath: T): void {
  if (!isNonEmptyPath(filePath)) return;

  try {
    approvedAudioPaths.add(fs.realpathSync(path.resolve(filePath)));
  } catch {
    // File vanished or unreadable; nothing to approve.
  }
}

// Returns the realpath'd file path if it lives under an allowed dir, else null.
export function resolveAllowedAudioPath(filePath: string): string | null {
  const real = fs.realpathSync(path.resolve(filePath));

  if (approvedAudioPaths.has(real)) {
    return real;
  }

  const allowed = getCanonicalAllowedAudioDirs();

  if (allowed.some((dir) => real === dir || real.startsWith(dir + path.sep))) {
    return real;
  }

  return null;
}
