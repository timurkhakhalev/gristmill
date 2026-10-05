const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const os: typeof import("node:os") = require("node:os");

const path: typeof import("node:path") = require("node:path");

const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-translation-db-"));

const originalLoad = Module._load;

Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager: typeof import("../../src/helpers/database.ts").DatabaseManager = require("../../src/helpers/database.ts");

const { skipOrFail }: typeof import("./harness/db.ts") = require("./harness/db.ts");

function createDb(t: import("node:test").TestContext) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-translation-db-"));

  try {
    const BetterSqlite = require("better-sqlite3");
    const probe = new BetterSqlite(path.join(userDataDir, "probe.db"));
    probe.close();
    fs.rmSync(path.join(userDataDir, "probe.db"), { force: true });
  } catch (error) {
    skipOrFail(t, error);

    return null;
  }

  try {
    return new DatabaseManager();
  } catch (error) {
    skipOrFail(t, error);

    return null;
  }
}

function findById(rows: import("../../src/helpers/database.ts").TranscriptionRow[], id: number) {
  return rows.find((row) => row.id === id) || null;
}

test("saveTranscription with routeKind translation round-trips route_kind", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;

  const { id } = db.saveTranscription("Ciao", "Hello", { routeKind: "translation" });
  const row = findById(db.getTranscriptions(), id);

  assert.ok(row);
  assert.equal(row.route_kind, "translation");
});

test("saveTranscription without routeKind stores route_kind null", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;

  const { id } = db.saveTranscription("plain text");
  const row = findById(db.getTranscriptions(), id);

  assert.ok(row);
  assert.equal(row.route_kind, null);
});

test("discarded save keeps its routeKind", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;

  const { id } = db.saveTranscription("", "Hello", {
    status: "discarded",
    routeKind: "translation",
  });

  // Discarded rows are filtered out of the default listing.
  assert.equal(findById(db.getTranscriptions(), id), null);

  const row = findById(db.getTranscriptions(50, { includeDiscarded: true }), id);
  assert.ok(row);
  assert.equal(row.status, "discarded");
  assert.equal(row.route_kind, "translation");
});

test("updateTranscriptionText does not clobber route_kind", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;

  const { id } = db.saveTranscription("Ciao", "Hello", { routeKind: "translation" });
  db.updateTranscriptionText(id, "Salve", "Hello");

  const row = findById(db.getTranscriptions(), id);
  assert.ok(row);
  assert.equal(row.text, "Salve");
  assert.equal(row.raw_text, "Hello");
  assert.equal(row.route_kind, "translation");
});
