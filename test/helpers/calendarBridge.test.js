// The real bundled preload talks to the real typed calendar handlers over
// fake managers: command shapes crossing the wire per provider, event
// payloads reaching callbacks with malformed ones dropped, idempotent
// unsubscribe, junk command responses rejected at the preload boundary and
// the shared main registration duplicate-channel guard.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

const root = path.resolve(__dirname, "../..");
const bundledPreload = path.join(root, "dist-main", "preload.js");

let activeHandlers = new Map();

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => "/tmp",
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
      ipcMain: {
        handle: (channel, listener) => {
          if (activeHandlers.has(channel)) {
            throw new Error(`Attempted to register a second handler for '${channel}'`);
          }
          activeHandlers.set(channel, listener);
        },
        on() {},
        removeHandler() {},
        emit() {},
      },
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
process.env.NODE_ENV = "test";

test.after(() => {
  Module._load = originalLoad;
});

function loadBundledPreload(transport) {
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
          invoke: (channel, ...args) => transport.invoke(channel, ...args),
          send: () => {},
          on: (channel, listener) => transport.on(channel, listener),
          removeListener: (channel, listener) => transport.removeListener(channel, listener),
        },
        webUtils: { getPathForFile: () => "" },
      };
    },
    process: { platform: "darwin", versions: {} },
    console,
  });
  return api;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

async function createFixture() {
  assert.ok(fs.existsSync(bundledPreload), "Run pnpm run build:main first");
  activeHandlers = new Map();
  const { registerCalendarIntegrationHandlers } = await import(
    "../../src/helpers/calendarIpcHandlers.ts"
  );

  const sent = [];
  const listeners = new Map();
  registerCalendarIntegrationHandlers(
    { handle: (channel, listener) => activeHandlers.set(channel, listener) },
    {
      googleManager: {
        startOAuth: async () => ({ success: true, email: "g@x.io" }),
        disconnect: () => {},
        getConnectionStatus: () => ({
          connected: true,
          configured: true,
          accounts: [{ email: "g@x.io" }],
          email: "g@x.io",
        }),
        getCalendars: () => [],
        setCalendarSelection: async () => {},
        setPrimaryOnly: async () => {},
        syncEvents: async () => {},
      },
      microsoftManager: {
        startOAuth: async () => ({ success: true, email: "m@x.io" }),
        disconnect: () => {},
        getConnectionStatus: () => ({ connected: false, configured: false, accounts: [] }),
        setPrimaryOnly: async () => {},
      },
      appleManager: {
        connect: async () => ({ success: true }),
        disconnect: () => ({ success: true }),
        getConnectionStatus: () => ({ connected: false, sourceNames: [] }),
      },
      getUpcomingEvents: async () => [],
      getCalendarEventById: () => null,
      openCalendarPrivacySettings: async () => ({ success: true }),
      logError: () => {},
    }
  );

  const handlersSnapshot = new Map(activeHandlers);
  const transport = {
    invoke: async (channel, ...args) => {
      const handler = handlersSnapshot.get(channel);
      if (!handler) throw new Error(`No handler for ${channel}`);
      return handler(null, ...args);
    },
    on: (channel, listener) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(listener);
    },
    removeListener: (channel, listener) => {
      listeners.get(channel)?.delete(listener);
    },
  };
  const api = loadBundledPreload(transport);
  const pushEvent = (channel, payload) => {
    for (const listener of listeners.get(channel) ?? []) listener({}, payload);
  };
  return { api, pushEvent, sent };
}

test("command shapes cross the bundled preload per provider", async () => {
  const { api } = await createFixture();

  assert.deepEqual(plain(await api.gcalStartOAuth()), { success: true, email: "g@x.io" });
  assert.deepEqual(plain(await api.gcalGetConnectionStatus()), {
    connected: true,
    configured: true,
    accounts: [{ email: "g@x.io" }],
    email: "g@x.io",
  });
  assert.deepEqual(plain(await api.gcalDisconnect("g@x.io")), { success: true });
  assert.deepEqual(plain(await api.gcalGetCalendars()), { success: true, calendars: [] });
  assert.deepEqual(plain(await api.gcalSetPrimaryOnly(false)), { success: true });
  assert.deepEqual(plain(await api.gcalGetUpcomingEvents(60)), { success: true, events: [] });
  assert.deepEqual(plain(await api.gcalGetEvent("evt-1")), { success: true, event: null });

  assert.deepEqual(plain(await api.mcalGetConnectionStatus()), {
    connected: false,
    configured: false,
    accounts: [],
  });
  assert.deepEqual(plain(await api.acalConnect()), { success: true });
  assert.deepEqual(plain(await api.acalGetConnectionStatus()), {
    connected: false,
    sourceNames: [],
  });
  assert.deepEqual(plain(await api.openCalendarPrivacySettings()), { success: true });

  // Invalid arguments fail closed at the bridge without an IPC round-trip.
  assert.deepEqual(plain(await api.gcalGetUpcomingEvents(-1)), { success: false, events: [] });
  assert.deepEqual(plain(await api.gcalGetEvent("")), { success: false, event: null });
});

test("events reach callbacks for all three providers; malformed payloads are dropped", async () => {
  const { api, pushEvent } = await createFixture();
  const received = { gcal: [], mcal: [], acal: [], synced: 0 };

  const unsubGcal = api.onGcalConnectionChanged((data) => received.gcal.push(data));
  const unsubMcal = api.onMcalConnectionChanged((data) => received.mcal.push(data));
  const unsubAcal = api.onAcalConnectionChanged((data) => received.acal.push(data));
  const unsubSynced = api.onGcalEventsSynced(() => {
    received.synced += 1;
  });

  pushEvent("gcal-connection-changed", { accounts: [{ email: "g@x.io" }] });
  pushEvent("mcal-connection-changed", { accounts: [] });
  pushEvent("acal-connection-changed", { connected: true, sourceNames: ["iCloud"] });
  pushEvent("gcal-events-synced", {});

  for (const payload of [null, {}, { accounts: "nope" }, { accounts: [{ email: 1 }] }]) {
    pushEvent("gcal-connection-changed", payload);
    pushEvent("mcal-connection-changed", payload);
  }
  pushEvent("acal-connection-changed", { connected: "yes" });
  pushEvent("acal-connection-changed", { connected: true, sourceNames: "iCloud" });
  pushEvent("gcal-events-synced", { unexpected: true });
  pushEvent("gcal-events-synced", null);

  assert.deepEqual(plain(received.gcal), [{ accounts: [{ email: "g@x.io" }] }]);
  assert.deepEqual(plain(received.mcal), [{ accounts: [] }]);
  assert.deepEqual(plain(received.acal), [{ connected: true, sourceNames: ["iCloud"] }]);
  assert.equal(received.synced, 1);

  // Unsubscribe is idempotent and stops delivery.
  unsubGcal();
  unsubGcal();
  pushEvent("gcal-connection-changed", { accounts: [{ email: "later@x.io" }] });
  assert.equal(received.gcal.length, 1);
  unsubMcal();
  unsubAcal();
  unsubSynced();
});

test("junk command responses reject at the preload boundary", async () => {
  await createFixture();
  const realHandlers = new Map(activeHandlers);
  const api = loadBundledPreload({
    invoke: async (channel, ...args) => {
      if (channel === "gcal-get-connection-status") return { connected: 1 };
      if (channel === "gcal-start-oauth") return { silentlyWrong: true };
      if (channel === "gcal-get-upcoming-events") return { success: true, events: "nope" };
      if (channel === "open-calendar-privacy-settings") return { success: "yes" };
      return realHandlers.get(channel)(null, ...args);
    },
    on: () => {},
    removeListener: () => {},
  });
  await assert.rejects(api.gcalGetConnectionStatus());
  await assert.rejects(api.gcalStartOAuth());
  await assert.rejects(api.gcalGetUpcomingEvents(60));
  await assert.rejects(api.openCalendarPrivacySettings());
});

test("the shared main registration registers each calendar channel once", async () => {
  activeHandlers = new Map();

  const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;

  const anything = () =>
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

  const target = {};
  Ctor.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );

  for (const channel of [
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
  ]) {
    assert.equal(typeof activeHandlers.get(channel), "function", channel);
  }
});
