// Characterization for the folder IPC channels
// before they move into the typed module. The handlers run against the real
// registration logic with a database double, so the behavior pinned here is
// the behavior the JS boundary had — not the DB layer's.
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const test: typeof import("node:test") = require("node:test");

const Module = require("node:module");

type ContainerModule = typeof import("../../src/helpers/containerIpcHandlers.js");

let registerContainerHandlers: ContainerModule["registerContainerHandlers"];

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

let sent: Array<{ channel: string; data: unknown }> | null = null;

const originalLoad = Module._load;

Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return {
      app: { getPath: () => "/tmp", getAppPath: () => process.cwd(), isReady: () => false },
      BrowserWindow: {
        getAllWindows: () => [
          {
            isDestroyed: () => false,
            webContents: {
              send: (ch: string, data: unknown) => {
                if (sent) sent.push({ channel: ch, data });
              },
            },
          },
        ],
      },
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

test.before(async () => {
  ({ registerContainerHandlers } = await import("../../src/helpers/containerIpcHandlers.ts"));
});

type DatabaseDouble = Parameters<ContainerModule["registerContainerHandlers"]>[1]["database"];

function setup(database: DatabaseDouble, overrides: Record<string, unknown> = {}) {
  handlers.clear();
  sent = [];
  registerContainerHandlers(
    {
      handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
        handlers.set(channel, fn),
    },
    {
      database,
      noteFilesEnabled: () => false,
      getFolderName: () => {
        throw new Error("fake: getFolderName not set");
      },
      mirrorWriteNote: () => {},
      mirrorEnsureFolder: () => {},
      mirrorRenameFolder: () => {},
      mirrorDeleteFolderIfUnshared: () => {},
      ...overrides,
    }
  );

  return handlers;
}

// Test doubles must provide the same contract the real DatabaseManager has;
// individual tests override the methods they drive.
function fakeDb() {
  return {
    getFolders: () => {
      throw new Error("fake db: getFolders not set");
    },
    createFolder: () => {
      throw new Error("fake db: createFolder not set");
    },
    deleteFolder: () => {
      throw new Error("fake db: deleteFolder not set");
    },
    renameFolder: () => {
      throw new Error("fake db: renameFolder not set");
    },
    updateFolderStyle: () => {
      throw new Error("fake db: updateFolderStyle not set");
    },
    reorderFolders: () => {
      throw new Error("fake db: reorderFolders not set");
    },
    getFolderNoteCounts: () => {
      throw new Error("fake db: getFolderNoteCounts not set");
    },
  };
}

function call(
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>,
  channel: string,
  ...args: unknown[]
): any {
  const handler = handlers.get(channel);
  assert.ok(handler, `handler registered for ${channel}`);

  return handler!(null, ...args);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const FOLDER = {
  id: 7,
  name: "Meetings",
  is_default: 1,
  sort_order: 2,
  created_at: "2026-09-14 10:00:00",
  updated_at: "2026-09-14 10:00:00",
};

test("getFolders returns all folders", async () => {
  const seen: unknown[] = [];

  const db = {
    ...fakeDb(),
    getFolders: () => (seen.push(true), [FOLDER]),
  } as DatabaseDouble;

  const h = setup(db);
  assert.deepEqual(await call(h, "db-get-folders"), [FOLDER]);
  assert.deepEqual(await call(h, "db-get-folders"), [FOLDER]);
  assert.deepEqual(await call(h, "db-get-folders"), [FOLDER]);
  assert.deepEqual(seen, [true, true, true]);
});

test("createFolder defers folder-created and the mirror only when enabled", async () => {
  const db = {
    ...fakeDb(),
    createFolder: (_name: unknown) => ({ success: true, folder: FOLDER }),
  } as DatabaseDouble;

  const calls: unknown[] = [];

  const h = setup(db, {
    noteFilesEnabled: () => true,
    mirrorEnsureFolder: (name: string) => {
      calls.push(`ensure:${name}`);
    },
  });

  const result = await call(h, "db-create-folder", " Work ");
  assert.equal(result.success, true);
  assert.deepEqual(sent!, [] as unknown);
  await flush();
  assert.deepEqual(sent!, [{ channel: "folder-created", data: FOLDER }]);
  assert.deepEqual(calls, ["ensure:Meetings"]);

  // Mirroring off: event still fires, mirror call does not.
  calls.length = 0;
  sent!.length = 0;
  const h2 = setup(db);
  await call(h2, "db-create-folder", "Work");
  await flush();
  assert.deepEqual(calls, []);

  // Failure: neither event nor mirror.
  const h3 = setup({
    ...db,
    createFolder: () => ({ success: false, error: "Folder name is required" }),
  });

  const failed = await call(h3, "db-create-folder", "  ");
  assert.deepEqual(failed, { success: false, error: "Folder name is required" });
  await flush();
  assert.deepEqual(sent!, [] as unknown);
});

test("deleteFolder resolves the name before the delete and defers event + mirror", async () => {
  const order: unknown[] = [];

  const db = {
    ...fakeDb(),
    deleteFolder: (id: unknown) => {
      order.push(`delete:${id}`);

      return { success: true };
    },
  };

  const h = setup(db, {
    noteFilesEnabled: () => true,
    getFolderName: (id: unknown) => {
      order.push(`name:${id}`);

      return "Meetings";
    },
    mirrorDeleteFolderIfUnshared: (name: string) => order.push(`mirror:${name}`),
  });

  const result = await call(h, "db-delete-folder", 7);
  assert.deepEqual(result, { success: true });
  // Name resolution happens synchronously before the DB delete runs.
  assert.deepEqual(order, ["name:7", "delete:7"]);
  assert.deepEqual(sent!, [] as unknown);
  await flush();
  assert.deepEqual(sent!, [{ channel: "folder-deleted", data: { id: 7 } }]);
  assert.deepEqual(order.slice(2), ["mirror:Meetings"]);

  // Not found: no event, no mirror. Name is still resolved first.
  order.length = 0;
  sent!.length = 0;

  const h2 = setup(
    { ...db, deleteFolder: () => ({ success: false }) },
    {
      noteFilesEnabled: () => true,
      getFolderName: (id: unknown) => {
        order.push(`name:${id}`);

        return "Meetings";
      },
    }
  );

  await call(h2, "db-delete-folder", 99);
  await flush();
  assert.deepEqual(sent!, [] as unknown);
  assert.deepEqual(order, ["name:99"]);
});

test("renameFolder defers folder-renamed and the rename mirror when enabled", async () => {
  const db = {
    ...fakeDb(),
    renameFolder: (id: unknown, name: string) => ({ success: true, folder: { ...FOLDER, name } }),
  };

  const calls: unknown[] = [];

  const h = setup(db, {
    noteFilesEnabled: () => true,
    getFolderName: () => "Old",
    mirrorRenameFolder: (oldName: string, newName: string) => {
      calls.push([oldName, newName]);
    },
  });

  const result = await call(h, "db-rename-folder", 7, "New");
  assert.equal(result.success, true);
  await flush();
  assert.deepEqual(sent!, [{ channel: "folder-renamed", data: { ...FOLDER, name: "New" } }]);
  assert.deepEqual(calls, [["Old", "New"]]);
});

test("getFolderNoteCounts passes the DB rows straight through", async () => {
  const h = setup({
    ...fakeDb(),
    getFolderNoteCounts: () => [{ folder_id: null, count: 4 }],
  });

  assert.deepEqual(await call(h, "db-get-folder-note-counts"), [
    { folder_id: null, count: 4 },
  ]);
});

test("wrong-shaped ids reject before the DB is touched", async () => {
  const touched: unknown[] = [];

  const unexpected = (name: string) => () => {
    touched.push(name);
  };

  const db = {
    ...fakeDb(),
    deleteFolder: unexpected("deleteFolder"),
    renameFolder: unexpected("renameFolder"),
    updateFolderStyle: unexpected("updateFolderStyle"),
    reorderFolders: unexpected("reorderFolders"),
    getFolders: unexpected("getFolders"),
  };

  const h = setup(db);
  await assert.rejects(() => call(h, "db-delete-folder", "nope"), /Invalid arguments/);
  await assert.rejects(() => call(h, "db-rename-folder", 7, null, "extra"), /Invalid arguments/);
  assert.deepEqual(touched, []);
});
