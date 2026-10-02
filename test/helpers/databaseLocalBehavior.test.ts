const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test") = require("node:test");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-local-db-"));
const originalLoad = Module._load;
Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return { app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
process.env.NODE_ENV = "test";
const DatabaseManager = require("../../src/helpers/database.ts");

test.after(() => {
  Module._load = originalLoad;
});

function createDb(t: import("node:test").TestContext) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-local-db-"));
  try {
    return new DatabaseManager();
  } catch (error) {
    const message = String((error as { message?: unknown })?.message || error);
    if (message.includes("NODE_MODULE_VERSION") || message.includes("Could not locate the bindings file")) {
      if (process.env.REQUIRE_DB_TESTS) throw error;
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

test("clean profile seeds one private space and local folders", (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  assert.deepEqual(db.getSpaces().map((space: any) => space.kind), ["private"]);
  assert.deepEqual(db.getFolders().map((folder: any) => folder.name), ["Personal"]);
  db.close();
});

test("notes and embedded chat remain local and scoped to containers", (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const spaceId = db.getPrivateSpaceId();
  const folderId = db.createFolder("Meetings", spaceId).folder.id;
  const note = db.saveNote("Meeting", "body", "meeting", null, null, folderId, spaceId).note;
  assert.equal(db.getNotesForSpace(spaceId)[0].id, note.id);
  const conversation = db.createAgentConversation("Questions", note.id, spaceId, folderId);
  db.addAgentMessage(conversation.id, "user", "What happened?");
  assert.equal(db.getConversationsForContainer(spaceId, folderId)[0].message_count, 1);
  db.close();
});

test("dictionary and snippets persist as local rows", (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  db.setDictionary([" Alpha ", "alpha", "Beta"]);
  db.setSnippets([{ trigger: " signoff ", replacement: " Regards " }]);
  assert.deepEqual(db.getDictionary(), ["Alpha", "Beta"]);
  assert.deepEqual(db.getSnippets(), [{ trigger: "signoff", replacement: "Regards" }]);
  const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row: any) => row.name);
  assert.equal(tables.includes("analytics_events"), false);
  assert.equal(tables.includes("space_accounts"), false);
  db.close();
});


test("Personal can be renamed and deleted without deleting notes or reseeding folders", (t) => {
  const db = createDb(t);
  if (!db) return;
  const folder = db.getFolders()[0];
  const note = db.saveNote("Keep me", "body", "personal", null, null, folder.id).note;
  assert.equal(db.renameFolder(folder.id, "My notes").success, true);
  assert.equal(db.deleteFolder(folder.id).success, true);
  assert.equal(db.getNote(note.id).folder_id, null);
  assert.equal(db.getNote(note.id).content, "body");
  db.close();
  const reopened = new DatabaseManager();
  assert.deepEqual(reopened.getFolders(), []);
  assert.equal(reopened.saveNote("Root", "").note.folder_id, null);
  reopened.close();
});

test("folder and note icons persist, trim and clear", (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const spaceId = db.getPrivateSpaceId();
  const folderId = db.createFolder("Meetings", spaceId).folder.id;
  const noteId = db.saveNote("Idea", "body", "personal", null, null, folderId, spaceId).note.id;

  assert.equal(db.updateFolderStyle(folderId, { icon: " 🚀 " }).folder.icon, "🚀");
  assert.equal(db.updateNote(noteId, { icon: "💡" }).note.icon, "💡");
  assert.equal(db.getFolders().find((folder: any) => folder.id === folderId).icon, "🚀");
  assert.equal(db.updateFolderStyle(folderId, { icon: null }).folder.icon, null);
  assert.equal(db.updateNote(noteId, { icon: null }).note.icon, null);

  assert.equal(db.updateFolderStyle(folderId, { color: "blue" }).folder.color, "blue");
  assert.equal(db.updateFolderStyle(folderId, { color: "not-a-color" }).folder.color, null);

  const second = db.createFolder("Videos", spaceId).folder.id;
  const third = db.createFolder("Clients", spaceId).folder.id;
  db.reorderFolders(spaceId, [third, second, folderId]);
  assert.deepEqual(db.getFolders(spaceId).map((folder: any) => folder.id).filter((id: number) => [folderId, second, third].includes(id)), [third, second, folderId]);
  db.close();
});
