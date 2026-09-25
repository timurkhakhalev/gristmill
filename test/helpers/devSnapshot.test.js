const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { installElectronStub, setUserDataDir } = require("./harness/electronStub.js");

installElectronStub();
const { snapshotProductionProfileForDev } = require("../../src/helpers/devSnapshot.ts");

function makeProfiles() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-dev-snapshot-"));
  const production = path.join(root, "OpenHercules");
  const development = path.join(root, "OpenHercules-development");
  fs.mkdirSync(path.join(production, "audio", "meetings", "rec-1"), { recursive: true });
  fs.mkdirSync(path.join(production, "meeting-results"), { recursive: true });
  fs.writeFileSync(path.join(production, "transcriptions.db"), "prod-db");
  fs.writeFileSync(path.join(production, "transcriptions.db-wal"), "prod-wal");
  fs.writeFileSync(path.join(production, ".env"), "KEY=1");
  fs.writeFileSync(path.join(production, "audio", "meetings", "rec-1", "audio.pcm"), "pcm");
  fs.writeFileSync(path.join(production, "meeting-results", "run-1.json"), "{}");
  return { root, production, development };
}

test("snapshots production profile into a fresh dev profile", () => {
  const { development } = makeProfiles();
  setUserDataDir(development);
  snapshotProductionProfileForDev();
  assert.equal(fs.readFileSync(path.join(development, "transcriptions.db"), "utf8"), "prod-db");
  assert.equal(fs.readFileSync(path.join(development, "transcriptions.db-wal"), "utf8"), "prod-wal");
  // The dev build opens transcriptions-dev.db — production notes must land there.
  assert.equal(
    fs.readFileSync(path.join(development, "transcriptions-dev.db"), "utf8"),
    "prod-db"
  );
  assert.equal(
    fs.readFileSync(path.join(development, "transcriptions-dev.db-wal"), "utf8"),
    "prod-wal"
  );
  assert.equal(fs.readFileSync(path.join(development, ".env"), "utf8"), "KEY=1");
  assert.equal(
    fs.readFileSync(path.join(development, "audio", "meetings", "rec-1", "audio.pcm"), "utf8"),
    "pcm"
  );
  assert.equal(fs.readFileSync(path.join(development, "meeting-results", "run-1.json"), "utf8"), "{}");
});

test("does not overwrite an existing dev profile", () => {
  const { development } = makeProfiles();
  fs.mkdirSync(development, { recursive: true });
  fs.writeFileSync(path.join(development, "transcriptions-dev.db"), "dev-db");
  setUserDataDir(development);
  snapshotProductionProfileForDev();
  assert.equal(fs.readFileSync(path.join(development, "transcriptions-dev.db"), "utf8"), "dev-db");
});

test("refresh re-copies missing files but keeps dev-only ones", () => {
  const { development } = makeProfiles();
  fs.mkdirSync(development, { recursive: true });
  fs.writeFileSync(path.join(development, "transcriptions-dev.db"), "dev-db");
  fs.writeFileSync(path.join(development, "dev-only.txt"), "keep");
  setUserDataDir(development);
  process.env.OPENHERCULES_REFRESH_SNAPSHOT = "1";
  try {
    snapshotProductionProfileForDev();
  } finally {
    delete process.env.OPENHERCULES_REFRESH_SNAPSHOT;
  }
  assert.equal(fs.readFileSync(path.join(development, "transcriptions-dev.db"), "utf8"), "dev-db");
  assert.equal(fs.readFileSync(path.join(development, ".env"), "utf8"), "KEY=1");
  assert.equal(fs.readFileSync(path.join(development, "dev-only.txt"), "utf8"), "keep");
});

test("no-op without a production profile", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-dev-snapshot-"));
  const development = path.join(root, "OpenHercules-development");
  setUserDataDir(development);
  snapshotProductionProfileForDev();
  assert.equal(fs.existsSync(development), false);
});
