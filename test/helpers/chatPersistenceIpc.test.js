// The thirteen chat persistence channels after the typed cutover. Same
// behavioral expectations as chatPersistenceBehavior (which pins the DB
// layer), executed through registerChatPersistenceHandlers with a database
// double: defaults are applied at the handler boundary, wrong-shaped calls
// throw before the DB is touched, results are validated per operation.
const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");

let registerChatPersistenceHandlers;
const handlers = new Map();

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => "/tmp", getAppPath: () => process.cwd(), isReady: () => false },
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

test.before(async () => {
  ({ registerChatPersistenceHandlers } = await import(
    "../../src/helpers/chatPersistenceIpcHandlers.ts"
  ));
});

test.after(() => {
  Module._load = originalLoad;
});

function setup(database) {
  handlers.clear();
  registerChatPersistenceHandlers(
    { handle: (channel, fn) => handlers.set(channel, fn) },
    { database }
  );
  return handlers;
}

function call(handlers, channel, ...args) {
  const handler = handlers.get(channel);
  assert.ok(handler, `handler registered for ${channel}`);
  return handler(null, ...args);
}

function fakeDb() {
  const thrower = (name) => () => {
    throw new Error(`fake db: ${name} not set`);
  };
  return {
    createAgentConversation: thrower("createAgentConversation"),
    getConversationsForNote: thrower("getConversationsForNote"),
    getConversationsForContainer: thrower("getConversationsForContainer"),
    getAgentConversations: thrower("getAgentConversations"),
    getAgentConversation: thrower("getAgentConversation"),
    deleteAgentConversation: thrower("deleteAgentConversation"),
    updateAgentConversationTitle: thrower("updateAgentConversationTitle"),
    addAgentMessage: thrower("addAgentMessage"),
    getAgentMessages: thrower("getAgentMessages"),
    getAgentConversationsWithPreview: thrower("getAgentConversationsWithPreview"),
    searchAgentConversations: thrower("searchAgentConversations"),
    archiveAgentConversation: thrower("archiveAgentConversation"),
    unarchiveAgentConversation: thrower("unarchiveAgentConversation"),
  };
}

const CONV = {
  id: 5,
  title: "Chat",
  note_id: null,
  space_id: null,
  folder_id: null,
  archived_at: null,
  created_at: "2026-09-14 10:00:00",
  updated_at: "2026-09-14 10:00:00",
};

test("create normalizes omitted scope ids and applies the Untitled default", async () => {
  const seen = [];
  const db = {
    ...fakeDb(),
    createAgentConversation: (...args) => (seen.push(args), { ...CONV, messages: [] }),
  };
  const h = setup(db);
  const created = await call(h, "db-create-agent-conversation");
  assert.equal(created.id, 5);
  assert.deepEqual(seen, [["Untitled", null, null, null]]);
  seen.length = 0;
  await call(h, "db-create-agent-conversation", "Title", 3, 4, 5);
  assert.deepEqual(seen, [["Title", 3, 4, 5]]);
});

test("wrong-shaped create args reject before the database runs", async () => {
  let touched = false;
  const db = {
    ...fakeDb(),
    createAgentConversation: () => {
      touched = true;
      return { ...CONV, messages: [] };
    },
  };
  const h = setup(db);
  await assert.rejects(call(h, "db-create-agent-conversation", "t", "not-an-id"));
  await assert.rejects(call(h, "db-create-agent-conversation", "t", 1.5));
  assert.equal(touched, false);
});

test("list channels apply their documented defaults", async () => {
  const seen = [];
  const db = {
    ...fakeDb(),
    getConversationsForNote: (...args) => (seen.push(["note", ...args]), []),
    getConversationsForContainer: (...args) => (seen.push(["container", ...args]), []),
    getAgentConversations: (...args) => (seen.push(["all", ...args]), []),
    searchAgentConversations: (...args) => (seen.push(["search", ...args]), []),
    getAgentConversationsWithPreview: (...args) => (seen.push(["preview", ...args]), []),
  };
  const h = setup(db);
  await call(h, "db-get-conversations-for-note", 7);
  await call(h, "db-get-conversations-for-container", 3, null);
  await call(h, "db-get-agent-conversations");
  await call(h, "db-search-agent-conversations", "");
  await call(h, "db-get-agent-conversations-with-preview");
  assert.deepEqual(seen, [
    ["note", 7, 20],
    ["container", 3, null, 20],
    ["all", 50],
    ["search", "", 20],
    ["preview", 50, 0, false],
  ]);
});

test("detail and message channels preserve null results", async () => {
  const db = {
    ...fakeDb(),
    getAgentConversation: (id) => (id === 5 ? { ...CONV, messages: [] } : null),
    addAgentMessage: (id) => (id === 5 ? { id: 9, conversation_id: 5, role: "user", content: "x", metadata: null, created_at: "t" } : null),
    getAgentMessages: () => [],
  };
  const h = setup(db);
  assert.equal((await call(h, "db-get-agent-conversation", 5)).id, 5);
  assert.equal(await call(h, "db-get-agent-conversation", 987654), null);
  assert.equal((await call(h, "db-add-agent-message", 5, "user", "x")).id, 9);
  assert.equal(await call(h, "db-add-agent-message", 987654, "user", "x"), null);
  assert.deepEqual(await call(h, "db-get-agent-messages", 5), []);
});

test("addAgentMessage validates the role and passes metadata through untouched", async () => {
  const seen = [];
  const db = {
    ...fakeDb(),
    addAgentMessage: (...args) => (seen.push(args), null),
  };
  const h = setup(db);
  const toolCalls = [{ id: "t1", name: "search_notes" }];
  await call(h, "db-add-agent-message", 5, "assistant", "answer", { toolCalls });
  assert.deepEqual(seen, [[5, "assistant", "answer", { toolCalls }]]);
  await assert.rejects(call(h, "db-add-agent-message", 5, "admin", "x"));
  assert.equal(seen.length, 1);
});

test("boolean-shaped results are validated, junk is rejected", async () => {
  const db = {
    ...fakeDb(),
    deleteAgentConversation: () => ({ success: true }),
    archiveAgentConversation: () => ({ success: false }),
    unarchiveAgentConversation: () => ({ nope: true }),
  };
  const h = setup(db);
  assert.deepEqual(await call(h, "db-delete-agent-conversation", 5), { success: true });
  assert.deepEqual(await call(h, "db-archive-agent-conversation", 5), { success: false });
  await assert.rejects(call(h, "db-unarchive-agent-conversation", 5));
});

test("container list rows must carry message_count, plain lists must not", async () => {
  const withCount = { ...CONV, message_count: 2 };
  const db = {
    ...fakeDb(),
    getConversationsForContainer: () => [withCount],
    getAgentConversations: () => [CONV],
  };
  const h = setup(db);
  assert.deepEqual(await call(h, "db-get-conversations-for-container", 1, null), [withCount]);
  assert.deepEqual(await call(h, "db-get-agent-conversations"), [CONV]);
  const broken = { ...CONV, archived_at: undefined };
  const db2 = { ...db, getAgentConversations: () => [broken] };
  await assert.rejects(call(setup(db2), "db-get-agent-conversations"));
});

test("preview rows expose preview; strict ids reject junk before the DB", async () => {
  const row = { ...CONV, preview: "last" };
  const db = {
    ...fakeDb(),
    getAgentConversationsWithPreview: () => [row],
  };
  const h = setup(db);
  assert.deepEqual(await call(h, "db-get-agent-conversations-with-preview"), [row]);
  await assert.rejects(call(h, "db-get-agent-conversation", "five"));
  await assert.rejects(call(h, "db-archive-agent-conversation", 1.5));
  await assert.rejects(call(h, "db-get-agent-messages"));
});

test("updating a title passes the raw value through and validates the result", async () => {
  const seen = [];
  const db = {
    ...fakeDb(),
    updateAgentConversationTitle: (...args) => (seen.push(args), { success: true }),
  };
  const h = setup(db);
  assert.deepEqual(await call(h, "db-update-agent-conversation-title", 5, "New"), { success: true });
  assert.deepEqual(seen, [[5, "New"]]);
  await assert.rejects(call(h, "db-update-agent-conversation-title", "five", "New"));
});
