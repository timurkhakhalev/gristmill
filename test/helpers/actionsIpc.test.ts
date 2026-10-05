// The five AI Actions catalog channels after the typed cutover. Same
// behavioral expectations as actionsCatalogBehavior (which pins the DB
// layer), executed through registerActionsHandlers with a database double:
// wrong-shaped calls throw before the DB runs, failures send no event,
// successes defer exactly one validated event.
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const test: typeof import("node:test") = require("node:test");

const Module = require("node:module");

type ActionsModule = typeof import("../../src/helpers/actionsIpcHandlers.js");

type ActionsDb = Parameters<ActionsModule["registerActionsHandlers"]>[1]["database"];

let registerActionsHandlers: ActionsModule["registerActionsHandlers"];

const handlers = new Map();

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
  ({ registerActionsHandlers } = await import("../../src/helpers/actionsIpcHandlers.ts"));
});

test.after(() => {
  Module._load = originalLoad;
});

function setup(database: ActionsDb) {
  handlers.clear();
  sent = [];
  registerActionsHandlers(
    {
      handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
        handlers.set(channel, fn),
    },
    { database }
  );

  return handlers;
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

function fakeDb() {
  const thrower = (name: string) => () => {
    throw new Error(`fake db: ${name} not set`);
  };

  return {
    getActions: thrower("getActions"),
    getAction: thrower("getAction"),
    createAction: thrower("createAction"),
    updateAction: thrower("updateAction"),
    deleteAction: thrower("deleteAction"),
  };
}

const ACTION = {
  id: 9,
  name: "Summarize",
  description: "d",
  prompt: "p",
  icon: "sparkles",
  is_builtin: 0,
  sort_order: 0,
  translation_key: null,
  created_at: "2026-09-14 10:00:00",
  updated_at: "2026-09-14 10:00:00",
};

test("get channels pass through rows and null for missing ids", async () => {
  const db = {
    ...fakeDb(),
    getActions: () => [ACTION],
    getAction: (id: unknown) => (id === 9 ? ACTION : null),
  };

  const h = setup(db);
  assert.deepEqual(await call(h, "db-get-actions"), [ACTION]);
  assert.deepEqual(await call(h, "db-get-action", 9), ACTION);
  assert.equal(await call(h, "db-get-action", 987654), null);
  assert.deepEqual(sent!, []);
});

test("create defers action-created exactly once on success, never on failure", async () => {
  const db = {
    ...fakeDb(),
    createAction: () => ({ success: true, action: ACTION }),
  };

  const h = setup(db);
  const result = await call(h, "db-create-action", "Summarize", "d", "p");
  assert.equal(result.success, true);
  // The response returns before the deferred event.
  assert.deepEqual(sent!, []);
  await flush();
  assert.deepEqual(sent!, [{ channel: "action-created", data: ACTION }]);

  const failing = {
    ...fakeDb(),
    createAction: () => ({ success: false, error: "nope" }),
  };

  const h2 = setup(failing);
  const failed = await call(h2, "db-create-action", "", "", "");
  assert.equal(failed.success, false);
  await flush();
  assert.deepEqual(sent!, []);
});

test("update defers action-updated; unknown id yields success false without event", async () => {
  const db = {
    ...fakeDb(),
    updateAction: (id: unknown) =>
      id === 9
        ? { success: true, action: { ...ACTION, name: "Renamed" } }
        : { success: false, action: null },
  };

  const h = setup(db);
  const ok = await call(h, "db-update-action", 9, { name: "Renamed" });
  assert.equal(ok.action.name, "Renamed");
  await flush();
  assert.deepEqual(sent!, [{ channel: "action-updated", data: { ...ACTION, name: "Renamed" } }]);

  sent!.length = 0;
  const miss = await call(h, "db-update-action", 987654, { name: "x" });
  assert.deepEqual(miss, { success: false, action: null });
  await flush();
  assert.deepEqual(sent!, []);
});

test("delete defers action-deleted with the called id; builtin delete stays silent", async () => {
  const db = {
    ...fakeDb(),
    deleteAction: (id: unknown) => ({ success: id === 9 }),
  };

  const h = setup(db);
  assert.deepEqual(await call(h, "db-delete-action", 9), { success: true });
  await flush();
  assert.deepEqual(sent!, [{ channel: "action-deleted", data: { id: 9 } }]);

  sent!.length = 0;
  assert.deepEqual(await call(h, "db-delete-action", 987654), { success: false });
  await flush();
  assert.deepEqual(sent!, []);
});

test("wrong-shaped args reject before the database runs", async () => {
  let touched = false;

  const db = {
    ...fakeDb(),
    createAction: () => {
      touched = true;

      return { success: true, action: ACTION };
    },
    deleteAction: () => {
      touched = true;

      return { success: true };
    },
  };

  const h = setup(db);
  await assert.rejects(call(h, "db-delete-action", "nine"));
  await assert.rejects(call(h, "db-delete-action", 1.5));
  await assert.rejects(call(h, "db-get-action"));
  assert.equal(touched, false);
});

test("malformed DB rows are rejected at the handler boundary", async () => {
  const db = {
    ...fakeDb(),
    getActions: () => [{ ...ACTION, is_builtin: true }],
  };

  const h = setup(db);
  await assert.rejects(call(h, "db-get-actions"));
});
