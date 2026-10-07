import fs from "fs";
import path from "path";
import { app } from "electron";
import debugLogger from "./debugLogger.js";
import { SECRET_ENV_KEYS } from "../config/secretKeys.js";

// Issue #86: the dev channel (pnpm dev and the packaged Dev app) starts from a
// one-way snapshot of the production profile so it opens existing notes,
// recordings and settings without onboarding, while production data is never
// touched by a dev build. The snapshot runs once; GRISTMILL_REFRESH_SNAPSHOT=1
// re-runs it additively (missing files are copied, existing dev files are never
// overwritten — a dev database with dev-made notes stays intact).

const PROD_DB = "transcriptions.db";

// The dev main process runs on the development channel and opens
// transcriptions-dev.db (appChannel.ts + database.ts); both dev modes
// converge on this one file, so the snapshot writes only it.
const DEV_DB = "transcriptions-dev.db";

const COPY_FILES = ["globe-preference-state.json", ".system-audio-permission"];

// Copy non-secret settings only. Protocol selectors belong to the build
// channel, while encrypted secrets are copied separately in secure-keys.
const ENV_STRIP_KEYS = new Set(
  [...SECRET_ENV_KEYS, "GRISTMILL_PROTOCOL", "VITE_GRISTMILL_PROTOCOL"].map((key) =>
    key.toUpperCase()
  )
);

function errorMessage<T>(error: T): string {
  return error instanceof Error ? error.message : String(error);
}

function isString<T>(value: T): value is T & string {
  return typeof value === "string";
}

function errorCode<T>(error: T): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  const code: unknown = error.code;

  return isString(code) ? code : undefined;
}

interface DotenvModule {
  parse(content: string): Record<string, string>;
}

interface SnapshotSqliteStatement {
  get(): { busy?: number; name?: string } | undefined;
  all(): Array<{ name: string }>;
  run(...params: unknown[]): { changes: number };
}

interface SnapshotSqliteDatabase {
  exec(source: string): void;
  prepare(source: string): SnapshotSqliteStatement;
  close(): void;
}

type SnapshotSqliteConstructor = new (
  filename: string,
  options?: { readonly: boolean; fileMustExist: boolean }
) => SnapshotSqliteDatabase;

function openSnapshotDatabase(
  file: string,
  options?: { readonly: boolean; fileMustExist: boolean }
): SnapshotSqliteDatabase {
  // SAFETY: better-sqlite3 ships no declarations; this module defines the exact
  // structural surface used below, matching database.ts's own seam.
  const Database = require("better-sqlite3") as SnapshotSqliteConstructor;

  return new Database(file, options);
}

function cloneEnvFile(source: string, target: string): void {
  const destination = path.join(target, ".env");
  const origin = path.join(source, ".env");

  if (!ordinaryFileOrMissing(destination) || !ordinaryFileOrMissing(origin)) {
    throw new Error("snapshot .env path is not an ordinary file");
  }

  if (fs.existsSync(destination) || !fs.existsSync(origin)) return;
  // SAFETY: dotenv is bundled by build-main.js; its parse export takes the file
  // text and returns string assignments, and no wire data crosses this seam.
  const parsed = (require("dotenv") as DotenvModule).parse(fs.readFileSync(origin, "utf8"));

  const safeContent = Object.entries(parsed)
    .filter(([key]) => !ENV_STRIP_KEYS.has(key.toUpperCase()))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n");

  fs.writeFileSync(destination, safeContent ? `${safeContent}\n` : "", { mode: 0o600 });
}

// The file-origin renderer settings live in Partitions. pnpm dev has a separate
// HTTP origin; windowManager imports those settings before loading that page.
const COPY_DIRS = ["audio", "meeting-results", "notes", "secure-keys", "Partitions"];

// Written last: a profile without it was interrupted mid-snapshot and the
// snapshot resumes on the next launch instead of staying half-empty forever.
const MARKER = ".dev-snapshot-complete";

const SUPPRESSED = ".dev-snapshot-suppressed";

function sourceProfileDir(): string {
  return path.join(app.getPath("appData"), "Gristmill");
}

function targetProfileDir(): string {
  return app.getPath("userData");
}

function ordinaryFileOrMissing(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
}

function ordinaryDirectoryOrMissing(dir: string): boolean {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
}

function clone(from: string, to: string): void {
  if (!ordinaryFileOrMissing(from) || !ordinaryFileOrMissing(to)) {
    throw new Error(`snapshot file path is not an ordinary file: ${from} -> ${to}`);
  }

  if (fs.existsSync(to) || !fs.existsSync(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE);
}

function assertOrdinaryTree(dir: string): void {
  if (!ordinaryDirectoryOrMissing(dir)) {
    throw new Error(`snapshot directory path is not an ordinary directory: ${dir}`);
  }

  if (!fs.existsSync(dir)) return;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);

    if (entry.isDirectory()) assertOrdinaryTree(child);
    else if (!entry.isFile())
      throw new Error(`snapshot does not support links or special files: ${child}`);
  }
}

function copyDir(from: string, to: string): void {
  if (!ordinaryDirectoryOrMissing(from) || !ordinaryDirectoryOrMissing(to)) {
    throw new Error(`snapshot directory path is not an ordinary directory: ${from} -> ${to}`);
  }

  if (!fs.existsSync(from)) return;

  if (!fs.existsSync(to)) {
    fs.mkdirSync(to, { recursive: true });
  }

  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);

    if (entry.isDirectory()) copyDir(src, dst);
    else if (entry.isFile()) clone(src, dst);
    else throw new Error(`snapshot does not support links or special files: ${src}`);
  }
}

function cloneDir(from: string, to: string): void {
  // One destination scan per copied tree catches links in dev-only branches
  // too; copyDir checks each source entry as it traverses it.
  assertOrdinaryTree(to);
  copyDir(from, to);
}

// TRUNCATE reports a blocked checkpoint as busy=1 in the result row instead
// of throwing; renaming a database whose WAL still holds unmerged commits
// would lose them, so a blocked checkpoint is a failure, not a warning.
function checkpointDatabase(file: string): boolean {
  try {
    const db = openSnapshotDatabase(file);

    try {
      const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();

      if (row?.busy !== 0) throw new Error("wal_checkpoint blocked by another reader");
    } finally {
      db.close();
    }

    return true;
  } catch (error) {
    debugLogger.warn(
      "database checkpoint failed; retrying on the next launch",
      { error: errorMessage(error) },
      "devSnapshot"
    );

    return false;
  }
}

function discardPlaintextCalendarTokens(file: string): void {
  const db = openSnapshotDatabase(file);

  try {
    db.exec("PRAGMA secure_delete = ON");

    const tables = new Set(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('google_calendar_tokens', 'microsoft_calendar_tokens')"
        )
        .all()
        .map((row) => row.name)
    );

    let changed = false;

    if (tables.has("google_calendar_tokens")) {
      changed =
        db
          .prepare(
            "DELETE FROM google_calendar_tokens WHERE access_token NOT GLOB ? OR refresh_token NOT GLOB ?"
          )
          .run("ohenc:v1:*", "ohenc:v1:*").changes > 0 || changed;
    }

    if (tables.has("microsoft_calendar_tokens")) {
      changed =
        db
          .prepare(
            "DELETE FROM microsoft_calendar_tokens WHERE access_token NOT GLOB ? OR refresh_token NOT GLOB ?"
          )
          .run("ohenc:v1:*", "ohenc:v1:*").changes > 0 || changed;
    }

    if (changed) {
      const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();

      if (checkpoint?.busy !== 0) throw new Error("calendar token WAL checkpoint failed");
    }
  } finally {
    db.close();
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

  try {
    discardPlaintextCalendarTokens(legacy);
  } catch (error) {
    debugLogger.warn(
      "legacy dev database could not be prepared; retrying on the next launch",
      {
        error: errorMessage(error),
      },
      "devSnapshot"
    );

    return false;
  }

  if (!checkpointDatabase(legacy)) return false;

  if (fs.existsSync(current)) {
    try {
      discardPlaintextCalendarTokens(current);
    } catch (error) {
      debugLogger.warn(
        "dev database could not be prepared; retrying on the next launch",
        {
          error: errorMessage(error),
        },
        "devSnapshot"
      );

      return false;
    }

    if (!checkpointDatabase(current)) return false;
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

  if (!ordinaryFileOrMissing(path.join(source, PROD_DB)) || !ordinaryFileOrMissing(destination)) {
    throw new Error("snapshot database path is not an ordinary file");
  }

  if (fs.existsSync(destination)) return true;
  fs.mkdirSync(target, { recursive: true });
  const staged = path.join(target, `.${name}.snapshot-${process.pid}.tmp`);
  fs.rmSync(staged, { force: true, recursive: true });

  try {
    const db = openSnapshotDatabase(path.join(source, PROD_DB), {
      readonly: true,
      fileMustExist: true,
    });

    try {
      db.exec(`VACUUM INTO '${staged.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }

    discardPlaintextCalendarTokens(staged);
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
      { error: errorMessage(error) },
      "devSnapshot"
    );

    return false;
  }
}

// Refuse a dev userData root that resolves to or contains the production
// profile before main creates it. Copy paths and database files are checked
// separately when the snapshot runs.
function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

// Does this resolved path live inside the production profile (or equal it)?
function reachesProduction(resolved: string, source: string): boolean {
  return resolved === source || resolved.startsWith(source + path.sep);
}

// Realpath, tolerating a missing tail: the deepest existing ancestor decides
// containment for a not-yet-created path (an explicit --user-data-dir inside
// production must be rejected before anything creates it).
function realpathDeep(p: string): string | null {
  let current = p;
  const tail: string[] = [];

  for (;;) {
    const resolved = realpathOrNull(current);

    if (resolved) return tail.length ? path.join(resolved, ...tail) : resolved;
    const parent = path.dirname(current);

    if (parent === current) return null;
    tail.unshift(path.basename(current));
    current = parent;
  }
}

export function profilePathAliasesProduction(targetProfile: string): boolean {
  const source = realpathOrNull(sourceProfileDir());

  if (!source) return false;
  // Equal or nested either way, including paths that do not exist yet: the
  // deepest existing ancestor decides (an explicit --user-data-dir inside
  // production must refuse before mkdir creates anything there).
  const target = realpathDeep(targetProfile);

  if (target && (reachesProduction(target, source) || reachesProduction(source, target))) {
    return true;
  }

  return false;
}

// Shallow startup check, including explicit --user-data-dir profiles that do
// not run the snapshot. The app itself can open these files or write into
// these directories after startup, even when the snapshot marker exists.
export function devProfileHasUnsafePaths(target = targetProfileDir()): boolean {
  if (profilePathAliasesProduction(target)) return true;
  const files = [PROD_DB, DEV_DB, ".env", MARKER, SUPPRESSED, ...COPY_FILES];

  for (const name of [PROD_DB, DEV_DB]) {
    files.push(`${name}-wal`, `${name}-shm`);
  }

  return (
    files.some((name) => !ordinaryFileOrMissing(path.join(target, name))) ||
    [...COPY_DIRS, "logs"].some((name) => !ordinaryDirectoryOrMissing(path.join(target, name)))
  );
}

// Explicit Reset All App Data is a lasting choice, including when the first
// snapshot never reached its completion marker. Refresh remains opt-in.
export function suppressDevSnapshotAfterReset(): void {
  const target = targetProfileDir();
  const file = path.join(target, SUPPRESSED);

  if (!ordinaryFileOrMissing(file))
    throw new Error("snapshot suppression path is not an ordinary file");
  fs.writeFileSync(file, `${new Date().toISOString()}\n`, { mode: 0o600 });
}

export function snapshotProductionProfileForDev(): boolean {
  const source = sourceProfileDir();
  const target = targetProfileDir();

  if (devProfileHasUnsafePaths(target)) {
    debugLogger.warn(
      "dev profile has an unsafe storage path; refusing to start",
      { source, target },
      "devSnapshot"
    );

    return false;
  }

  const refresh = process.env.GRISTMILL_REFRESH_SNAPSHOT === "1";

  if (fs.existsSync(path.join(target, SUPPRESSED)) && !refresh) return true;

  // Adoption is independent of the production snapshot: a dev-only profile
  // with pre-cutover notes must migrate even when no production profile
  // exists. Run it before any existence check would mistake the legacy file
  // for a completed snapshot (it has no marker). A failed adoption must stop
  // startup: the app would create an empty dev database and the legacy notes
  // would never be retried.
  if (!adoptLegacyDevDatabase(target)) return false;

  if (!fs.existsSync(path.join(source, PROD_DB))) return true;

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
      { error: errorMessage(error) },
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
