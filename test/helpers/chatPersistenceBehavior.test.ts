const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const Module = require("node:module");

// Characterization for the thirteen agent-conversation persistence channels.
// The JS handlers are pure delegation, so the real DatabaseManager over a
// temporary SQLite file IS the behavior being pinned before the typed
// cutover: defaults, filters, null results, metadata serialization and
// cascades must survive the move unchanged.
let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-chat-persist-"));
const originalLoad = Module._load;
Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return { app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
process.env.NODE_ENV = "test";
const DatabaseManager = require("../../src/helpers/database.ts");
import type { AgentConversationRow, ConversationPreviewRow } from "../../src/helpers/database.ts";

test.after(() => {
  Module._load = originalLoad;
});

function isNativeBindingUnavailable(error: unknown) {
  const message = String((error as { message?: unknown })?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function createDb(t: import("node:test").TestContext) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-chat-persist-"));
  try {
    return new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

test("create defaults: title omitted becomes Untitled and scopes stay null", (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const conv = db.createAgentConversation();
  assert.equal(conv.title, "Untitled");
  assert.equal(conv.note_id, null);
  assert.equal(conv.space_id, null);
  assert.equal(conv.folder_id, null);
  assert.equal(conv.archived_at, null);
  assert.equal(typeof conv.created_at, "string");
  assert.deepEqual(conv.messages, []);
  // undefined hits the JS default; an explicit null violates the NOT NULL
  // constraint and must keep rejecting without creating a row.
  assert.equal(db.createAgentConversation(undefined).title, "Untitled");
  assert.throws(() => db.createAgentConversation(null), /NOT NULL/);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM agent_conversations").get().n, 2);
  db.close();
});

test("getAgentConversation returns the row plus messages, null when missing", (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const conv = db.createAgentConversation("Chat", null, null, null);
  db.addAgentMessage(conv.id, "user", "hello", { toolCalls: [{ id: "t1" }] });
  const loaded = db.getAgentConversation(conv.id);
  assert.equal(loaded.id, conv.id);
  assert.equal(loaded.messages.length, 1);
  assert.equal(loaded.messages[0].role, "user");
  assert.equal(loaded.messages[0].content, "hello");
  // Metadata round-trips as the serialized JSON string on read.
  assert.deepEqual(JSON.parse(loaded.messages[0].metadata), {
    toolCalls: [{ id: "t1" }],
  });
  assert.equal(db.getAgentConversation(987654), null);
  db.close();
});

test("getAgentConversations defaults to 50 and excludes archived", (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  for (let i = 0; i < 3; i++) db.createAgentConversation(`c${i}`);
  const archived = db.createAgentConversation("archived");
  db.archiveAgentConversation(archived.id);
  const list = db.getAgentConversations();
  assert.equal(list.length, 3);
  assert.equal(list.some((c: AgentConversationRow) => c.id === archived.id), false);
  // Rows are plain SELECT *: no message_count, no preview.
  assert.equal("message_count" in list[0], false);
  assert.equal("preview" in list[0], false);
  assert.deepEqual(db.getAgentConversations(2).length, 2);
  db.close();
});

test("getConversationsForNote defaults to 20 and includes archived rows", (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const note = db.saveNote("Note", "body", "personal", null, null, null, db.getPrivateSpaceId()).note;
  const a = db.createAgentConversation("a", note.id);
  const b = db.createAgentConversation("b", note.id);
  db.archiveAgentConversation(b.id);
  const list = db.getConversationsForNote(note.id);
  assert.deepEqual(list.map((c: AgentConversationRow) => c.id).sort(), [a.id, b.id].sort());
  // Plain rows: the SQL carries no message_count despite old renderer types.
  assert.equal("message_count" in list[0], false);
  assert.deepEqual(db.getConversationsForNote(987654), []);
  db.close();
});

test("getConversationsForContainer: null folder picks the space root only", (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const spaceId = db.getPrivateSpaceId();
  const folder = db.createFolder("F", spaceId).folder;
  const root = db.createAgentConversation("root", null, spaceId, null);
  const inner = db.createAgentConversation("inner", null, spaceId, folder.id);
  const other = db.createAgentConversation("note-attached", null, null, null);

  const rootList = db.getConversationsForContainer(spaceId, null);
  assert.deepEqual(rootList.map((c: AgentConversationRow) => c.id), [root.id]);
  // Container list adds message_count on top of the row.
  assert.equal(rootList[0].message_count, 0);
  db.addAgentMessage(root.id, "user", "hi");
  assert.equal(db.getConversationsForContainer(spaceId, null)[0].message_count, 1);

  const folderList = db.getConversationsForContainer(spaceId, folder.id);
  assert.deepEqual(folderList.map((c: AgentConversationRow) => c.id), [inner.id]);
  // Note-attached (space_id null) never leaks into the container list.
  assert.equal(rootList.some((c: AgentConversationRow) => c.id === other.id), false);
  db.close();
});

test("addAgentMessage bumps the conversation, null for a missing one", (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const conv = db.createAgentConversation("chat");
  assert.equal(db.addAgentMessage(987654, "user", "x"), null);
  const created_at = db.getAgentConversation(conv.id).created_at;
  const message = db.addAgentMessage(conv.id, "assistant", "answer", { toolCalls: [] });
  assert.equal(message.conversation_id, conv.id);
  assert.equal(message.role, "assistant");
  assert.deepEqual(JSON.parse(message.metadata), { toolCalls: [] });
  // Falsy metadata stays null instead of the string "null".
  assert.equal(db.addAgentMessage(conv.id, "user", "again", null).metadata, null);
  // The message write fires the UPDATE even in the same clock second
  // (CURRENT_TIMESTAMP granularity), so updated_at >= created_at after it.
  const convAfter = db.getAgentConversation(conv.id);
  assert.equal(convAfter.updated_at >= convAfter.created_at, true);
  assert.equal(convAfter.updated_at >= created_at, true);
  db.close();
});

test("getAgentMessages returns conversation rows in creation order", (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const conv = db.createAgentConversation("chat");
  db.addAgentMessage(conv.id, "user", "one");
  db.addAgentMessage(conv.id, "assistant", "two", { toolCalls: [{ id: "t" }] });
  const messages = db.getAgentMessages(conv.id);
  assert.deepEqual(
    messages.map((m: { role: string; content: string }) => [m.role, m.content]),
    [
      ["user", "one"],
      ["assistant", "two"],
    ]
  );
  assert.deepEqual(db.getAgentMessages(987654), []);
  db.close();
});

test("preview pagination skips rows and preview falls back to null", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const empty = db.createAgentConversation("empty");
  const first = db.createAgentConversation("first");
  db.addAgentMessage(first.id, "user", "oldest answer");
  const second = db.createAgentConversation("second");
  db.addAgentMessage(second.id, "assistant", "newest answer");
  const setUpdatedAt = db.db.prepare("UPDATE agent_conversations SET updated_at = ? WHERE id = ?");
  setUpdatedAt.run("2026-01-01 00:00:00", empty.id);
  setUpdatedAt.run("2026-01-02 00:00:00", first.id);
  setUpdatedAt.run("2026-01-03 00:00:00", second.id);

  const page = db.getAgentConversationsWithPreview(50, 0, false);
  // Newest first; an empty chat keeps preview null, the others carry their
  // last message content.
  assert.deepEqual(
    page.map((c: ConversationPreviewRow) => [c.id, c.preview]),
    [
      [second.id, "newest answer"],
      [first.id, "oldest answer"],
      [empty.id, null],
    ]
  );

  // Page 2 holds the older remainder.
  const offsetPage = db.getAgentConversationsWithPreview(2, 2, false);
  assert.deepEqual(offsetPage.map((c: ConversationPreviewRow) => c.id), [empty.id]);

  // Archived rows are hidden until includeArchived.
  db.archiveAgentConversation(second.id);
  assert.equal(db.getAgentConversationsWithPreview(50, 0, false).some((c: ConversationPreviewRow) => c.id === second.id), false);
  assert.equal(db.getAgentConversationsWithPreview(50, 0, true).some((c: ConversationPreviewRow) => c.id === second.id), true);
  db.close();
});

test("searchAgentConversations is a plain title LIKE with the empty-match-all", (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const hit = db.createAgentConversation("Growth plan");
  db.createAgentConversation("Other");
  const found = db.searchAgentConversations("growth");
  assert.deepEqual(found.map((c: AgentConversationRow) => c.id), [hit.id]);
  assert.equal("preview" in found[0], false);
  // Empty query degenerates to LIKE %% — every conversation matches.
  assert.equal(db.searchAgentConversations("").length, 2);
  assert.equal(db.searchAgentConversations(undefined).length, 2);
  assert.deepEqual(db.searchAgentConversations("nomatch"), []);
  db.close();
});

test("title updates report success and archive/unarchive flip the flag", (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const conv = db.createAgentConversation("before");
  assert.deepEqual(db.updateAgentConversationTitle(conv.id, "after"), { success: true });
  assert.equal(db.getAgentConversation(conv.id).title, "after");
  assert.deepEqual(db.updateAgentConversationTitle(987654, "x"), { success: false });
  assert.deepEqual(db.archiveAgentConversation(conv.id), { success: true });
  assert.notEqual(db.getAgentConversation(conv.id).archived_at, null);
  assert.deepEqual(db.getAgentConversations().map((c: AgentConversationRow) => c.id), []);
  assert.deepEqual(db.unarchiveAgentConversation(conv.id), { success: true });
  assert.equal(db.getAgentConversation(conv.id).archived_at, null);
  assert.deepEqual(db.archiveAgentConversation(987654), { success: false });
  assert.deepEqual(db.unarchiveAgentConversation(987654), { success: false });
  db.close();
});

test("delete removes the conversation and cascades its messages", (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const conv = db.createAgentConversation("doomed");
  db.addAgentMessage(conv.id, "user", "one");
  assert.deepEqual(db.deleteAgentConversation(conv.id), { success: true });
  assert.equal(db.getAgentConversation(conv.id), null);
  assert.deepEqual(db.getAgentMessages(conv.id), []);
  assert.deepEqual(db.deleteAgentConversation(conv.id), { success: false });
  db.close();
});

test("deleting the note cascades the chat; deleting the folder clears folder_id", (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const spaceId = db.getPrivateSpaceId();
  const folder = db.createFolder("F", spaceId).folder;
  const note = db.saveNote("Note", "body", "personal", null, null, folder.id, spaceId).note;
  const noteChat = db.createAgentConversation("note chat", note.id);
  const folderChat = db.createAgentConversation("folder chat", null, spaceId, folder.id);

  db.deleteFolder(folder.id);
  assert.equal(db.getAgentConversation(folderChat.id).folder_id, null);
  assert.equal(db.getAgentConversation(folderChat.id).space_id, spaceId);

  db.deleteNote(note.id);
  assert.equal(db.getAgentConversation(noteChat.id), null);
  db.close();
});

test("reopening the database restores conversations, messages and metadata", (t: import("node:test").TestContext) => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-chat-persist-"));
  let db;
  try {
    db = new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return;
    }
    throw error;
  }
  const spaceId = db.getPrivateSpaceId();
  const conv = db.createAgentConversation("durable", null, spaceId, null);
  db.addAgentMessage(conv.id, "user", "question", { toolCalls: [{ id: "t1", name: "search_notes" }] });
  db.addAgentMessage(conv.id, "assistant", "answer with \"quotes\" and\nnewlines");
  db.close();

  db = new DatabaseManager();
  const restored = db.getAgentConversation(conv.id);
  assert.equal(restored.title, "durable");
  assert.equal(restored.messages.length, 2);
  assert.deepEqual(JSON.parse(restored.messages[0].metadata), {
    toolCalls: [{ id: "t1", name: "search_notes" }],
  });
  assert.equal(restored.messages[1].content, 'answer with "quotes" and\nnewlines');
  db.close();
});
