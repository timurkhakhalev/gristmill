// Characterization for the ten vocabulary IPC channels before they move into
// the typed module. The handlers run against the real registration logic with
// a database double, so the normalization/throw behavior pinned here is the
// behavior the JS boundary had — not the DB layer's.
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const test: typeof import("node:test") = require("node:test");

const Module = require("node:module");

let registerVocabularyHandlers: any;

const handlers = new Map();

let sent: { channel: string; data: unknown }[] | null = null;

interface FakeDb {
  getDictionary: () => unknown;
  setDictionary: (words: unknown) => unknown;
  applyDictionaryChanges: (changes: unknown) => unknown;
  hardDeleteDictionaryEntry: (id: unknown) => unknown;
  getSnippets: () => unknown;
  setSnippets: (snippets: unknown) => unknown;
  hardDeleteSnippet: (id: unknown) => unknown;
}

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
  ({ registerVocabularyHandlers } = await import("../../src/helpers/vocabularyIpcHandlers.ts"));
});

function setup(database: unknown) {
  handlers.clear();
  sent = [];
  registerVocabularyHandlers(
    { handle: (channel: string, fn: unknown) => handlers.set(channel, fn) },
    {
      database,
      debugLogger: { debug() {}, warn() {}, error() {} },
    }
  );

  return handlers;
}

function fakeDb(): FakeDb {
  // Test doubles must provide the same contract the real DatabaseManager has;
  // individual tests override the methods they drive.
  return {
    getDictionary: () => {
      throw new Error("fake db: getDictionary not set");
    },
    setDictionary: () => {
      throw new Error("fake db: setDictionary not set");
    },
    applyDictionaryChanges: () => {
      throw new Error("fake db: applyDictionaryChanges not set");
    },
    hardDeleteDictionaryEntry: () => {
      throw new Error("fake db: hardDeleteDictionaryEntry not set");
    },
    getSnippets: () => {
      throw new Error("fake db: getSnippets not set");
    },
    setSnippets: () => {
      throw new Error("fake db: setSnippets not set");
    },
    hardDeleteSnippet: () => {
      throw new Error("fake db: hardDeleteSnippet not set");
    },
  };
}

test("get channels return whatever the database reads", async () => {
  const db = fakeDb();
  db.getDictionary = () => ["Alpha", "beta"];
  db.getSnippets = () => [{ trigger: ";em", replacement: "ama" }];
  const handlers = setup(db);
  assert.deepEqual(await handlers.get("db-get-dictionary")(), ["Alpha", "beta"]);
  assert.deepEqual(await handlers.get("db-get-snippets")(), [
    { trigger: ";em", replacement: "ama" },
  ]);
  assert.deepEqual(sent, []);
});

test("setDictionary rejects non-arrays with the historical throw", async () => {
  const handlers = setup(fakeDb());

  for (const bad of [null, "words", { 0: "a" }, 7]) {
    await assert.rejects(
      handlers.get("db-set-dictionary")({ sender: {} }, bad),
      /words must be an array/
    );
  }
});

test("setSnippets rejects non-arrays with the historical throw", async () => {
  const handlers = setup(fakeDb());

  for (const bad of [null, 7, "x"]) {
    await assert.rejects(
      handlers.get("db-set-snippets")({ sender: {} }, bad),
      /snippets must be an array/
    );
  }
});

test("applyDictionaryChanges tolerates omitted/null changes as an empty delta", async () => {
  const calls: unknown[] = [];
  const db = fakeDb();
  db.applyDictionaryChanges = (changes: unknown) => {
    calls.push(changes);

    return { success: true, added: 0, removed: 0 };
  };

  const handlers = setup(db);

  for (const input of [undefined, null]) {
    await handlers.get("db-apply-dictionary-changes")({ sender: {} }, input);
  }

  assert.deepEqual(calls, [
    { add: undefined, remove: undefined },
    { add: undefined, remove: undefined },
  ]);
});

test("applyDictionaryChanges rejects non-array add/remove with the historical throws", async () => {
  const handlers = setup(fakeDb());
  await assert.rejects(
    handlers.get("db-apply-dictionary-changes")({ sender: {} }, { add: "x" }),
    /add must be an array/
  );
  await assert.rejects(
    handlers.get("db-apply-dictionary-changes")({ sender: {} }, { remove: 7 }),
    /remove must be an array/
  );
  // Valid deltas pass through untouched.
  const db = fakeDb();
  let seen;
  db.applyDictionaryChanges = (changes: unknown) => {
    seen = changes;

    return { success: true, added: 1, removed: 0 };
  };

  const handlers2 = setup(db);
  await handlers2.get("db-apply-dictionary-changes")(
    { sender: {} },
    { add: ["Alpha"], remove: [] }
  );
  assert.deepEqual(seen, { add: ["Alpha"], remove: [] });
});

test("hard delete passes the id through and returns the db result", async () => {
  const db = fakeDb();
  const seen: unknown[] = [];
  db.hardDeleteDictionaryEntry = (id: unknown) => {
    seen.push(["dict", id]);

    return { success: true };
  };

  db.hardDeleteSnippet = (id: unknown) => {
    seen.push(["snippet", id]);

    return { success: false };
  };

  const handlers = setup(db);
  assert.deepEqual(await handlers.get("db-hard-delete-dictionary")({ sender: {} }, 3), {
    success: true,
  });
  assert.deepEqual(await handlers.get("db-hard-delete-snippet")({ sender: {} }, "k"), {
    success: false,
  });
  assert.deepEqual(seen, [
    ["dict", 3],
    ["snippet", "k"],
  ]);
});

test("broadcast handlers re-read SQLite and always report success", async () => {
  const db = fakeDb();
  let reads = 0;
  db.getDictionary = () => {
    reads += 1;

    return ["from", "db"];
  };

  db.getSnippets = () => {
    reads += 1;

    return [{ trigger: "t", replacement: "r" }];
  };

  const handlers = setup(db);
  assert.deepEqual(await handlers.get("db-broadcast-dictionary-updated")(), { success: true });
  assert.deepEqual(await handlers.get("db-broadcast-snippets-updated")(), { success: true });
  assert.equal(reads, 2);
  assert.deepEqual(sent, [
    { channel: "dictionary-updated", data: ["from", "db"] },
    { channel: "snippets-updated", data: [{ trigger: "t", replacement: "r" }] },
  ]);
});

test("undo-learned-corrections fails quietly on empty, junk and failing saves", async () => {
  const db = fakeDb();
  db.applyDictionaryChanges = () => {
    throw new Error("db down");
  };

  db.getDictionary = () => [];
  const handlers = setup(db);

  for (const bad of [undefined, null, [], [""], ["   "], [7, null], ["", 7]]) {
    assert.deepEqual(
      await handlers.get("undo-learned-corrections")({ sender: {} }, bad),
      { success: false },
      JSON.stringify(bad)
    );
  }

  // Junk-only arrays fail before the db is touched or a broadcast happens.
  assert.deepEqual(sent, []);

  // A throwing save fails quietly without a broadcast.
  const mixed = await handlers.get("undo-learned-corrections")({ sender: {} }, ["Alpha"]);
  assert.deepEqual(mixed, { success: false });
  assert.deepEqual(sent, []);

  // A failing save result fails quietly too.
  db.applyDictionaryChanges = () => ({ success: false, error: "locked" });
  assert.deepEqual(await handlers.get("undo-learned-corrections")({ sender: {} }, ["Alpha"]), {
    success: false,
  });
  assert.deepEqual(sent, []);
});

test("undo-learned-corrections removes valid words, broadcasts fresh state and succeeds", async () => {
  const db = fakeDb();
  const seen: unknown[] = [];
  db.applyDictionaryChanges = (changes: unknown) => {
    seen.push(changes);

    return { success: true, added: 0, removed: 2 };
  };

  db.getDictionary = () => ["remaining"];
  const handlers = setup(db);
  assert.deepEqual(
    await handlers.get("undo-learned-corrections")({ sender: {} }, ["Alpha", "  ", 7, "beta"]),
    {
      success: true,
    }
  );
  // Only the non-empty strings reach the db, in original form.
  assert.deepEqual(seen, [{ remove: ["Alpha", "beta"] }]);
  // Broadcast payload is re-read, not caller-supplied.
  assert.deepEqual(sent, [{ channel: "dictionary-updated", data: ["remaining"] }]);
});

test("registrations are isolated per call and do not share broadcast state", async () => {
  sent = [];
  const first = new Map();
  const second = new Map();

  const register = (map: any, words: unknown) =>
    registerVocabularyHandlers(
      { handle: (channel: string, handler: unknown) => map.set(channel, handler) },
      {
        database: { ...fakeDb(), getDictionary: () => words },
        debugLogger: { debug() {}, warn() {}, error() {} },
      }
    );

  register(first, ["first"]);
  register(second, ["second"]);
  await first.get("db-broadcast-dictionary-updated")();
  await second.get("db-broadcast-dictionary-updated")();
  assert.deepEqual(sent, [
    { channel: "dictionary-updated", data: ["first"] },
    { channel: "dictionary-updated", data: ["second"] },
  ]);
});

test.after(() => {
  Module._load = originalLoad;
});
