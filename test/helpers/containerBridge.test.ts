const test: typeof import("node:test") = require("node:test");

const { loadBundledPreload: loadPreload, createListenerRegistry, plain }: typeof import("./harness/bundledPreload.ts") = require("./harness/bundledPreload.ts");

const { skipOrFail }: typeof import("./harness/nativeBinding.ts") = require("./harness/nativeBinding.ts");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const os: typeof import("node:os") = require("node:os");

const path: typeof import("node:path") = require("node:path");

const Module = require("node:module");

// The real bundled preload talks to a Map of real registered container
// handlers over a temporary SQLite database. Main-side event sends are
// dispatched back into the preload-registered listeners, closing the loop
// like Electron does, without exposing any event object to renderer
// callbacks.
type BridgeHandler = (event: unknown, ...args: unknown[]) => unknown;

let activeHandlers: Map<string, BridgeHandler> | null = null;

let dispatchSend: ((channel: string, data: unknown) => void) | null = null;

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-containers-bridge-"));

const originalLoad = Module._load;

Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return {
      app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false },
      ipcMain: {
        handle: (channel: string, listener: BridgeHandler) => {
          if (!activeHandlers) activeHandlers = new Map<string, BridgeHandler>();
          activeHandlers.set(channel, listener);
        },
      },
      BrowserWindow: {
        getAllWindows: () => [
          {
            isDestroyed: () => false,
            webContents: {
              send: (channel: string, data: unknown) => {
                dispatchSend?.(channel, data);
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

const DatabaseManager: typeof import("../../src/helpers/database.ts").DatabaseManager = require("../../src/helpers/database.ts");

test.after(() => {
  Module._load = originalLoad;
});

type ContainerApi = { [k: string]: (...args: unknown[]) => Promise<any> } & {
  onFolderDeleted(cb: (p: unknown) => void): () => void;
  onFolderRenamed(cb: (p: unknown) => void): () => void;
};

function loadBundledPreload(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>) {
  const registry = createListenerRegistry();

  return { api: loadPreload<ContainerApi>({ invoke, ...registry }), listeners: registry.listeners };
}

async function createFixture(t: import("node:test").TestContext) {
  activeHandlers = new Map();
  dispatchSend = null;
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-containers-bridge-"));

  let db: import("../../src/helpers/containerIpcHandlers.js").ContainerHandlerDeps["database"] & {
    close: () => void;
    getFolders(): Array<{ id: unknown; name: string }>;
  };

  try {
    db =
      new DatabaseManager() as unknown as import("../../src/helpers/containerIpcHandlers.js").ContainerHandlerDeps["database"] & {
        close: () => void;
        getFolders(): Array<{ id: unknown; name: string }>;
      };
  } catch (error) {
    skipOrFail(t, error);

    return null;
  }

  t.after(() => db.close());

  const { registerContainerHandlers } = await import("../../src/helpers/containerIpcHandlers.ts");
  registerContainerHandlers(
    {
      handle: (channel: string, listener: BridgeHandler) => activeHandlers!.set(channel, listener),
    },
    {
      database: db,
      noteFilesEnabled: () => false,
      getFolderName: (id: unknown) => (db.getFolders() as Array<{ id: unknown; name: string }>).find((f) => f.id === id)?.name ?? null,
      mirrorWriteNote: () => {},
      mirrorEnsureFolder: () => {},
      mirrorRenameFolder: () => {},
      mirrorDeleteFolderIfUnshared: () => {},
    }
  );

  const handlersSnapshot = new Map(activeHandlers!);

  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlersSnapshot.get(channel);

    if (!handler) throw new Error(`No handler registered for ${channel}`);

    return handler(null, ...args);
  };

  const { api, listeners } = loadBundledPreload(invoke);
  // Close the event loop: main-side sends dispatch into the listeners the
  // preload registered, exactly like Electron would.
  dispatchSend = (channel: string, data: unknown) => {
    for (const listener of listeners.get(channel) || []) {
      listener(null, data);
    }
  };

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  return { db, api, flush };
}

test("the full bundled preload chain round-trips folders", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);

  if (!ctx) return;
  const { db, api, flush } = ctx;

  const created = await api.createFolder("Bridge Folder");
  assert.equal(created.success, true);
  assert.equal(created.folder.name, "Bridge Folder");

  const listed = await api.getFolders();
  assert.ok(listed.some((f: any) => f.id === created.folder.id));

  const renamed = await api.renameFolder(created.folder.id, "Renamed");
  assert.equal(renamed.success, true);
  assert.equal(renamed.folder.name, "Renamed");

  // Renaming to an existing folder name hits the UNIQUE
  // constraint on folders.name.
  const duplicate = await api.renameFolder(created.folder.id, "Personal");
  assert.equal(duplicate.success, false);
  assert.match(duplicate.error, /already exists/);

  // Database normalization agrees across main and preload.

  const counts = await api.getFolderNoteCounts();
  assert.ok(Array.isArray(counts));

  const deleted = await api.deleteFolder(created.folder.id);
  assert.equal(plain(deleted).success, true);
  // Drain the deferred folder-deleted send before this fixture's dispatch
  // loop is replaced by the next test, or it leaks into that test's listeners.
  await flush();
  assert.equal(
    (await api.getFolders()).some((f: any) => f.id === created.folder.id),
    false
  );

  // Unknown ids fail quietly with the documented shapes.
  assert.equal((await api.deleteFolder(987654)).success, false);
  assert.equal((await api.renameFolder(987654, "x")).success, false);
  // renameFolder misses omit `folder` entirely.
  assert.equal((await api.renameFolder(987654, "x")).folder, undefined);
});

test("onFolderDeleted delivers payloads and unsubscribes cleanly", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);

  if (!ctx) return;
  const { api, flush } = ctx;

  const events: unknown[] = [];
  const eventsToo: unknown[] = [];
  const unsubA = api.onFolderDeleted((payload: unknown) => events.push(payload));
  const unsubB = api.onFolderDeleted((payload: unknown) => eventsToo.push(payload));

  const folder = (await api.createFolder("Event Folder")).folder;
  await api.deleteFolder(folder.id);
  await flush();

  assert.deepEqual(plain(events), [{ id: folder.id }]);
  assert.deepEqual(plain(eventsToo), [{ id: folder.id }]);

  unsubA();
  const folder2 = (await api.createFolder("Event Folder 2")).folder;
  await api.deleteFolder(folder2.id);
  await flush();

  assert.equal(events.length, 1, "unsubscribed listener is not called again");
  assert.deepEqual(plain(eventsToo), [{ id: folder.id }, { id: folder2.id }]);
  unsubB();
});

test("wrong arguments reject through the bridge before the DB runs", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);

  if (!ctx) return;
  const { api } = ctx;

  await assert.rejects(() => api.deleteFolder("nope"));
  await assert.rejects(() => api.renameFolder("x", "y"));
});

test("malformed events are dropped at the preload boundary", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);

  if (!ctx) return;
  const { api, flush } = ctx;

  const events: unknown[] = [];
  api.onFolderDeleted((payload: unknown) => events.push(payload));
  // Junk injected straight onto the wire, like a misbehaving main would.
  dispatchSend?.("folder-deleted", { nonsense: true });
  dispatchSend?.("folder-deleted", null);
  dispatchSend?.("folder-deleted", { id: "NaN" });
  await flush();
  assert.deepEqual(events, []);

  // The next valid event is still delivered.
  const folder = (await api.createFolder("After Junk")).folder;
  dispatchSend?.("folder-deleted", { id: folder.id });
  await flush();
  assert.deepEqual(plain(events), [{ id: folder.id }]);
});
