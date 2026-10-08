// The real bundled preload talks to the real typed calendar handlers over
// fake managers: command shapes crossing the wire per provider, event
// payloads reaching callbacks with malformed ones dropped, idempotent
// unsubscribe and junk command responses rejected at the preload boundary.
const test: typeof import("node:test") = require("node:test");

const { loadBundledPreload: loadPreload, plain }: typeof import("./harness/bundledPreload.ts") = require("./harness/bundledPreload.ts");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const Module = require("node:module");

type BridgeHandler = (event: unknown, ...args: unknown[]) => unknown;

let activeHandlers = new Map<string, BridgeHandler>();

const originalLoad = Module._load;

Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => "/tmp",
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
      ipcMain: {
        handle: (channel: string, listener: BridgeHandler) => {
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

const originalNodeEnv = process.env.NODE_ENV;

process.env.NODE_ENV = "test";

test.after(() => {
  Module._load = originalLoad;

  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

type CalendarListener = { [k: `on${string}`]: (cb: (...args: unknown[]) => void) => () => void };

type CalendarApi = { [k: string]: (...args: unknown[]) => Promise<unknown> } & CalendarListener;

function loadBundledPreload(transport: {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, listener: (event: unknown, payload: unknown) => void) => void;
  removeListener: (channel: string, listener: (event: unknown, payload: unknown) => void) => void;
}) {
  return loadPreload<CalendarApi>(transport);
}

async function createFixture(
  googleSyncEvents?: () => Promise<{
    total: number;
    succeeded: number;
    failed: number;
    errors: string[];
  }>
) {
  activeHandlers = new Map();

  const { registerCalendarIntegrationHandlers } =
    await import("../../src/helpers/calendarIpcHandlers.ts");

  const sent: unknown[] = [];
  const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>();
  registerCalendarIntegrationHandlers(
    { handle: (channel: string, listener: BridgeHandler) => activeHandlers.set(channel, listener) },
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
        syncEvents: googleSyncEvents ?? (async () => {}),
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
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = handlersSnapshot.get(channel);

      if (!handler) throw new Error(`No handler for ${channel}`);

      return handler(null, ...args);
    },
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      if (!listeners.has(channel))
        listeners.set(channel, new Set<(event: unknown, payload: unknown) => void>());
      listeners.get(channel)!.add(listener);
    },
    removeListener: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      listeners.get(channel)?.delete(listener);
    },
  };

  const api = loadBundledPreload(transport);

  const pushEvent = (channel: string, payload: unknown) => {
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

// Regression: `partial` is projected in-process, but nothing guaranteed it
// survived the preload parse. The bridge must carry the partial marker and a
// full-failure result through the shared schema unchanged.
test("gcal sync partial and failure results cross the bundled preload", async () => {
  const outcomes = [
    { total: 2, succeeded: 1, failed: 1, errors: ["calendar b failed"] },
    { total: 2, succeeded: 0, failed: 2, errors: ["provider down", "provider down"] },
    { total: 2, succeeded: 2, failed: 0, errors: [] },
  ];

  let callIndex = 0;
  const { api } = await createFixture(async () => outcomes[callIndex++]);

  assert.deepEqual(plain(await api.gcalSyncEvents()), { success: true, partial: true });
  assert.deepEqual(plain(await api.gcalSyncEvents()), { success: false, error: "provider down" });
  assert.deepEqual(plain(await api.gcalSyncEvents()), { success: true });
});

test("events reach callbacks for all three providers; malformed payloads are dropped", async () => {
  const { api, pushEvent } = await createFixture();

  const received = {
    gcal: [] as unknown[],
    mcal: [] as unknown[],
    acal: [] as unknown[],
    synced: 0,
  };

  const unsubGcal = api.onGcalConnectionChanged((data: unknown) => received.gcal.push(data));
  const unsubMcal = api.onMcalConnectionChanged((data: unknown) => received.mcal.push(data));
  const unsubAcal = api.onAcalConnectionChanged((data: unknown) => received.acal.push(data));

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
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel === "gcal-get-connection-status") return { connected: 1 };

      if (channel === "gcal-start-oauth") return { silentlyWrong: true };

      if (channel === "gcal-get-upcoming-events") return { success: true, events: "nope" };

      if (channel === "open-calendar-privacy-settings") return { success: "yes" };

      return realHandlers.get(channel)?.(null, ...args);
    },
    on: () => {},
    removeListener: () => {},
  });

  await assert.rejects(api.gcalGetConnectionStatus());
  await assert.rejects(api.gcalStartOAuth());
  await assert.rejects(api.gcalGetUpcomingEvents(60));
  await assert.rejects(api.openCalendarPrivacySettings());
});
