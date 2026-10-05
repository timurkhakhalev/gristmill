const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const os: typeof import("node:os") = require("node:os");

const path: typeof import("node:path") = require("node:path");

const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-cli-snip-"));

const originalLoad = Module._load;

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

function isNativeBindingUnavailable(error: unknown) {
  const message = String((error as { message?: unknown })?.message || error);

  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function createBridge(t: import("node:test").TestContext) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-cli-snip-"));
  let db: any;

  try {
    const BetterSqlite = require("better-sqlite3");
    const probe = new BetterSqlite(path.join(userDataDir, "probe.db"));
    probe.close();
    fs.rmSync(path.join(userDataDir, "probe.db"), { force: true });
    db = new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");

      return null;
    }

    throw error;
  }

  broadcasts.length = 0;
  const bridge = new CliBridge({ databaseManager: db }, userDataDir);

  return { bridge, db, broadcasts };
}

function call(bridge: any, method: string, pathname: string, body?: unknown): any {
  for (const route of bridge.routes) {
    if (route.method !== method) continue;
    const params = route.match(pathname);

    if (!params) continue;

    return route.handler({ params, query: new URLSearchParams(), body });
  }

  throw new Error(`No route for ${method} ${pathname}`);
}

const signOff = { trigger: "sign-off", replacement: "Best,\nGabe" };

const ask = { trigger: "investor ask", replacement: "We are raising a seed round." };

test("GET /v1/snippets/list returns the stored snippets", (t: import("node:test").TestContext) => {
  const ctx = createBridge(t);

  if (!ctx) return;

  ctx.db.setSnippets([signOff, ask]);
  const result = call(ctx.bridge, "GET", "/v1/snippets/list");
  assert.deepEqual(result.data, [signOff, ask]);
});

test("POST /v1/snippets/update adds snippets and replaces an existing trigger", (t: import("node:test").TestContext) => {
  const ctx = createBridge(t);

  if (!ctx) return;

  ctx.db.setSnippets([signOff]);
  const replaced = { trigger: "Sign-Off", replacement: "Cheers,\nGabe" };
  const result = call(ctx.bridge, "POST", "/v1/snippets/update", { add: [replaced, ask] });

  assert.equal(result.data.added, 2);
  assert.equal(result.data.removed, 0);
  assert.deepEqual(ctx.db.getSnippets(), [replaced, ask]);
});

test("POST /v1/snippets/update removes only the named triggers", (t: import("node:test").TestContext) => {
  const ctx = createBridge(t);

  if (!ctx) return;

  ctx.db.setSnippets([signOff, ask]);
  const result = call(ctx.bridge, "POST", "/v1/snippets/update", { remove: ["Investor Ask"] });

  assert.equal(result.data.removed, 1);
  assert.deepEqual(ctx.db.getSnippets(), [signOff]);
});

test("POST /v1/snippets/update broadcasts the new list to renderers", async (t: import("node:test").TestContext) => {
  await new Promise((resolve) => setImmediate(resolve));

  const ctx = createBridge(t);

  if (!ctx) return;

  call(ctx.bridge, "POST", "/v1/snippets/update", { add: [signOff] });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ctx.broadcasts.length, 1);
  assert.equal((ctx.broadcasts[0] as { channel: string }).channel, "snippets-updated");
  assert.deepEqual((ctx.broadcasts[0] as { payload: unknown }).payload, [signOff]);
});

test("POST /v1/snippets/update counts only snippets the database stored", (t: import("node:test").TestContext) => {
  const ctx = createBridge(t);

  if (!ctx) return;

  const tooLong = { trigger: "x".repeat(101), replacement: "dropped" };
  const result = call(ctx.bridge, "POST", "/v1/snippets/update", { add: [tooLong, signOff] });

  assert.equal(result.data.added, 1);
  assert.deepEqual(ctx.db.getSnippets(), [signOff]);
});

test("POST /v1/snippets/update rejects malformed and empty requests", (t: import("node:test").TestContext) => {
  const ctx = createBridge(t);

  if (!ctx) return;

  assert.throws(
    () => call(ctx.bridge, "POST", "/v1/snippets/update", { add: [{ trigger: "x" }] }),
    { code: "VALIDATION" }
  );
  assert.throws(() => call(ctx.bridge, "POST", "/v1/snippets/update", {}), {
    code: "VALIDATION",
  });
});
