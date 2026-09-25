import fs from "fs";
import path from "path";
import { app } from "electron";
import debugLogger from "./debugLogger.js";

// Issue #86: the dev channel (pnpm dev and the packaged Dev app) starts from a
// one-way snapshot of the production profile so it opens existing notes,
// recordings and settings without onboarding, while production data is never
// touched by a dev build. Refresh is explicit: delete the dev profile or set
// OPENHERCULES_REFRESH_SNAPSHOT=1.

const DB_FILES = ["transcriptions.db"];

// The dev main process itself runs with NODE_ENV=development and therefore
// opens transcriptions-dev.db (see database.ts): the production database must
// be snapshotted under that name too, or the dev app opens an empty database.
const COPY_FILES: string[] = [
  ...DB_FILES,
  ".env",
  "globe-preference-state.json",
  ".system-audio-permission",
];

// Big trees (audio, meeting results, the persisted session partition with
// localStorage onboarding state) are cloned wholesale.
const COPY_DIRS = ["audio", "meeting-results", "notes", "secure-keys", "Partitions"];

function sourceProfileDir(): string {
  return path.join(app.getPath("appData"), "OpenHercules");
}

function targetProfileDir(): string {
  return app.getPath("userData");
}

function clone(from: string, to: string): void {
  if (fs.existsSync(to)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE);
}

function cloneDir(from: string, to: string): void {
  if (!fs.existsSync(from)) return;
  if (!fs.existsSync(to)) {
    fs.mkdirSync(to, { recursive: true });
  }
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) cloneDir(src, dst);
    else if (!fs.existsSync(dst)) {
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE);
    }
  }
}

// Snapshot runs only when the dev database does not exist yet: a fresh dev
// profile. Copying over an existing dev profile would silently merge dev
// changes back over the production snapshot.
export function snapshotProductionProfileForDev(): void {
  const target = targetProfileDir();
  if (target === sourceProfileDir()) return;
  const source = sourceProfileDir();
  if (!fs.existsSync(path.join(source, "transcriptions.db"))) return;

  const devDbExists = DB_FILES.some(
    (name) =>
      fs.existsSync(path.join(target, name)) ||
      fs.existsSync(path.join(target, name + "-dev"))
  );
  const refresh = process.env.OPENHERCULES_REFRESH_SNAPSHOT === "1";
  if (devDbExists && !refresh) return;

  try {
    fs.mkdirSync(target, { recursive: true });
    for (const name of COPY_FILES) {
      const from = path.join(source, name);
      if (fs.existsSync(from)) clone(path.join(source, name), path.join(target, name));
      for (const suffix of ["-wal", "-shm"]) {
        const side = from + suffix;
        if (fs.existsSync(side)) clone(side, path.join(target, name + suffix));
      }
    }
    // The dev build opens transcriptions-dev.db (NODE_ENV=development); clone
    // the production database under that name so the dev app sees real notes.
    clone(
      path.join(source, "transcriptions.db"),
      path.join(target, "transcriptions-dev.db")
    );
    for (const suffix of ["-wal", "-shm"]) {
      const side = path.join(source, "transcriptions.db" + suffix);
      if (fs.existsSync(side)) clone(side, path.join(target, "transcriptions-dev.db" + suffix));
    }
    for (const name of COPY_DIRS) {
      cloneDir(path.join(source, name), path.join(target, name));
    }
    debugLogger.info("production profile snapshotted into dev profile", {
      source,
      target,
    });
  } catch (error) {
    debugLogger.warn(
      "production profile snapshot failed; dev starts from an empty profile",
      { error: (error as Error)?.message },
      "devSnapshot"
    );
  }
}
