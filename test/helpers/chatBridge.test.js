// The real bundled preload talks to real registered chat persistence
// handlers over a temporary SQLite database, closing the loop like Electron
// does. Covers: full round-trips with DB normalization, metadata
// serialization across the wire, fake-invoke junk rejection at the preload
// boundary, and the registration-collision guard (a second handle on the
// same channel must fail loudly — the #23 duplicate-handler failure).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

const root = path.resolve(__dirname, "../..");
const bundledPreload = path.join(root, "dist-main", "preload.js");

let activeHandlers = null;
let registeringModule = null;
let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-chat-bridge-"));

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false },
      ipcMain: {
        handle: (channel, listener) => {
          if (!activeHandlers) activeHandlers = new Map();
          if (activeHandlers.has(channel)) {
            throw new Error(
              `Attempted to register a second handler for '${channel}'`
            );
          }
          activeHandlers.set(channel, listener);
        },
      },
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");

test.after(() => {
  Module._load = originalLoad;
});

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function loadBundledPreload(invoke) {
  let api;
  vm.runInNewContext(fs.readFileSync(bundledPreload, "utf8"), {
    require(name) {
      assert.equal(name, "electron", "the bundled preload must only require electron");
      return {
        contextBridge: {
          exposeInMainWorld: (_name, value) => {
            api = value;
          },
        },
        ipcRenderer: {
          invoke,
          send() {},
          on() {},
          removeListener() {},
        },
        webUtils: { getPathForFile: () => "" },
      };
    },
    process: { platform: "darwin", versions: {} },
    console,
  });
  return api;
}

async function createFixture(t) {
  activeHandlers = new Map();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-chat-bridge-"));
  let db;
  try {
    db = new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
  t.after(() => db.close());

  const { registerChatPersistenceHandlers } = await import(
    "../../src/helpers/chatPersistenceIpcHandlers.ts"
  );
  registerChatPersistenceHandlers(
    { handle: (channel, listener) => activeHandlers.set(channel, listener) },
    { database: db }
  );

  const handlersSnapshot = new Map(activeHandlers);
  const invoke = async (channel, ...args) => {
    const handler = handlersSnapshot.get(channel);
    if (!handler) throw new Error(`No handler registered for ${channel}`);
    return handler(null, ...args);
  };
  const api = loadBundledPreload(invoke);
  return { db, api, invoke };
}

// Objects from vm.runInNewContext have a different prototype; compare by JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

test("the full bundled preload chain round-trips conversations and messages", async (t) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { api, db } = ctx;

  const spaceId = db.getPrivateSpaceId();
  const created = await api.createAgentConversation("Round trip", null, spaceId, null);
  assert.equal(created.title, "Round trip");
  assert.deepEqual(plain(created.messages), []);

  const message = await api.addAgentMessage(created.id, "user", "hello", {
    toolCalls: [{ id: "t1", name: "search_notes", arguments: "{}" }],
  });
  assert.equal(message.conversation_id, created.id);
  assert.deepEqual(JSON.parse(message.metadata).toolCalls, [
    { id: "t1", name: "search_notes", arguments: "{}" },
  ]);
  await api.addAgentMessage(created.id, "assistant", "answer", null);

  const loaded = await api.getAgentConversation(created.id);
  assert.deepEqual(
    plain(loaded.messages.map((m) => [m.role, m.content])),
    [
      ["user", "hello"],
      ["assistant", "answer"],
    ]
  );
  assert.deepEqual(plain(await api.getAgentMessages(created.id)), plain(loaded.messages));

  // Note-scoped lists are plain rows without message_count.
  await api.updateAgentConversationTitle(created.id, "Renamed");
  const forNote = await api.getConversationsForNote(987654);
  assert.deepEqual(plain(forNote), []);
  const containerList = await api.getConversationsForContainer(spaceId, null);
  assert.equal(containerList[0].message_count, 2);
  assert.equal(containerList[0].title, "Renamed");

  const all = await api.getAgentConversations();
  assert.equal(all.some((c) => c.id === created.id), true);
  assert.equal("message_count" in all[0], false);

  const search = await api.searchAgentConversations("Renamed");
  assert.equal(search.length, 1);
  assert.equal("preview" in search[0], false);

  const preview = await api.getAgentConversationsWithPreview();
  assert.equal(preview.find((c) => c.id === created.id).preview, "answer");

  assert.deepEqual(plain(await api.archiveAgentConversation(created.id)), { success: true });
  assert.equal((await api.getAgentConversations()).length, 0);
  assert.deepEqual(plain(await api.unarchiveAgentConversation(created.id)), { success: true });
  assert.equal((await api.getAgentConversations()).length, 1);

  assert.deepEqual(plain(await api.deleteAgentConversation(created.id)), { success: true });
  assert.equal(await api.getAgentConversation(created.id), null);
  assert.deepEqual(plain(await api.deleteAgentConversation(created.id)), { success: false });
});

test("missing ids stay null through the bridge", async (t) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { api } = ctx;

  assert.equal(await api.getAgentConversation(987654), null);
  assert.equal(await api.addAgentMessage(987654, "user", "x"), null);
  assert.deepEqual(plain(await api.getAgentMessages(987654)), []);
  assert.deepEqual(plain(await api.getConversationsForNote(987654)), []);
  assert.deepEqual(plain(await api.getConversationsForContainer(987654, null)), []);
  assert.deepEqual(plain(await api.searchAgentConversations("nothing-matches")), []);
  assert.deepEqual(plain(await api.updateAgentConversationTitle(987654, "x")), { success: false });
  assert.deepEqual(plain(await api.archiveAgentConversation(987654)), { success: false });
  assert.deepEqual(plain(await api.unarchiveAgentConversation(987654)), { success: false });
});

test("a wrong-shaped main response rejects instead of becoming an empty chat", async (t) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { api, invoke } = ctx;

  const fake = (channel, value) => {
    const real = invoke;
    return async (requested, ...args) =>
      requested === channel ? structuredClone(value) : real(requested, ...args);
  };

  // A main-side crash returning an error object is not a valid detail.
  const brokenInvoke = fake("db-get-agent-conversation", { error: "boom" });
  const apiA = (() => {
    // Rebuild the bridge over the corrupted invoke path.
    const handlers = new Map(activeHandlers);
    return loadBundledPreload(async (channel, ...args) => {
      if (channel === "db-get-agent-conversation") return { error: "boom" };
      const handler = handlers.get(channel);
      return handler(null, ...args);
    });
  })();
  await assert.rejects(apiA.getAgentConversation(1));

  // A null for a list channel is not a valid list.
  const apiB = loadBundledPreload(async (channel, ...args) => {
    if (channel === "db-get-agent-conversations") return null;
    const handler = new Map(activeHandlers).get(channel);
    return handler(null, ...args);
  });
  await assert.rejects(apiB.getAgentConversations());

  // A message with an unknown role is rejected at the preload boundary.
  const apiC = loadBundledPreload(async (channel, ...args) => {
    if (channel === "db-add-agent-message") {
      return { id: 1, conversation_id: 1, role: "admin", content: "x", metadata: null, created_at: "t" };
    }
    const handler = new Map(activeHandlers).get(channel);
    return handler(null, ...args);
  });
  await assert.rejects(apiC.addAgentMessage(1, "user", "x"));

  assert.ok(api && invoke);
});

test("registering the same channel twice fails loudly", async (t) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { db } = ctx;

  const { registerChatPersistenceHandlers } = await import(
    "../../src/helpers/chatPersistenceIpcHandlers.ts"
  );
  // The fixture's ipcMain stub throws on a duplicate handle; this is the
  // guard that would have caught the #23 duplicate-registration breakage.
  assert.throws(
    () =>
      registerChatPersistenceHandlers(
        {
          handle: (channel) => {
            if (activeHandlers.has(channel)) {
              throw new Error(`Attempted to register a second handler for '${channel}'`);
            }
            activeHandlers.set(channel, () => {});
          },
        },
        { database: db }
      ),
    /second handler/
  );
});
