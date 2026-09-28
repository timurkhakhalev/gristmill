// The real bundled preload talks to real registered chat persistence
// handlers over a temporary SQLite database, closing the loop like Electron
// does. Covers: full round-trips with DB normalization, metadata
// serialization across the wire, fake-invoke junk rejection at the preload
// boundary, and the registration-collision guard (a second handle on the
// same channel must fail loudly — the #23 duplicate-handler failure).
const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const vm: typeof import("node:vm") = require("node:vm");
const Module = require("node:module");

const root = path.resolve(__dirname, "../..");
const bundledPreload = path.join(root, "dist-main", "preload.js");

type BridgeHandler = (event: unknown, ...args: unknown[]) => unknown;
let activeHandlers: Map<string, BridgeHandler> | null = null;
let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-chat-bridge-"));

const originalLoad = Module._load;
Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return {
      app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false },
      ipcMain: (() => {
        // One shared duplicate-detecting double: handle() throws on a
        // second registration of the same channel, on()/emit() no-op.
        const seen = new Set<string>();
        const getMap = () => {
          if (!activeHandlers) activeHandlers = new Map<string, BridgeHandler>();
          return activeHandlers;
        };
        return {
          handle: (channel: string, listener: BridgeHandler) => {
            const handlers = getMap();
            if (seen.has(channel)) {
              throw new Error(
                `Attempted to register a second handler for '${channel}'`
              );
            }
            seen.add(channel);
            handlers.set(channel, listener as BridgeHandler);
          },
          on() {},
          removeHandler() {},
          emit() {},
        };
      })(),
      BrowserWindow: { getAllWindows: () => [] },
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
  let api: Record<string, unknown> | undefined;
  vm.runInNewContext(fs.readFileSync(bundledPreload, "utf8"), {
    // The bundle keeps CJS interop for hybrid manifest modules, so the
    // sandbox needs the same bindings Node's CJS loader provides.
    module: { exports: {} },
    exports: {},
    require(name: string) {
      assert.equal(name, "electron", "the bundled preload must only require electron");
      return {
        contextBridge: {
          exposeInMainWorld: (_name: string, value: Record<string, unknown>) => {
            api = value;
          },
        },
        ipcRenderer: {
          invoke,
          send() {},
          on() {},
          removeListener() {},
        },
        webUtils: { getPathForFile: () => "" },
      };
    },
    process: { platform: "darwin", versions: {} },
    console,
  });
  return api!;
}

type DbUnderTest = import("../../src/helpers/chatPersistenceIpcHandlers.js").ChatPersistenceHandlerDeps["database"] & { close: () => void; getPrivateSpaceId: () => unknown };
async function createFixture(t: import("node:test").TestContext): Promise<{ db: DbUnderTest; api: Record<string, (...args: unknown[]) => Promise<any>>; invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } | null> {
  activeHandlers = new Map();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-chat-bridge-"));
  const fixtureDir = userDataDir;
  let db: DbUnderTest | null = null;
  t.after(() => {
    db?.close();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });
  try {
    db = new DatabaseManager() as unknown as NonNullable<typeof db>;
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
  const { registerChatPersistenceHandlers } = await import(
    "../../src/helpers/chatPersistenceIpcHandlers.ts"
  );
  registerChatPersistenceHandlers(
    { handle: (channel: string, listener: BridgeHandler) => activeHandlers!.set(channel, listener) },
    { database: db }
  );

  const handlersSnapshot = new Map(activeHandlers!);
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlersSnapshot.get(channel);
    if (!handler) throw new Error(`No handler registered for ${channel}`);
    return handler(null, ...args);
  };
  const api = loadBundledPreload(invoke) as Record<string, (...args: unknown[]) => Promise<unknown>>;
  return { db, api, invoke };
}

// Objects from vm.runInNewContext have a different prototype; compare by JSON.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("the full bundled preload chain round-trips conversations and messages", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { api, db } = ctx;

  const spaceId = db.getPrivateSpaceId();
  const created = await api.createAgentConversation("Round trip", null, spaceId, null);
  assert.equal(created.title, "Round trip");
  assert.deepEqual(plain(created.messages), []);

  const message = await api.addAgentMessage(created.id, "user", "hello", {
    toolCalls: [{ id: "t1", name: "search_notes", arguments: "{}" }],
  });
  assert.equal(message.conversation_id, created.id);
  assert.deepEqual(JSON.parse(String(message.metadata)).toolCalls, [
    { id: "t1", name: "search_notes", arguments: "{}" },
  ]);
  await api.addAgentMessage(created.id, "assistant", "answer", null);

  const loaded = await api.getAgentConversation(created.id);
  assert.deepEqual(
    plain(loaded.messages!.map((m: { role: string; content: string }) => [m.role, m.content])),
    [
      ["user", "hello"],
      ["assistant", "answer"],
    ]
  );
  assert.deepEqual(plain(await api.getAgentMessages(created.id)), plain(loaded.messages));

  // Note-scoped lists are plain rows without message_count.
  await api.updateAgentConversationTitle(created.id, "Renamed");
  const forNote = await api.getConversationsForNote(987654);
  assert.deepEqual(plain(forNote), []);
  const containerList = await api.getConversationsForContainer(spaceId, null);
  assert.equal((containerList[0] as Record<string, unknown>).message_count, 2);
  assert.equal((containerList[0] as Record<string, unknown>).title, "Renamed");

  const all = await api.getAgentConversations();
  assert.equal(all.some((c: Record<string, unknown>) => c.id === created.id), true);
  assert.equal("message_count" in all[0], false);

  const search = await api.searchAgentConversations("Renamed");
  assert.equal(search.length, 1);
  assert.equal("preview" in search[0], false);

  const preview = await api.getAgentConversationsWithPreview();
  assert.equal(preview.find((c: Record<string, unknown>) => c.id === created.id)?.preview, "answer");

  assert.deepEqual(plain(await api.archiveAgentConversation(created.id)), { success: true });
  assert.equal((await api.getAgentConversations()).length, 0);
  assert.deepEqual(plain(await api.unarchiveAgentConversation(created.id)), { success: true });
  assert.equal((await api.getAgentConversations()).length, 1);

  assert.deepEqual(plain(await api.deleteAgentConversation(created.id)), { success: true });
  assert.equal(await api.getAgentConversation(created.id), null);
  assert.deepEqual(plain(await api.deleteAgentConversation(created.id)), { success: false });
});

test("missing ids stay null through the bridge", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { api } = ctx;

  assert.equal(await api.getAgentConversation(987654), null);
  assert.equal(await api.addAgentMessage(987654, "user", "x"), null);
  assert.deepEqual(plain(await api.getAgentMessages(987654)), []);
  assert.deepEqual(plain(await api.getConversationsForNote(987654)), []);
  assert.deepEqual(plain(await api.getConversationsForContainer(987654, null)), []);
  assert.deepEqual(plain(await api.searchAgentConversations("nothing-matches")), []);
  assert.deepEqual(plain(await api.updateAgentConversationTitle(987654, "x")), { success: false });
  assert.deepEqual(plain(await api.archiveAgentConversation(987654)), { success: false });
  assert.deepEqual(plain(await api.unarchiveAgentConversation(987654)), { success: false });
});

test("a wrong-shaped main response rejects instead of becoming an empty chat", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { api, invoke } = ctx;

  // A main-side crash returning an error object is not a valid detail.
  const apiA = (() => {
    // Rebuild the bridge over the corrupted invoke path.
    const handlers = new Map(activeHandlers);
    return loadBundledPreload(async (channel: string, ...args: unknown[]) => {
      if (channel === "db-get-agent-conversation") return { error: "boom" };
      const handler = handlers.get(channel);
      return handler?.(null, ...args);
    });
  })();
  await assert.rejects((apiA as Record<string, (id: number) => Promise<unknown>>).getAgentConversation(1));

  // A null for a list channel is not a valid list.
  const apiB = loadBundledPreload(async (channel: string, ...args) => {
    if (channel === "db-get-agent-conversations") return null;
    const handler = new Map(activeHandlers!).get(channel);
    return handler?.(null, ...args);
  });
  await assert.rejects((apiB as Record<string, () => Promise<unknown>>).getAgentConversations());

  // A message with an unknown role is rejected at the preload boundary.
  const apiC = loadBundledPreload(async (channel: string, ...args) => {
    if (channel === "db-add-agent-message") {
      return { id: 1, conversation_id: 1, role: "admin", content: "x", metadata: null, created_at: "t" };
    }
    const handler = new Map(activeHandlers!).get(channel);
    return handler?.(null, ...args);
  });
  await assert.rejects((apiC as Record<string, (...a: unknown[]) => Promise<unknown>>).addAgentMessage(1, "user", "x"));

  assert.ok(api && invoke);
});

test("the shared main registration registers every channel exactly once", async (t: import("node:test").TestContext) => {
  // Runs against the real IPCHandlers.setupHandlers over a
  // duplicate-detecting electron stub: if any module (typed or leftover JS)
  // registered db-get-folders or db-create-agent-conversation twice — the
  // #23 packaged-start breakage — setupHandlers throws and the test fails.
  const ctx = await createFixture(t);
  if (!ctx) return;

  const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
  const previousHandlersModule = require.cache[handlersModulePath];
  delete require.cache[handlersModulePath];
  t.after(() => {
    if (previousHandlersModule) require.cache[handlersModulePath] = previousHandlersModule;
    else delete require.cache[handlersModulePath];
  });
  const Ctor: typeof import("../../src/helpers/ipcHandlers.ts").IPCHandlers = require(handlersModulePath);

  // Granola-test style `anything()`: each property access returns a fresh
  // proxy instead of the self-referential one that blows the stack.
  const anything = (): unknown =>
    new Proxy(function () {}, {
      get: (_target, property) => {
        if (property === Symbol.toPrimitive || property === "toString") return () => "";
        if (property === "then") return undefined;
        if (property === "apply" || property === "call" || property === "bind") {
          return () => anything();
        }
        return anything();
      },
      apply: () => anything(),
    });

  const target = { databaseManager: ctx.db };
  Ctor.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value: object, property: string | symbol) => (property in value ? (value as Record<string, unknown>)[property as string] : anything()),
    })
  );

  // setupHandlers completed without the stub throwing, so no channel was
  // registered twice. Assert representative channels from each migrated
  // family were included in this one composition-root registration.
  for (const channel of [
    "db-get-actions",
    "db-get-action",
    "db-create-action",
    "db-update-action",
    "db-delete-action",
    "calendar-get-availability",
    "gcal-start-oauth",
    "gcal-disconnect",
    "gcal-get-connection-status",
    "gcal-get-calendars",
    "gcal-set-calendar-selection",
    "gcal-set-primary-only",
    "gcal-sync-events",
    "gcal-get-upcoming-events",
    "gcal-get-event",
    "mcal-start-oauth",
    "mcal-disconnect",
    "mcal-get-connection-status",
    "mcal-set-primary-only",
    "acal-connect",
    "acal-disconnect",
    "acal-get-connection-status",
    "open-calendar-privacy-settings",
    "db-create-agent-conversation",
    "db-get-agent-conversation",
    "db-add-agent-message",
    "db-get-conversations-for-container",
  ]) {
    assert.equal(typeof activeHandlers!.get(channel), "function", channel);
  }
});
