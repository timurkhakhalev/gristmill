// E2E for the vocabulary bridge: the real bundled preload talks to the real
// registered vocabulary handlers over a temporary SQLite database. Main-side
// event sends are dispatched back into the preload-registered listeners,
// closing the loop like Electron does. Malformed events are injected directly
// at the preload boundary to prove they are dropped there.
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
let dispatchSend = null;
let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-vocab-bridge-"));

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false },
      ipcMain: {
        handle: (channel, listener) => {
          if (!activeHandlers) activeHandlers = new Map();
          activeHandlers.set(channel, listener);
        },
      },
      BrowserWindow: {
        getAllWindows: () => [
          {
            isDestroyed: () => false,
            webContents: {
              send: (channel, data) => {
                if (dispatchSend) dispatchSend(channel, data);
              },
            },
          },
        ],
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.ts");

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
  const listeners = new Map();
  let api;
  vm.runInNewContext(fs.readFileSync(bundledPreload, "utf8"), {
    // The bundle keeps CJS interop for hybrid manifest modules, so the
    // sandbox needs the same bindings Node's CJS loader provides.
    module: { exports: {} },
    exports: {},
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
          on(channel, listener) {
            const list = listeners.get(channel) || [];
            list.push(listener);
            listeners.set(channel, list);
          },
          removeListener(channel, listener) {
            const list = listeners.get(channel) || [];
            const index = list.indexOf(listener);
            if (index !== -1) list.splice(index, 1);
          },
        },
        webUtils: { getPathForFile: () => "" },
      };
    },
    process: { platform: "darwin", versions: {} },
    console,
  });
  return { api, listeners };
}

async function createFixture(t) {
  activeHandlers = new Map();
  dispatchSend = null;
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-vocab-bridge-"));
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

  const { registerVocabularyHandlers } = await import("../../src/helpers/vocabularyIpcHandlers.ts");
  registerVocabularyHandlers(
    { handle: (channel, listener) => activeHandlers.set(channel, listener) },
    { database: db, debugLogger: { debug() {}, warn() {}, error() {} } }
  );

  const handlersSnapshot = new Map(activeHandlers);
  const invoke = async (channel, ...args) => {
    const handler = handlersSnapshot.get(channel);
    if (!handler) throw new Error(`No handler registered for ${channel}`);
    return handler(null, ...args);
  };
  const { api, listeners } = loadBundledPreload(invoke);
  dispatchSend = (channel, data) => {
    for (const listener of listeners.get(channel) || []) {
      listener(null, data);
    }
  };
  return { db, api, listeners };
}

test("the bundled vocabulary chain round-trips words and snippets", async (t) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { db, api } = ctx;

  // vm-crossing objects have a different prototype, so compare by value.
  const byValue = (x) => JSON.parse(JSON.stringify(x));

  assert.deepEqual(byValue(await api.getDictionary()), []);
  assert.deepEqual(byValue(await api.applyDictionaryChanges({ add: ["Alpha", "beta"], remove: [] })), {
    success: true,
    added: 2,
    removed: 0,
  });
  // SQLite owns casing/order/dedupe; the bridge adopts what it stored.
  const stored = await api.getDictionary();
  assert.deepEqual(byValue(stored), ["Alpha", "beta"]);
  assert.deepEqual(byValue(await api.setDictionary(["gamma"])), { success: true });
  assert.deepEqual(byValue(await api.getDictionary()), ["gamma"]);

  assert.deepEqual(byValue(await api.getSnippets()), []);
  assert.deepEqual(byValue(await api.setSnippets([{ trigger: ";em", replacement: "ama" }])), {
    success: true,
  });
  assert.deepEqual(byValue(await api.getSnippets()), [{ trigger: ";em", replacement: "ama" }]);

  // SQLite normalized the raw write below; the typed bridge still delivers it.
  db.setSnippets([{ trigger: "  ;trim  ", replacement: "ok" }, { trigger: "no-replacement" }]);
  assert.deepEqual(byValue(await api.getSnippets()), [{ trigger: ";trim", replacement: "ok" }]);
});

test("dictionary events reach the renderer through the bridge and unsubscribe cleanly", async (t) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { api } = ctx;

  const received = [];
  const receivedRaw = [];
  const unsubscribe = api.onDictionaryUpdated((words) => {
    receivedRaw.push(words);
    received.push(JSON.parse(JSON.stringify(words)));
  });
  const unsubscribeSnippets = api.onSnippetsUpdated((snippets) => {
    receivedRaw.push(snippets);
    received.push(JSON.parse(JSON.stringify(snippets)));
  });

  const delta = await api.applyDictionaryChanges({ add: ["Word"], remove: [] });
  assert.equal(delta.success, true);
  assert.equal(delta.added, 1);
  assert.equal(delta.removed, 0);
  // Broadcast pull goes main-only: handlers re-read SQLite, events flow back.
  const handlers = activeHandlers;
  await handlers.get("db-broadcast-dictionary-updated")();
  await handlers.get("db-broadcast-snippets-updated")();
  const fromEvents = received.map((payload) => ({ ...payload }));
  assert.ok(fromEvents.length >= 2);
  unsubscribe();
  unsubscribeSnippets();

  await handlers.get("db-broadcast-dictionary-updated")();
  // No delivery after unsubscribe: only its own listener is removed, payload
  // count stays frozen.
  assert.equal(received.length, fromEvents.length);
});

test("malformed events are dropped at the preload boundary", async (t) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { api } = ctx;

  const received = [];
  api.onDictionaryUpdated((words) => received.push([...words]));
  // Inject junk straight at the preload input, like a broken main would.
  dispatchSend("dictionary-updated", { not: "an array" });
  dispatchSend("dictionary-updated", [7, null, { x: 1 }]);
  assert.deepEqual(received, []);

  // A valid event after the junk still gets through.
  dispatchSend("dictionary-updated", ["clean"]);
  assert.deepEqual(received, [["clean"]]);
});

test("wrong-shaped results from handlers surface as bridge errors, not silent corruption", async (t) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { api, db } = ctx;
  // getDictionary on a database whose rows are junk must throw through the
  // bridge instead of handing renderer garbage.
  db.getDictionary = () => [7, null];
  await assert.rejects(() => api.getDictionary(), /Unexpected database response shape/);
});
