// The real bundled preload talks to real registered AI Actions catalog
// handlers over a temporary SQLite database, closing the loop like Electron
// does. Covers: full custom-action lifecycle across a restart, builtin
// delete protection, event delivery exactly once, independent listeners
// with exact unsubscribe and malformed response/event rejection.
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
let listenersByChannel = null;
let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-actions-bridge-"));

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false },
      ipcMain: {
        handle: (channel, listener) => {
          if (!activeHandlers) activeHandlers = new Map();
          if (activeHandlers.has(channel)) {
            throw new Error(`Attempted to register a second handler for '${channel}'`);
          }
          activeHandlers.set(channel, listener);
        },
        on() {},
        removeHandler() {},
        emit() {},
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
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.ts");
const initialUserDataDir = userDataDir;

test.after(() => {
  Module._load = originalLoad;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  fs.rmSync(initialUserDataDir, { recursive: true, force: true });
});

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function loadBundledPreload(invoke) {
  listenersByChannel = new Map();
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
            const list = listenersByChannel.get(channel) || [];
            list.push(listener);
            listenersByChannel.set(channel, list);
          },
          removeListener(channel, listener) {
            const list = listenersByChannel.get(channel) || [];
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
  return api;
}

async function createFixture(t) {
  activeHandlers = new Map();
  dispatchSend = null;
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-actions-bridge-"));
  const fixtureDir = userDataDir;
  let db;
  t.after(() => {
    db?.close();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });
  try {
    db = new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
  const { registerActionsHandlers } = await import("../../src/helpers/actionsIpcHandlers.ts");
  registerActionsHandlers(
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
  // Close the event loop: main-side sends dispatch into the listeners the
  // preload registered, exactly like Electron would.
  dispatchSend = (channel, data) => {
    for (const listener of listenersByChannel.get(channel) || []) {
      listener(null, data);
    }
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { db, api, flush, invoke };
}

// Objects from vm.runInNewContext have a different prototype; compare by JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

test("custom action lifecycle round-trips through the bundled preload", async (t) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { api, flush } = ctx;

  const events = [];
  const unsub = api.onActionCreated((action) => events.push({ type: "created", action }));

  const created = await api.createAction("Bridge action", "d", "p");
  assert.equal(created.success, true);
  assert.equal(created.action.icon, "sparkles");
  await flush();
  assert.equal(events.length, 1, "event arrives exactly once");
  assert.equal(events[0].action.id, created.action.id);
  unsub();

  const loaded = await api.getAction(created.action.id);
  assert.equal(loaded.name, "Bridge action");

  const updated = await api.updateAction(created.action.id, {
    name: "Renamed",
    prompt: "p2",
    sort_order: 5,
  });
  assert.equal(updated.action.name, "Renamed");
  assert.equal(updated.action.is_builtin, 0);

  const deleteEvents = [];
  const unsubDelete = api.onActionDeleted((payload) => deleteEvents.push(payload));
  assert.deepEqual(plain(await api.deleteAction(created.action.id)), { success: true });
  await flush();
  assert.deepEqual(plain(deleteEvents), [{ id: created.action.id }]);
  unsubDelete();
  assert.equal(await api.getAction(created.action.id), null);
});

test("builtin actions are listed and cannot be deleted; edits survive restart", async (t) => {
  let ctx = await createFixture(t);
  if (!ctx) return;
  const { db, api } = ctx;

  const actions = await api.getActions();
  assert.ok(actions.length >= 3);
  assert.ok(actions.every((a) => a.is_builtin === 1 || a.is_builtin === 0));
  const builtin = actions.find((a) => a.is_builtin === 1);
  assert.deepEqual(plain(await api.deleteAction(builtin.id)), { success: false });
  assert.ok(await api.getAction(builtin.id));

  const edited = await api.updateAction(builtin.id, { prompt: "user override" });
  assert.equal(edited.success, true);

  // Reopen the DB: the user's prompt edit must survive the seeding pass.
  db.close();
  const reopened = new DatabaseManager();
  t.after(() => reopened.close());
  const row = reopened
    .getActions()
    .find((a) => a.translation_key === builtin.translation_key);
  assert.equal(row.prompt, "user override");
});

test("malformed responses and events reject or drop at the preload boundary", async (t) => {
  const ctx = await createFixture(t);
  if (!ctx) return;

  const handlersSnapshot = new Map(activeHandlers);
  const { db } = ctx;
  const actionsSnapshot = db.getActions();
  const apiA = loadBundledPreload(async (channel) => {
    if (channel === "db-get-action") return { junk: true };
    const handler = handlersSnapshot.get(channel);
    return handler(null);
  });
  await assert.rejects(apiA.getAction(1));

  // The malformed-events listener lives in a fresh preload whose dispatch
  // loop is wired to the fixture; junk events must be dropped, and a real
  // update event must still reach a surviving listener afterwards.
  // A dedicated preload whose listeners are driven by a private dispatch
  // loop: junk must be dropped, valid rows must reach the listener.
  const received = [];
  dispatchSend = null;
  const apiB = loadBundledPreload(async (channel, ...args) => {
    const handler = handlersSnapshot.get(channel);
    return handler(null, ...args);
  });
  // listenersByChannel now holds only apiB's listeners (the last load).
  const privateListeners = listenersByChannel;
  const loop = (channel, data) => {
    for (const listener of privateListeners.get(channel) || []) {
      listener(null, data);
    }
  };
  dispatchSend = loop;
  const unsub = apiB.onActionUpdated((action) => received.push(action));
  dispatchSend("action-updated", { nonsense: true });
  dispatchSend("action-updated", null);
  assert.deepEqual(plain(received), []);

  // Valid payload reaches the surviving listener exactly once.
  const validRow = { ...actionsSnapshot[0] };
  dispatchSend("action-updated", validRow);
  assert.equal(received.length, 1);
  assert.equal(received[0].id, validRow.id);
  unsub();
  dispatchSend("action-updated", validRow);
  assert.equal(received.length, 1, "unsubscribed listener is not called again");
});
