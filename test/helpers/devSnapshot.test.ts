import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installElectronStub, setUserDataDir, setAppDataDir } from "./harness/electronStub.js";

installElectronStub();
const { snapshotProductionProfileForDev, suppressDevSnapshotAfterReset, devProfileHasUnsafePaths } = require("../../src/helpers/devSnapshot.ts") as {
  snapshotProductionProfileForDev: () => boolean;
  suppressDevSnapshotAfterReset: () => void;
  devProfileHasUnsafePaths: (path?: string) => boolean;
};

function makeProfiles() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-dev-snapshot-"));
  const production = path.join(root, "OpenHercules");
  const development = path.join(root, "OpenHercules-development");
  fs.mkdirSync(path.join(production, "audio", "meetings", "rec-1"), { recursive: true });
  fs.mkdirSync(path.join(production, "meeting-results"), { recursive: true });
  // A minimal real SQLite database: VACUUM INTO requires a valid db and its
  // output must be a readable database with the same rows.
  const Database = require("better-sqlite3") as new (path: string) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => {
      get: () => { title: string; count: number };
      run: (...params: unknown[]) => unknown;
    };
    close: () => void;
  };
  const prodDb = new Database(path.join(production, "transcriptions.db"));
  prodDb.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT)");
  prodDb.exec("INSERT INTO notes (title) VALUES ('prod-note')");
  prodDb.close();
  fs.writeFileSync(
    path.join(production, ".env"),
    "KEY=1\nOPENAI_API_KEY=plaintext-provider-key\nOPENHERCULES_PROTOCOL=openhercules"
  );
  fs.writeFileSync(path.join(production, "audio", "meetings", "rec-1", "audio.pcm"), "pcm");
  fs.writeFileSync(path.join(production, "meeting-results", "run-1.json"), "{}");
  return { root, production, development, Database };
}

const DEV_DB = "transcriptions-dev.db";

function openDevDb(dir: string) {
  const Database = require("better-sqlite3") as new (path: string) => {
    prepare: (sql: string) => {
      get: () => { title: string; count: number };
      run: (...params: unknown[]) => unknown;
    };
    close: () => void;
  };
  return new Database(path.join(dir, DEV_DB));
}

test("snapshots production profile into a fresh dev profile", () => {
  const { development } = makeProfiles();
  setUserDataDir(development);
  snapshotProductionProfileForDev();
  // The dev channel opens transcriptions-dev.db: the VACUUM INTO snapshot
  // must land there as a consistent, readable database.
  const devDb = openDevDb(development);
  assert.equal(devDb.prepare("SELECT title FROM notes").get().title, "prod-note");
  devDb.close();
  // The .env is copied without the channel-owned OAuth scheme selectors.
  const copiedEnv = fs.readFileSync(path.join(development, ".env"), "utf8");
  assert.ok(copiedEnv.includes('KEY="1"'));
  assert.ok(!copiedEnv.includes("plaintext-provider-key"));
  assert.ok(!copiedEnv.includes("OPENHERCULES_PROTOCOL"));
  assert.equal(
    fs.readFileSync(path.join(development, "audio", "meetings", "rec-1", "audio.pcm"), "utf8"),
    "pcm"
  );
  assert.equal(
    fs.readFileSync(path.join(development, "meeting-results", "run-1.json"), "utf8"),
    "{}"
  );
  assert.equal(fs.existsSync(path.join(development, ".dev-snapshot-complete")), true);
});

test("snapshot strips legacy plaintext calendar tokens from the dev database", () => {
  const { production, development, Database } = makeProfiles();
  const prodDb = new Database(path.join(production, "transcriptions.db"));
  prodDb.exec(`
    CREATE TABLE google_calendar_tokens (
      google_email TEXT, access_token TEXT, refresh_token TEXT, expires_at INTEGER, scope TEXT
    );
    CREATE TABLE microsoft_calendar_tokens (
      microsoft_email TEXT, access_token TEXT, refresh_token TEXT, expires_at INTEGER, scope TEXT
    );
  `);
  prodDb.prepare(
    "INSERT INTO google_calendar_tokens VALUES (?, ?, ?, ?, ?)"
  ).run("google@example.com", "legacy-google-access", "legacy-google-refresh", 1, "calendar");
  prodDb.prepare(
    "INSERT INTO microsoft_calendar_tokens VALUES (?, ?, ?, ?, ?)"
  ).run("microsoft@example.com", "legacy-ms-access", "legacy-ms-refresh", 1, "calendar");
  prodDb.close();

  setUserDataDir(development);
  assert.equal(snapshotProductionProfileForDev(), true);

  const devDb = new Database(path.join(development, DEV_DB));
  assert.equal(devDb.prepare("SELECT COUNT(*) AS count FROM google_calendar_tokens").get().count, 0);
  assert.equal(devDb.prepare("SELECT COUNT(*) AS count FROM microsoft_calendar_tokens").get().count, 0);
  devDb.close();

  const source = fs.readFileSync(path.join(production, "transcriptions.db"));
  assert.ok(source.includes(Buffer.from("legacy-google-access")), "the production database is unchanged");
});

test("does not re-snapshot a completed dev profile", () => {
  const { development } = makeProfiles();
  setUserDataDir(development);
  snapshotProductionProfileForDev();
  fs.rmSync(path.join(development, ".env"));
  snapshotProductionProfileForDev();
  assert.equal(fs.existsSync(path.join(development, ".env")), false, "the marker must gate reruns");
});

test("reset prevents deleted notes from being restored on the next launch", () => {
  const { development } = makeProfiles();
  setUserDataDir(development);
  snapshotProductionProfileForDev();
  suppressDevSnapshotAfterReset();
  fs.rmSync(path.join(development, DEV_DB));
  assert.equal(snapshotProductionProfileForDev(), true);
  assert.equal(fs.existsSync(path.join(development, DEV_DB)), false);
  assert.equal(fs.existsSync(path.join(development, ".dev-snapshot-suppressed")), true);
});

test("reset before the first marker prevents a retry unless refresh is requested", () => {
  const { development } = makeProfiles();
  fs.mkdirSync(development, { recursive: true });
  setUserDataDir(development);
  suppressDevSnapshotAfterReset();
  assert.equal(snapshotProductionProfileForDev(), true);
  assert.equal(fs.existsSync(path.join(development, DEV_DB)), false);
  process.env.OPENHERCULES_REFRESH_SNAPSHOT = "1";
  try {
    assert.equal(snapshotProductionProfileForDev(), true);
  } finally {
    delete process.env.OPENHERCULES_REFRESH_SNAPSHOT;
  }
  const db = openDevDb(development);
  assert.equal(db.prepare("SELECT title FROM notes").get().title, "prod-note");
  db.close();
});

test("snapshots a surviving WAL without checkpointing or changing production files", () => {
  const { production, development } = makeProfiles();
  const source = path.join(production, "transcriptions.db");
  // A process exiting without close leaves WAL data behind. With no other
  // connection open, the old writable source handle checkpointed on close.
  const child = spawnSync(process.execPath, ["-e", `
    const Database = require("better-sqlite3");
    const db = new Database(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    db.exec("INSERT INTO notes (title) VALUES ('wal-note')");
    process.exit(0);
  `, source], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(fs.existsSync(`${source}-wal`), true);
  const beforeDb = fs.readFileSync(source);
  const beforeWal = fs.readFileSync(`${source}-wal`);
  setUserDataDir(development);
  assert.equal(snapshotProductionProfileForDev(), true);
  assert.deepEqual(fs.readFileSync(source), beforeDb);
  assert.deepEqual(fs.readFileSync(`${source}-wal`), beforeWal);
  const devDb = openDevDb(development);
  assert.equal(
    devDb.prepare("SELECT title FROM notes WHERE title = 'wal-note'").get().title,
    "wal-note"
  );
  devDb.close();
});

test("shallow startup check rejects direct links even without a snapshot", () => {
  const { production, development } = makeProfiles();
  fs.mkdirSync(development, { recursive: true });
  setUserDataDir(development);
  fs.symlinkSync(path.join(production, "transcriptions.db"), path.join(development, DEV_DB));
  assert.equal(devProfileHasUnsafePaths(development), true, "explicit smoke profile DB link");
  fs.unlinkSync(path.join(development, DEV_DB));
  fs.symlinkSync(path.join(production, "audio"), path.join(development, "audio"));
  assert.equal(devProfileHasUnsafePaths(development), true, "completed profile copy root link");
  fs.unlinkSync(path.join(development, "audio"));
  fs.symlinkSync(path.join(production, ".env"), path.join(development, ".env"));
  assert.equal(devProfileHasUnsafePaths(development), true, "completed profile .env link");
});

test("keeps a dev database even when the marker is missing (interrupted snapshot)", () => {
  const { development } = makeProfiles();
  fs.mkdirSync(development, { recursive: true });
  // A crash after the database landed but before the marker: the dev
  // database is never replaced — only the missing files are filled in.
  const { Database } = makeProfiles();
  const devDb = new Database(path.join(development, DEV_DB));
  devDb.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT)");
  devDb.exec("INSERT INTO notes (title) VALUES ('dev-note')");
  devDb.close();
  setUserDataDir(development);
  snapshotProductionProfileForDev();
  const check = openDevDb(development);
  assert.equal(check.prepare("SELECT title FROM notes").get().title, "dev-note");
  check.close();
  assert.equal(fs.existsSync(path.join(development, ".env")), true);
  assert.equal(fs.existsSync(path.join(development, ".dev-snapshot-complete")), true);
});

test("refresh re-copies missing files but keeps dev-only ones", () => {
  const { development } = makeProfiles();
  setUserDataDir(development);
  snapshotProductionProfileForDev();
  fs.rmSync(path.join(development, ".env"));
  fs.writeFileSync(path.join(development, "dev-only.txt"), "keep");
  process.env.OPENHERCULES_REFRESH_SNAPSHOT = "1";
  try {
    snapshotProductionProfileForDev();
  } finally {
    delete process.env.OPENHERCULES_REFRESH_SNAPSHOT;
  }
  assert.ok(fs.readFileSync(path.join(development, ".env"), "utf8").includes('KEY="1"'));
  assert.equal(fs.readFileSync(path.join(development, "dev-only.txt"), "utf8"), "keep");
});

test("refuses to start into a dev profile symlinked to production", () => {
  const { root, production } = makeProfiles();
  const link = path.join(root, "dev-link");
  fs.symlinkSync(production, link);
  setUserDataDir(link);
  const ok = snapshotProductionProfileForDev();
  // Not just "writes nothing": startup must refuse, or the app would open
  // its database inside the production profile through the alias.
  assert.equal(ok, false);
  assert.equal(fs.existsSync(path.join(production, ".dev-snapshot-complete")), false);
  assert.equal(fs.existsSync(path.join(production, DEV_DB)), false);
});

test("refuses to start into a profile nested inside the production profile", () => {
  // Real layout: appData is shared (~/Library/Application Support); the dev
  // profile nests inside the production profile through an explicit path.
  const { Database } = makeProfiles();
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), "oh-dev-snapshot-appdata-"));
  const production = path.join(appData, "OpenHercules");
  fs.mkdirSync(production, { recursive: true });
  const db = new Database(path.join(production, "transcriptions.db"));
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT)");
  db.close();
  const nested = path.join(production, "nested-dev");
  fs.mkdirSync(nested, { recursive: true });
  setUserDataDir(nested);
  setAppDataDir(appData);
  const ok = snapshotProductionProfileForDev();
  assert.equal(ok, false, "userData inside production must refuse to start");
});

test("refuses to start when the dev database symlinks into production", () => {
  const { production, development } = makeProfiles();
  fs.mkdirSync(development, { recursive: true });
  fs.symlinkSync(
    path.join(production, "transcriptions.db"),
    path.join(development, DEV_DB)
  );
  setUserDataDir(development);
  const ok = snapshotProductionProfileForDev();
  assert.equal(ok, false, "a dev database pointing into production must refuse to start");
});

test("refuses to start when a legacy database symlinks into production", () => {
  const { production, development } = makeProfiles();
  fs.mkdirSync(development, { recursive: true });
  fs.symlinkSync(
    path.join(production, "transcriptions.db"),
    path.join(development, "transcriptions.db")
  );
  setUserDataDir(development);
  const ok = snapshotProductionProfileForDev();
  assert.equal(
    ok, false,
    "a legacy database pointing into production must refuse before adoption opens it"
  );
});

test("refuses to start when a storage tree symlinks into production", () => {
  const { production, development } = makeProfiles();
  fs.mkdirSync(development, { recursive: true });
  fs.symlinkSync(path.join(production, "audio"), path.join(development, "audio"));
  setUserDataDir(development);
  const ok = snapshotProductionProfileForDev();
  assert.equal(ok, false, "a storage tree pointing into production must refuse to start");
});

test("refuses to start when .env symlinks into production", () => {
  const { production, development } = makeProfiles();
  fs.mkdirSync(development, { recursive: true });
  fs.symlinkSync(path.join(production, ".env"), path.join(development, ".env"));
  setUserDataDir(development);
  const ok = snapshotProductionProfileForDev();
  assert.equal(ok, false, "a .env pointing into production must refuse to start");
});

test("refuses to start when a nested link inside a storage tree reaches production", () => {
  const { production, development } = makeProfiles();
  fs.mkdirSync(path.join(development, "audio", "meetings"), { recursive: true });
  fs.symlinkSync(
    path.join(production, "meeting-results"),
    path.join(development, "audio", "meetings", "prod-link")
  );
  setUserDataDir(development);
  const ok = snapshotProductionProfileForDev();
  assert.equal(
    ok, false,
    "a link nested inside a copied tree must refuse before the snapshot writes through it"
  );
});

test("refuses a not-yet-existing profile path inside production", () => {
  const { production, root } = makeProfiles();
  const { profilePathAliasesProduction } = require("../../src/helpers/devSnapshot.ts") as {
    profilePathAliasesProduction: (p: string) => boolean;
  };
  // Point the stub's appData at this pair's root so sourceProfileDir matches.
  setUserDataDir(path.join(root, "OpenHercules-development"));
  const planned = path.join(production, "smoke-inside-prod");
  assert.equal(
    profilePathAliasesProduction(planned),
    true,
    "a nonexistent path inside production must refuse before anything is created there"
  );
});

test("adopts a legacy packaged-Dev database instead of losing it", () => {
  const { development, Database } = makeProfiles();
  fs.mkdirSync(development, { recursive: true });
  // Pre-cutover packaged Dev app: dev-made notes under transcriptions.db.
  const legacy = new Database(path.join(development, "transcriptions.db"));
  legacy.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT)");
  legacy.exec("INSERT INTO notes (title) VALUES ('legacy-dev-note')");
  legacy.close();
  setUserDataDir(development);
  const ok = snapshotProductionProfileForDev();
  assert.equal(ok, true);
  const check = openDevDb(development);
  assert.equal(check.prepare("SELECT title FROM notes").get().title, "legacy-dev-note");
  check.close();
  assert.equal(fs.existsSync(path.join(development, "transcriptions.db")), false);
});

test("a profile with both pre-cutover databases keeps the legacy set as a backup", () => {
  const { development, Database } = makeProfiles();
  fs.mkdirSync(development, { recursive: true });
  // Pre-cutover mixed use: pnpm dev notes + packaged Dev notes.
  const legacy = new Database(path.join(development, "transcriptions.db"));
  legacy.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT)");
  legacy.exec("INSERT INTO notes (title) VALUES ('packaged-dev-note')");
  legacy.close();
  const pnpm = new Database(path.join(development, DEV_DB));
  pnpm.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT)");
  pnpm.exec("INSERT INTO notes (title) VALUES ('pnpm-dev-note')");
  pnpm.close();
  setUserDataDir(development);
  const ok = snapshotProductionProfileForDev();
  assert.equal(ok, true);
  const check = openDevDb(development);
  assert.equal(check.prepare("SELECT title FROM notes").get().title, "pnpm-dev-note");
  check.close();
  // The packaged-Dev set survives as a visible backup, never merged or lost.
  // The name carries a timestamp; find it instead of pinning it.
  const backupName = fs
    .readdirSync(development)
    .find((name) => /^transcriptions-legacy-dev-backup.*\.db$/.test(name));
  assert.ok(backupName, "a legacy backup database must exist");
  const backup = new Database(path.join(development, backupName as string));
  assert.equal(backup.prepare("SELECT title FROM notes").get().title, "packaged-dev-note");
  backup.close();
  assert.equal(fs.existsSync(path.join(development, "transcriptions.db")), false);
});

test("refuses to start when the database snapshot fails and none exists", () => {
  const { production, development } = makeProfiles();
  // Corrupt the production database: opening it must fail, forcing the
  // consistent-snapshot path to fail while no dev database exists yet.
  fs.writeFileSync(path.join(production, "transcriptions.db"), "not a sqlite database");
  setUserDataDir(development);
  const ok = snapshotProductionProfileForDev();
  assert.equal(ok, false, "a failed db snapshot without an existing db must refuse to start");
  assert.equal(fs.existsSync(path.join(development, DEV_DB)), false);
  assert.equal(fs.existsSync(path.join(development, ".dev-snapshot-complete")), false);
});

test("refuses to start when legacy adoption fails, keeping the retry", () => {
  const { development } = makeProfiles();
  fs.mkdirSync(development, { recursive: true });
  // A dev-only legacy profile whose database cannot be checkpointed.
  fs.writeFileSync(path.join(development, "transcriptions.db"), "not a sqlite database");
  setUserDataDir(development);
  const ok = snapshotProductionProfileForDev();
  assert.equal(ok, false, "a failed adoption must refuse to start");
  assert.equal(fs.existsSync(path.join(development, DEV_DB)), false);
  // The legacy file is untouched, so the next launch retries adoption.
  assert.equal(fs.existsSync(path.join(development, "transcriptions.db")), true);
});

test("no-op without a production profile", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-dev-snapshot-"));
  const development = path.join(root, "OpenHercules-development");
  setUserDataDir(development);
  snapshotProductionProfileForDev();
  assert.equal(fs.existsSync(development), false);
});
