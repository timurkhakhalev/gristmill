import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installElectronStub, setUserDataDir } from "./harness/electronStub.js";

installElectronStub();
const { snapshotProductionProfileForDev } = require("../../src/helpers/devSnapshot.ts") as {
  snapshotProductionProfileForDev: () => void;
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
    prepare: (sql: string) => { get: () => { title: string } };
    close: () => void;
  };  const prodDb = new Database(path.join(production, "transcriptions.db"));
  prodDb.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT)");
  prodDb.exec("INSERT INTO notes (title) VALUES ('prod-note')");
  prodDb.close();
  fs.writeFileSync(path.join(production, ".env"), "KEY=1");
  fs.writeFileSync(path.join(production, "audio", "meetings", "rec-1", "audio.pcm"), "pcm");
  fs.writeFileSync(path.join(production, "meeting-results", "run-1.json"), "{}");
  return { root, production, development, Database };
}

const DEV_DB = "transcriptions-dev.db";

function openDevDb(dir: string) {
  const Database = require("better-sqlite3") as new (path: string) => {
    prepare: (sql: string) => { get: () => { title: string } };
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
  assert.equal(fs.readFileSync(path.join(development, ".env"), "utf8"), "KEY=1");
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

test("does not re-snapshot a completed dev profile", () => {
  const { development } = makeProfiles();
  setUserDataDir(development);
  snapshotProductionProfileForDev();
  fs.rmSync(path.join(development, ".env"));
  snapshotProductionProfileForDev();
  assert.equal(fs.existsSync(path.join(development, ".env")), false, "the marker must gate reruns");
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
  assert.equal(fs.readFileSync(path.join(development, ".env"), "utf8"), "KEY=1");
  assert.equal(fs.readFileSync(path.join(development, "dev-only.txt"), "utf8"), "keep");
});

test("never snapshots into a dev profile symlinked to production", () => {
  const { root, production } = makeProfiles();
  const link = path.join(root, "dev-link");
  fs.symlinkSync(production, link);
  setUserDataDir(link);
  snapshotProductionProfileForDev();
  assert.equal(fs.existsSync(path.join(production, ".dev-snapshot-complete")), false);
  assert.equal(fs.existsSync(path.join(production, DEV_DB)), false);
});

test("no-op without a production profile", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-dev-snapshot-"));
  const development = path.join(root, "OpenHercules-development");
  setUserDataDir(development);
  snapshotProductionProfileForDev();
  assert.equal(fs.existsSync(development), false);
});
