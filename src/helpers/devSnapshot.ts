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
const COPY_FILES = ["globe-preference-state.json", ".system-audio-permission"];

// Copy the production .env for BYOK credentials, but never the OAuth scheme
// selectors: the URL scheme is a property of the build channel (dev builds
// register openhercules-dev), and inheriting a production value would flip
// the protocol between the first and second launch.
const ENV_STRIP_KEYS = ["OPENHERCULES_PROTOCOL", "VITE_OPENHERCULES_PROTOCOL"];

// dotenv accepts `KEY=`, `export KEY=` and `KEY:` assignments, with optional
// surrounding whitespace — all spellings of a stripped key must go.
function envLineAssignsStrippedKey(line: string): boolean {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]/);
  return Boolean(match && ENV_STRIP_KEYS.includes(match[1].toUpperCase()));
}

function cloneEnvFile(source: string, target: string): void {
  const destination = path.join(target, ".env");
  if (fs.existsSync(destination) || !fs.existsSync(path.join(source, ".env"))) return;
  const lines = fs
    .readFileSync(path.join(source, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((line) => !envLineAssignsStrippedKey(line));
  fs.writeFileSync(destination, lines.join("\n"), { mode: 0o600 });
}
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

// TRUNCATE reports a blocked checkpoint as busy=1 in the result row instead
// of throwing; renaming a database whose WAL still holds unmerged commits
// would lose them, so a blocked checkpoint is a failure, not a warning.
function checkpointDatabase(file: string): boolean {
  try {
    const Database = require("better-sqlite3") as new (path: string) => {
      prepare: (sql: string) => { get: () => { busy: number } };
      close: () => void;
    };
    const db = new Database(file);
    try {
      const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
      if (row?.busy !== 0) throw new Error("wal_checkpoint blocked by another reader");
    } finally {
      db.close();
    }
    return true;
  } catch (error) {
    debugLogger.warn(
      "database checkpoint failed; retrying on the next launch",
      { error: (error as Error)?.message },
      "devSnapshot"
    );
    return false;
  }
}

// Rename a database file set so an interruption at any point leaves the
// destination's database file absent: sidecars move first, the database last,
// and a rerun starts over cleanly because the destination database is missing.
function renameDatabaseSet(from: string, to: string): void {
  for (const suffix of ["-shm", "-wal"]) {
    if (fs.existsSync(from + suffix)) fs.renameSync(from + suffix, to + suffix);
  }
  fs.renameSync(from, to);
}

// One-time cutover: before the channel-based filename, the packaged Dev app
// (no NODE_ENV=development) wrote transcriptions.db while pnpm dev wrote
// transcriptions-dev.db — a user of both modes has TWO note sets. The mixed
// case is preserved as an explicit backup instead of a schema merge (a wrong
// merge loses notes; a visible backup file never does). Both paths checkpoint
// the legacy WAL first so no committed note stays behind in a sidecar.
function adoptLegacyDevDatabase(target: string): boolean {
  const legacy = path.join(target, PROD_DB);
  const current = path.join(target, DEV_DB);
  if (!fs.existsSync(legacy)) return true;
  if (!checkpointDatabase(legacy)) return false;
  if (fs.existsSync(current)) {
    // Both databases predate the cutover: keep the packaged-Dev set as an
    // explicit, visible backup. It is not opened automatically; restoring it
    // is a manual, deliberate act. Reserve an unused name first — rename
    // onto an existing file overwrites it, and a same-millisecond collision
    // must not destroy an earlier backup.
    let backup: string | null = null;
    for (let attempt = 0; attempt < 1000 && !backup; attempt++) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const candidate = path.join(
        target,
        `transcriptions-legacy-dev-backup-${stamp}${attempt ? `-${attempt}` : ""}.db`
      );
      if (!fs.existsSync(candidate)) backup = candidate;
    }
    if (!backup) {
      debugLogger.warn(
        "could not reserve a legacy backup name; retrying on the next launch",
        {},
        "devSnapshot"
      );
      return false;
    }
    debugLogger.warn(
      "dev profile holds both pre-cutover databases; keeping the packaged-Dev set as " +
        path.basename(backup),
      {},
      "devSnapshot"
    );
    renameDatabaseSet(legacy, backup);
    return true;
  }
  renameDatabaseSet(legacy, current);
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
  // A dev profile symlinked (or otherwise aliased) to the production profile
  // must stop startup, not just skip the snapshot: the app itself would open
  // and write its database inside the production profile.
  if (sameDir(source, target)) {
    debugLogger.warn(
      "dev profile resolves to the production profile; refusing to start",
      { source, target },
      "devSnapshot"
    );
    return false;
  }

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
    cloneEnvFile(source, target);
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
