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
// The dev main process runs on the development channel and opens
// transcriptions-dev.db (appChannel.ts + database.ts); both dev modes
// converge on this one file, so the snapshot writes only it.
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

// One-time cutover: before the channel-based filename, the packaged Dev app
// (no NODE_ENV=development) wrote transcriptions.db in this profile. Those
// dev-made notes must survive the rename to the channel database name.
// Checkpoint the WAL into the main file first, then rename -wal/-shm before
// the database itself: an interruption at any point leaves no
// transcriptions-dev.db, so adoption simply reruns on the next launch and
// never sees a new-style database next to an unmerged legacy WAL.
function adoptLegacyDevDatabase(target: string): boolean {
  const legacy = path.join(target, PROD_DB);
  const current = path.join(target, DEV_DB);
  if (fs.existsSync(current) || !fs.existsSync(legacy)) return true;
  try {
    const Database = require("better-sqlite3") as new (path: string) => {
      exec: (sql: string) => void;
      prepare: (sql: string) => { get: () => { busy: number } };
      close: () => void;
    };
    const db = new Database(legacy);
    try {
      // TRUNCATE reports a blocked checkpoint as busy=1 in the result row
      // instead of throwing; renaming with an unmerged WAL would lose those
      // commits, so a blocked checkpoint is a failure, not a warning.
      const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
      if (row?.busy !== 0) throw new Error("wal_checkpoint blocked by another reader");
    } finally {
      db.close();
    }
  } catch (error) {
    debugLogger.warn(
      "legacy dev database adoption failed; retrying on the next launch",
      { error: (error as Error)?.message },
      "devSnapshot"
    );
    return false;
  }
  for (const suffix of ["-shm", "-wal"]) {
    const side = legacy + suffix;
    if (fs.existsSync(side)) fs.renameSync(side, current + suffix);
  }
  fs.renameSync(legacy, current);
  return true;
}

// Copying a live WAL-mode database file-by-file can capture mismatched db/wal
// halves when production checkpoints between the two reads. VACUUM INTO
// produces one consistent, self-contained file in a single SQLite read
// transaction. The output is staged under a temp name and published with
// link(), which fails when the destination already exists: two concurrent
// first launches cannot replace a database the other one published or opened.
function snapshotDatabase(source: string, target: string, name: string): boolean {
  const destination = path.join(target, name);
  if (fs.existsSync(destination)) return true;
  fs.mkdirSync(target, { recursive: true });
  const staged = path.join(target, `.${name}.snapshot-${process.pid}.tmp`);
  fs.rmSync(staged, { force: true, recursive: true });
  try {
    const Database = require("better-sqlite3") as new (path: string) => {
      exec: (sql: string) => void;
      close: () => void;
    };
    const db = new Database(path.join(source, PROD_DB));
    try {
      db.exec(`VACUUM INTO '${staged.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
    // link() never overwrites; rename() over APFS would clobber a database a
    // concurrent launch created between the existsSync check and now.
    fs.linkSync(staged, destination);
    fs.rmSync(staged, { force: true, recursive: true });
    return true;
  } catch (error) {
    fs.rmSync(staged, { force: true, recursive: true });
    if (fs.existsSync(destination)) return true; // a concurrent launch won
    debugLogger.warn(
      "consistent database snapshot failed; retrying on the next launch",
      { error: (error as Error)?.message },
      "devSnapshot"
    );
    return false;
  }
}

export function snapshotProductionProfileForDev(): boolean {
  const source = sourceProfileDir();
  const target = targetProfileDir();
  if (sameDir(source, target)) return true;

  // Adoption is independent of the production snapshot: a dev-only profile
  // with pre-cutover notes must migrate even when no production profile
  // exists. Run it before any existence check would mistake the legacy file
  // for a completed snapshot (it has no marker). A failed adoption must stop
  // startup: the app would create an empty dev database and the legacy notes
  // would never be retried.
  if (!adoptLegacyDevDatabase(target)) return false;

  if (!fs.existsSync(path.join(source, PROD_DB))) return true;

  const refresh = process.env.OPENHERCULES_REFRESH_SNAPSHOT === "1";
  const markerExists = fs.existsSync(path.join(target, MARKER));
  const devDbExists = fs.existsSync(path.join(target, DEV_DB));
  if (devDbExists && markerExists && !refresh) return true;

  let dbReady: boolean;
  try {
    // The database filename follows the channel (appChannel.ts): both dev
    // modes — pnpm dev and the packaged Dev app — open transcriptions-dev.db.
    dbReady = snapshotDatabase(source, target, DEV_DB);
    for (const name of COPY_FILES) {
      clone(path.join(source, name), path.join(target, name));
    }
    for (const name of COPY_DIRS) {
      cloneDir(path.join(source, name), path.join(target, name));
    }
  } catch (error) {
    debugLogger.warn(
      "production profile snapshot incomplete; it resumes on the next launch",
      { error: (error as Error)?.message },
      "devSnapshot"
    );
    return false;
  }
  if (!dbReady && !fs.existsSync(path.join(target, DEV_DB))) {
    // Without the database the app would create an empty transcriptions-dev.db
    // on startup and every later launch would treat it as a completed profile.
    // Stop instead: the next launch retries the snapshot.
    debugLogger.warn(
      "dev profile has no database and the snapshot failed; refusing to start",
      {},
      "devSnapshot"
    );
    return false;
  }
  // Marker last: only a fully copied profile counts as snapshotted.
  fs.writeFileSync(path.join(target, MARKER), `${new Date().toISOString()}\n`, { mode: 0o600 });
  debugLogger.info("production profile snapshotted into dev profile", { source, target });
  return true;
}
