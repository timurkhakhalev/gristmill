const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-local-db-"));
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return { app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
process.env.NODE_ENV = "test";
const DatabaseManager = require("../../src/helpers/database.js");

test.after(() => {
  Module._load = originalLoad;
});

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-local-db-"));
  try {
    return new DatabaseManager();
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("NODE_MODULE_VERSION") || message.includes("Could not locate the bindings file")) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

test("clean profile seeds one private space and local folders", (t) => {
  const db = createDb(t);
  if (!db) return;
  assert.deepEqual(db.getSpaces().map((space) => space.kind), ["private"]);
  assert.deepEqual(db.getFolders().map((folder) => folder.name), ["Personal", "Meetings", "Videos"]);
  db.close();
});

test("notes and embedded chat remain local and scoped to containers", (t) => {
  const db = createDb(t);
  if (!db) return;
  const spaceId = db.getPrivateSpaceId();
  const folderId = db.getMeetingsFolder(spaceId).id;
  const note = db.saveNote("Meeting", "body", "meeting", null, null, folderId, spaceId).note;
  assert.equal(db.getNotesForSpace(spaceId)[0].id, note.id);
  const conversation = db.createAgentConversation("Questions", note.id, spaceId, folderId);
  db.addAgentMessage(conversation.id, "user", "What happened?");
  assert.equal(db.getConversationsForContainer(spaceId, folderId)[0].message_count, 1);
  db.close();
});

test("dictionary and snippets persist as local rows", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setDictionary([" Alpha ", "alpha", "Beta"]);
  db.setSnippets([{ trigger: " signoff ", replacement: " Regards " }]);
  assert.deepEqual(db.getDictionary(), ["Alpha", "Beta"]);
  assert.deepEqual(db.getSnippets(), [{ trigger: "signoff", replacement: "Regards" }]);
  const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  assert.equal(tables.includes("analytics_events"), false);
  assert.equal(tables.includes("space_accounts"), false);
  db.close();
});
