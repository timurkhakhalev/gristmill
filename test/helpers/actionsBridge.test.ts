// The real bundled preload talks to real registered AI Actions catalog
// handlers over a temporary SQLite database, closing the loop like Electron
// does. Covers: full custom-action lifecycle across a restart, builtin
// delete protection, event delivery exactly once, independent listeners
// with exact unsubscribe and malformed response/event rejection.
const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const vm: typeof import("node:vm") = require("node:vm");
const Module = require("node:module");

const root = path.resolve(__dirname, "../..");
const bundledPreload = path.join(root, "dist-main", "preload.js");

let activeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> | null = null;
let dispatchSend: ((channel: string, ...args: unknown[]) => void) | null = null;
let listenersByChannel: Map<string, Array<(event: unknown, ...args: unknown[]) => void>> = new Map();
let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-actions-bridge-"));

const originalLoad = Module._load;
Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return {
      app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false },
      ipcMain: {
        handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
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
              send: (channel: string, data: unknown) => {
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

const DatabaseManager: typeof import("../../src/helpers/database.ts").DatabaseManager = require("../../src/helpers/database.ts");
const initialUserDataDir = userDataDir;

test.after(() => {
  Module._load = originalLoad;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  fs.rmSync(initialUserDataDir, { recursive: true, force: true });
});

function isNativeBindingUnavailable(error: unknown) {
  const message = String((error as { message?: unknown })?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function loadBundledPreload(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>) {
  listenersByChannel = new Map();
  // The preload surface is exercised dynamically; one loose record type keeps
  // the test reading like the JS original while still checking the harness.
  type PreloadApi = { [k: string]: (...args: unknown[]) => Promise<any> } & { onActionCreated(cb: (a: unknown) => void): () => void; onActionUpdated(cb: (a: unknown) => void): () => void; onActionDeleted(cb: (p: unknown) => void): () => void; };
  let api: PreloadApi | undefined;
  vm.runInNewContext(fs.readFileSync(bundledPreload, "utf8"), {
    // The bundle keeps CJS interop for hybrid manifest modules, so the
    // sandbox needs the same bindings Node's CJS loader provides.
    module: { exports: {} },
    exports: {},
    require(name: string) {
      assert.equal(name, "electron", "the bundled preload must only require electron");
      return {
        contextBridge: {
          exposeInMainWorld: (_name: string, value: PreloadApi) => {
            api = value;
          },
        },
        ipcRenderer: {
          invoke,
          send() {},
          on(channel: string, listener: (event: unknown, ...args: unknown[]) => void) {
            const list = listenersByChannel.get(channel) || [];
            list.push(listener);
            listenersByChannel.set(channel, list);
          },
          removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void) {
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
  return api!;
}

async function createFixture(t: import("node:test").TestContext) {
  activeHandlers = new Map();
  dispatchSend = null;
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-actions-bridge-"));
  const fixtureDir = userDataDir;
  let db: import("../../src/helpers/actionsIpcHandlers.js").ActionsHandlerDeps["database"] & { close: () => void } | null = null;
  t.after(() => {
    db?.close();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });
  try {
    db = new DatabaseManager() as unknown as import("../../src/helpers/actionsIpcHandlers.js").ActionsHandlerDeps["database"] & { close: () => void };
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
  const { registerActionsHandlers } = await import("../../src/helpers/actionsIpcHandlers.ts");
  registerActionsHandlers(
    { handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => activeHandlers!.set(channel, listener) },
    { database: db }
  );

  const handlersSnapshot = new Map(activeHandlers!);
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlersSnapshot.get(channel);
    if (!handler) throw new Error(`No handler registered for ${channel}`);
    return handler(null, ...args);
  };
  const api = loadBundledPreload(invoke);
  // Close the event loop: main-side sends dispatch into the listeners the
  // preload registered, exactly like Electron would.
  dispatchSend = (channel: string, data: unknown) => {
    for (const listener of listenersByChannel.get(channel) || []) {
      listener(null, data);
    }
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { db, api, flush, invoke };
}

// Objects from vm.runInNewContext have a different prototype; compare by JSON.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("custom action lifecycle round-trips through the bundled preload", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { api, flush } = ctx;

  const events: unknown[] = [];
  const unsub = api.onActionCreated((action: unknown) => events.push({ type: "created", action }));

  const created = await api.createAction("Bridge action", "d", "p") as { success: boolean; action: { icon: string; id: unknown } };
  assert.equal(created.success, true);
  assert.equal(created.action.icon, "sparkles");
  await flush();
  assert.equal(events.length, 1, "event arrives exactly once");
  assert.equal((events[0] as { action: { id: unknown } }).action.id, created.action.id);
  unsub();

  const loaded = await api.getAction(created.action.id) as { name: string };
  assert.equal(loaded.name, "Bridge action");

  const updated = await api.updateAction(created.action.id, {
    name: "Renamed",
    prompt: "p2",
    sort_order: 5,
  }) as { action: { name: string; is_builtin: number } };
  assert.equal(updated.action.name, "Renamed");
  assert.equal(updated.action.is_builtin, 0);

  const deleteEvents: unknown[] = [];
  const unsubDelete = api.onActionDeleted((payload: unknown) => deleteEvents.push(payload));
  assert.deepEqual(plain(await api.deleteAction(created.action.id)), { success: true });
  await flush();
  assert.deepEqual(plain(deleteEvents), [{ id: created.action.id }]);
  unsubDelete();
  assert.equal(await api.getAction(created.action.id), null);
});

test("builtin actions are listed and cannot be deleted; edits survive restart", async (t: import("node:test").TestContext) => {
  let ctx = await createFixture(t);
  if (!ctx) return;
  const { db, api } = ctx;

  const actions = await api.getActions() as Array<{ is_builtin: number; id: unknown; translation_key: string }>;
  assert.ok(actions.length >= 3);
  assert.ok(actions.every((a) => a.is_builtin === 1 || a.is_builtin === 0));
  const builtin = actions.find((a) => a.is_builtin === 1)!;
  assert.deepEqual(plain(await api.deleteAction(builtin.id)), { success: false });
  assert.ok(await api.getAction(builtin.id));

  const edited = await api.updateAction(builtin.id, { prompt: "user override" });
  assert.equal(edited.success, true);

  // Reopen the DB: the user's prompt edit must survive the seeding pass.
  db.close();
  const reopened = new DatabaseManager();
  t.after(() => reopened.close());
  const row = (reopened as unknown as { getActions(): Array<{ translation_key: string; prompt: string }> })
    .getActions()
    .find((a) => a.translation_key === builtin.translation_key)!;
  assert.equal(row.prompt, "user override");
});

test("malformed responses and events reject or drop at the preload boundary", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);
  if (!ctx) return;

  const handlersSnapshot = new Map(activeHandlers);
  const { db } = ctx;
  const actionsSnapshot = db.getActions() as Array<{ id: unknown; is_builtin: number; translation_key: string; prompt: string }>;
  const apiA = loadBundledPreload(async (channel: string) => {
    if (channel === "db-get-action") return { junk: true };
    const handler = handlersSnapshot.get(channel);
    return handler?.(null);
  });
  await assert.rejects(apiA!.getAction(1));

  // The malformed-events listener lives in a fresh preload whose dispatch
  // loop is wired to the fixture; junk events must be dropped, and a real
  // update event must still reach a surviving listener afterwards.
  // A dedicated preload whose listeners are driven by a private dispatch
  // loop: junk must be dropped, valid rows must reach the listener.
  const received: unknown[] = [];
  dispatchSend = null;
  const apiB = loadBundledPreload(async (channel: string, ...args) => {
    const handler = handlersSnapshot.get(channel);
    return handler?.(null, ...args);
  });
  // listenersByChannel now holds only apiB's listeners (the last load).
  const privateListeners = listenersByChannel;
  const loop = (channel: string, data: unknown) => {
    for (const listener of privateListeners.get(channel) || []) {
      listener(null, data);
    }
  };
  dispatchSend = loop;
  const unsub = apiB!.onActionUpdated((action: unknown) => received.push(action));
  dispatchSend("action-updated", { nonsense: true });
  dispatchSend("action-updated", null);
  assert.deepEqual(plain(received), []);

  // Valid payload reaches the surviving listener exactly once.
  const validRow = { ...(actionsSnapshot as Array<{ id: unknown }>)[0] };
  dispatchSend("action-updated", validRow);
  assert.equal(received.length, 1);
  assert.equal((received[0] as { id: unknown }).id, validRow.id);
  unsub();
  dispatchSend("action-updated", validRow);
  assert.equal(received.length, 1, "unsubscribed listener is not called again");
});
