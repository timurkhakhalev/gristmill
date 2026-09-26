import fs from "fs";
import path from "path";
import { app } from "electron";
import debugLogger from "./debugLogger.js";

// Issue #86: the dev channel (pnpm dev and the packaged Dev app) starts from a
// one-way snapshot of the production profile so it opens existing notes,
// recordings and settings without onboarding, while production data is never
// touched by a dev build. The snapshot runs once; OPENHERCULES_REFRESH_SNAPSHOT=1
// re-runs it additively (missing files are copied, existing dev files are never
// overwritten — a dev database with dev-made notes stays intact). A full reset
// is deleting the dev profile.

const PROD_DB = "transcriptions.db";
// The dev main process runs with NODE_ENV=development and opens
// transcriptions-dev.db (see database.ts): the production database must be
// snapshotted under that name too, or the dev app opens an empty database.
const DEV_DB = "transcriptions-dev.db";
const COPY_FILES = [".env", "globe-preference-state.json", ".system-audio-permission"];
// Big trees (audio, meeting results, the persisted session partition with
// localStorage onboarding state) are cloned wholesale.
const COPY_DIRS = ["audio", "meeting-results", "notes", "secure-keys", "Partitions"];
// Written last: a profile without it was interrupted mid-snapshot and the
// snapshot resumes on the next launch instead of staying half-empty forever.
const MARKER = ".dev-snapshot-complete";

function sourceProfileDir(): string {
  return path.join(app.getPath("appData"), "OpenHercules");
}

function targetProfileDir(): string {
  return app.getPath("userData");
}

// Real paths, not string compare: a dev profile symlinked to the production
// profile would otherwise pass an equality check and the copy could write
// straight into production (worst under REFRESH, where DB files get created).
function sameDir(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

function clone(from: string, to: string): void {
  if (fs.existsSync(to) || !fs.existsSync(from)) return;
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
    else clone(src, dst);
  }
}

// Copying a live WAL-mode database file-by-file can capture mismatched db/wal
// halves when production checkpoints between the two reads. VACUUM INTO
// produces one consistent, self-contained file in a single SQLite read
// transaction. Falls back to a plain clone when the prod db cannot be opened
// (e.g. the better-sqlite3 binding is unavailable in this process).
function snapshotDatabase(source: string, target: string): void {
  const devDbPath = path.join(target, DEV_DB);
  if (fs.existsSync(devDbPath)) return;
  fs.mkdirSync(target, { recursive: true });
  try {
    const Database = require("better-sqlite3") as new (path: string) => {
      exec: (sql: string) => void;
      close: () => void;
    };
    const db = new Database(path.join(source, PROD_DB));
    try {
      db.exec(`VACUUM INTO '${path.join(target, PROD_DB).replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
  } catch (error) {
    debugLogger.warn(
      "consistent db snapshot unavailable; cloning files instead",
      { error: (error as Error)?.message },
      "devSnapshot"
    );
    fs.rmSync(path.join(target, PROD_DB), { force: true });
    clone(path.join(source, PROD_DB), path.join(target, PROD_DB));
    for (const suffix of ["-wal", "-shm"]) {
      clone(path.join(source, PROD_DB + suffix), path.join(target, PROD_DB + suffix));
    }
  }
  // No -wal/-shm beside the VACUUM output; it is a checkpointed single file.
  clone(path.join(target, PROD_DB), devDbPath);
}

export function snapshotProductionProfileForDev(): void {
  const source = sourceProfileDir();
  const target = targetProfileDir();
  if (sameDir(source, target)) return;
  if (!fs.existsSync(path.join(source, PROD_DB))) return;

  const refresh = process.env.OPENHERCULES_REFRESH_SNAPSHOT === "1";
  const markerExists = fs.existsSync(path.join(target, MARKER));
  const devDbExists = fs.existsSync(path.join(target, PROD_DB)) ||
    fs.existsSync(path.join(target, DEV_DB));
  if (devDbExists && markerExists && !refresh) return;

  try {
    snapshotDatabase(source, target);
    for (const name of COPY_FILES) {
      clone(path.join(source, name), path.join(target, name));
    }
    for (const name of COPY_DIRS) {
      cloneDir(path.join(source, name), path.join(target, name));
    }
    // Marker last: only a fully copied profile counts as snapshotted.
    fs.writeFileSync(path.join(target, MARKER), `${new Date().toISOString()}\n`, { mode: 0o600 });
    debugLogger.info("production profile snapshotted into dev profile", { source, target });
  } catch (error) {
    debugLogger.warn(
      "production profile snapshot incomplete; it resumes on the next launch",
      { error: (error as Error)?.message },
      "devSnapshot"
    );
  }
}
