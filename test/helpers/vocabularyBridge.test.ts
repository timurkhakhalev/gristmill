// E2E for the vocabulary bridge: the real bundled preload talks to the real
// registered vocabulary handlers over a temporary SQLite database. Main-side
// event sends are dispatched back into the preload-registered listeners,
// closing the loop like Electron does. Malformed events are injected directly
// at the preload boundary to prove they are dropped there.
const test: typeof import("node:test") = require("node:test");

const { loadBundledPreload: loadPreload, createListenerRegistry }: typeof import("./harness/bundledPreload.ts") = require("./harness/bundledPreload.ts");

const { skipOrFail }: typeof import("./harness/nativeBinding.ts") = require("./harness/nativeBinding.ts");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const os: typeof import("node:os") = require("node:os");

const path: typeof import("node:path") = require("node:path");

const Module = require("node:module");

import type { VocabularyApi } from "../../src/contracts/vocabulary.ts";

let activeHandlers: Map<string, (...args: unknown[]) => unknown> | null = null;

let dispatchSend: ((channel: string, data: unknown) => void) | null = null;

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-vocab-bridge-"));

const originalLoad = Module._load;

Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return {
      app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false },
      ipcMain: {
        handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
          if (!activeHandlers) activeHandlers = new Map();
          activeHandlers.set(channel, listener);
        },
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

process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.ts");

test.after(() => {
  Module._load = originalLoad;
});

function loadBundledPreload(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>) {
  const registry = createListenerRegistry();

  return { api: loadPreload<VocabularyApi>({ invoke, ...registry }), listeners: registry.listeners };
}

async function createFixture(t: import("node:test").TestContext) {
  activeHandlers = new Map();
  dispatchSend = null;
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-vocab-bridge-"));
  let db;

  try {
    db = new DatabaseManager();
  } catch (error) {
    skipOrFail(t, error);

    return null;
  }

  t.after(() => db.close());

  const { registerVocabularyHandlers } = await import("../../src/helpers/vocabularyIpcHandlers.ts");
  registerVocabularyHandlers(
    { handle: (channel, listener) => activeHandlers!.set(channel, listener) },
    { database: db, debugLogger: { debug() {} } }
  );

  const handlersSnapshot = new Map(activeHandlers);

  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlersSnapshot.get(channel);

    if (!handler) throw new Error(`No handler registered for ${channel}`);

    return handler(null, ...args);
  };

  const { api, listeners } = loadBundledPreload(invoke);
  dispatchSend = (channel: string, data: unknown) => {
    for (const listener of listeners.get(channel) || []) {
      listener(null, data);
    }
  };

  return { db, api, listeners };
}

test("the bundled vocabulary chain round-trips words and snippets", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);

  if (!ctx) return;
  const { db, api } = ctx;

  // vm-crossing objects have a different prototype, so compare by value.
  const byValue = (x: unknown) => JSON.parse(JSON.stringify(x));

  assert.deepEqual(byValue(await api.getDictionary()), []);
  assert.deepEqual(
    byValue(await api.applyDictionaryChanges({ add: ["Alpha", "beta"], remove: [] })),
    {
      success: true,
      added: 2,
      removed: 0,
    }
  );
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

test("dictionary events reach the renderer through the bridge and unsubscribe cleanly", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);

  if (!ctx) return;
  const { api } = ctx;

  const received: unknown[] = [];
  const receivedRaw = [];

  const unsubscribe = api.onDictionaryUpdated((words: unknown) => {
    receivedRaw.push(words);
    received.push(JSON.parse(JSON.stringify(words)));
  });

  const unsubscribeSnippets = api.onSnippetsUpdated((snippets: unknown) => {
    receivedRaw.push(snippets);
    received.push(JSON.parse(JSON.stringify(snippets)));
  });

  const delta = await api.applyDictionaryChanges({ add: ["Word"], remove: [] });
  assert.equal(delta.success, true);
  assert.equal(delta.added, 1);
  assert.equal(delta.removed, 0);
  // Broadcast pull goes main-only: handlers re-read SQLite, events flow back.
  const handlers = activeHandlers;

  const broadcast = async (channel: string) => {
    const handler = handlers?.get(channel);

    if (!handler) throw new Error(`No handler registered for ${channel}`);
    await handler();
  };

  await broadcast("db-broadcast-dictionary-updated");
  await broadcast("db-broadcast-snippets-updated");

  const fromEvents = received.map((payload) => {
    assert.ok(payload && typeof payload === "object");

    return { ...payload };
  });

  assert.ok(fromEvents.length >= 2);
  unsubscribe();
  unsubscribeSnippets();

  await broadcast("db-broadcast-dictionary-updated");
  // No delivery after unsubscribe: only its own listener is removed, payload
  // count stays frozen.
  assert.equal(received.length, fromEvents.length);
});

test("malformed events are dropped at the preload boundary", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);

  if (!ctx) return;
  const { api } = ctx;

  const received: unknown[] = [];
  api.onDictionaryUpdated((words) => received.push([...words]));
  // Inject junk straight at the preload input, like a broken main would.
  assert.ok(dispatchSend);
  dispatchSend("dictionary-updated", { not: "an array" });
  dispatchSend("dictionary-updated", [7, null, { x: 1 }]);
  assert.deepEqual(received, []);

  // A valid event after the junk still gets through.
  dispatchSend("dictionary-updated", ["clean"]);
  assert.deepEqual(received, [["clean"]]);
});

test("wrong-shaped results from handlers surface as bridge errors, not silent corruption", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);

  if (!ctx) return;
  const { api, db } = ctx;
  // getDictionary on a database whose rows are junk must throw through the
  // bridge instead of handing renderer garbage.
  db.getDictionary = () => [7, null];
  await assert.rejects(() => api.getDictionary(), /Unexpected database response shape/);
});
