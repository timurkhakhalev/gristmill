const test: typeof import("node:test") = require("node:test");

const { skipOrFail }: typeof import("./harness/nativeBinding.ts") = require("./harness/nativeBinding.ts");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const os: typeof import("node:os") = require("node:os");

const path: typeof import("node:path") = require("node:path");

const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-cli-dict-"));

const originalLoad = Module._load;

// Routes broadcast through the shared windowBroadcast module, which reaches for
// Electron's BrowserWindow; capture the calls so they can be asserted here.
const broadcasts: unknown[] = [];

Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }

  if (request === "./windowBroadcast" || request === "./windowBroadcast.js") {
    return {
      broadcastToWindows: (channel: string, payload: unknown) =>
        broadcasts.push({ channel, payload }),
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager: typeof import("../../src/helpers/database.ts").DatabaseManager = require("../../src/helpers/database.ts");

const CliBridge = require("../../src/helpers/cliBridge.ts");

// Builds the route table against a real database with broadcasts stubbed. The
// constructor does not start a server, so routes can be invoked directly.
function createBridge(t: import("node:test").TestContext) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-cli-dict-"));
  let db: import("../../src/helpers/database.js").DatabaseManager | null = null;

  try {
    const BetterSqlite = require("better-sqlite3");
    const probe = new BetterSqlite(path.join(userDataDir, "probe.db"));
    probe.close();
    fs.rmSync(path.join(userDataDir, "probe.db"), { force: true });
    db = new DatabaseManager() as import("../../src/helpers/database.js").DatabaseManager;
  } catch (error) {
    skipOrFail(t, error);

    return null;
  }

  broadcasts.length = 0;
  const bridge = new CliBridge({ databaseManager: db }, userDataDir);

  return { bridge, db, broadcasts };
}

function call(
  bridge: InstanceType<typeof CliBridge>,
  method: string,
  pathname: string,
  body: unknown = undefined
): unknown {
  for (const route of bridge.routes) {
    if (route.method !== method) continue;
    const params = route.match(pathname);

    if (!params) continue;

    return route.handler({ params, query: new URLSearchParams(), body });
  }

  throw new Error(`No route for ${method} ${pathname}`);
}

test("GET /v1/dictionary/list returns the stored words", (t: import("node:test").TestContext) => {
  const ctx = createBridge(t);

  if (!ctx) return;

  ctx.db.setDictionary(["OpenWhispr", "Alice"]);
  const result = call(ctx.bridge, "GET", "/v1/dictionary/list") as { data: string[] };
  assert.deepEqual(result.data, ["OpenWhispr", "Alice"]);
});

test("POST /v1/dictionary/update bulk-adds words that survive a reload", (t: import("node:test").TestContext) => {
  const ctx = createBridge(t);

  if (!ctx) return;

  ctx.db.setDictionary(["OpenWhispr"]);
  const contacts = ["Ada Lovelace", "Grace Hopper", "Katherine Johnson"];

  const result = call(ctx.bridge, "POST", "/v1/dictionary/update", { add: contacts }) as {
    data: { added: number };
  };

  assert.equal(result.data.added, 3);
  assert.deepEqual(ctx.db.getDictionary(), ["OpenWhispr", ...contacts]);

  ctx.db.close();
  const reopened = new DatabaseManager();
  assert.deepEqual(reopened.getDictionary(), ["OpenWhispr", ...contacts]);
  reopened.close();
});

test("POST /v1/dictionary/update removes only the named words", (t: import("node:test").TestContext) => {
  const ctx = createBridge(t);

  if (!ctx) return;

  ctx.db.setDictionary(["OpenWhispr", "Alice", "Bob"]);

  const result = call(ctx.bridge, "POST", "/v1/dictionary/update", { remove: ["Alice"] }) as {
    data: { removed: number };
  };

  assert.equal(result.data.removed, 1);
  assert.deepEqual(ctx.db.getDictionary(), ["OpenWhispr", "Bob"]);
});

test("POST /v1/dictionary/update broadcasts the new list to renderers", async (t: import("node:test").TestContext) => {
  // The route defers its broadcast with setImmediate, and the synchronous tests
  // above never yield to the event loop, so their broadcasts are still queued
  // here. Let them land before createBridge resets the recorder, or they are
  // counted against this test.
  await new Promise((resolve) => setImmediate(resolve));

  const ctx = createBridge(t);

  if (!ctx) return;

  ctx.db.setDictionary(["OpenWhispr"]);
  call(ctx.bridge, "POST", "/v1/dictionary/update", { add: ["Alice"] });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ctx.broadcasts.length, 1);
  assert.equal((ctx.broadcasts[0] as { channel: string }).channel, "dictionary-updated");
  assert.deepEqual((ctx.broadcasts[0] as { payload: unknown }).payload, ["OpenWhispr", "Alice"]);
});

test("POST /v1/dictionary/update rejects a non-array field", (t: import("node:test").TestContext) => {
  const ctx = createBridge(t);

  if (!ctx) return;

  assert.throws(() => call(ctx.bridge, "POST", "/v1/dictionary/update", { add: "Alice" }), {
    code: "VALIDATION",
  });
});

test("POST /v1/dictionary/update rejects non-string entries", (t: import("node:test").TestContext) => {
  const ctx = createBridge(t);

  if (!ctx) return;

  assert.throws(() => call(ctx.bridge, "POST", "/v1/dictionary/update", { add: ["Alice", 7] }), {
    code: "VALIDATION",
  });
});

test("POST /v1/dictionary/update rejects an empty request", (t: import("node:test").TestContext) => {
  const ctx = createBridge(t);

  if (!ctx) return;

  assert.throws(() => call(ctx.bridge, "POST", "/v1/dictionary/update", {}), {
    code: "VALIDATION",
  });
});

test("route validation errors respond with HTTP 400 validation_error", async (t: import("node:test").TestContext) => {
  const ctx = createBridge(t);

  if (!ctx) return;

  ctx.bridge.token = "test-token";
  ctx.bridge.port = 8200;

  class MockResponse {
    statusCode: string | number | null;
    headers: Record<string, unknown>;
    body: string;
    constructor() {
      this.statusCode = null;
      this.headers = {};
      this.body = "";
    }
    writeHead(code: string, headers: Record<string, unknown>) {
      this.statusCode = code;
      this.headers = headers;
    }
    end(chunk?: string) {
      if (chunk) this.body += chunk;
    }
  }

  const req = {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { authorization: "Bearer test-token" },
    method: "GET",
    url: "/v1/notes/search",
  };

  const res = new MockResponse();

  await ctx.bridge._handleRequest(req, res);

  assert.equal(res.statusCode, 400);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.error.code, "validation_error");
  assert.equal(parsed.error.message, "Search query is required");
});

test("POST /v1/dictionary/update responds with HTTP 400 validation_error for invalid payload", async (t: import("node:test").TestContext) => {
  const ctx = createBridge(t);

  if (!ctx) return;

  ctx.bridge.token = "test-token";
  ctx.bridge.port = 8200;

  class MockResponse {
    statusCode: string | number | null;
    headers: Record<string, unknown>;
    body: string;
    constructor() {
      this.statusCode = null;
      this.headers = {};
      this.body = "";
    }
    writeHead(code: string, headers: Record<string, unknown>) {
      this.statusCode = code;
      this.headers = headers;
    }
    end(chunk?: string) {
      if (chunk) this.body += chunk;
    }
  }

  const req = {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { authorization: "Bearer test-token" },
    method: "POST",
    url: "/v1/dictionary/update",
    on(event: unknown, handler: (chunk?: string) => void) {
      if (event === "data") {
        handler(JSON.stringify({ add: "not-an-array" }));
      }

      if (event === "end") {
        handler();
      }
    },
  };

  const res = new MockResponse();

  await ctx.bridge._handleRequest(req, res);

  assert.equal(res.statusCode, 400);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.error.code, "validation_error");
  assert.equal(parsed.error.message, "'add' must be an array of strings");
});
