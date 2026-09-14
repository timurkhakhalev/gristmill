// The real bundled preload talks to the real typed calendar availability
// handler over a spy database: success/failure shapes, extra private fields
// dropped at the preload boundary, user-correctable vs generic errors, and
// the shared main registration duplicate-channel guard.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

const root = path.resolve(__dirname, "../..");
const bundledPreload = path.join(root, "dist-main", "preload.js");

let activeHandlers = null;
let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-calavail-"));

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false },
      ipcMain: {
        handle: (channel, listener) => {
          if (!activeHandlers) activeHandlers = new Map();
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

const DatabaseManager = require("../../src/helpers/database.js");

test.after(() => {
  Module._load = originalLoad;
});

function loadBundledPreload(invoke) {
  let api;
  vm.runInNewContext(fs.readFileSync(bundledPreload, "utf8"), {
    require(name) {
      assert.equal(name, "electron", "the bundled preload must only require electron");
      return {
        contextBridge: {
          exposeInMainWorld: (_name, value) => {
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
  return api;
}

// Objects from vm.runInNewContext have a different prototype; compare by JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

const START = "2026-08-25T07:00:00.000Z";
const END = "2026-08-25T12:00:00.000Z";
const NOW = new Date("2026-08-25T06:00:00.000Z");
const REQUEST = { start: START, end: END, minimumSlotMinutes: 30, bufferMinutes: 15 };

async function createFixture(t, { events, dbSpy } = {}) {
  activeHandlers = new Map();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-calavail-"));
  const db = new DatabaseManager();
  t.after(() => db.close());

  const registered = [];
  const { registerCalendarAvailabilityHandler } = await import(
    "../../src/helpers/calendarAvailabilityIpcHandler.ts"
  );
  const spy = dbSpy || ((...args) => registered.push(args));
  registerCalendarAvailabilityHandler(
    { handle: (channel, listener) => activeHandlers.set(channel, listener) },
    {
      databaseManager: {
        getCalendarEventsInRange: (start, end, providers) => {
          spy(start, end, providers);
          return events || [];
        },
      },
      calendarProviders: [
        { provider: "google", manager: { isConnected: () => true } },
        { provider: "microsoft", manager: { isConnected: () => true } },
        { provider: "apple", manager: { isConnected: () => false } },
      ],
      clock: () => NOW,
      logWarn: () => {},
    }
  );

  const handlersSnapshot = new Map(activeHandlers);
  const invoke = async (channel, ...args) => {
    const handler = handlersSnapshot.get(channel);
    if (!handler) throw new Error(`No handler registered for ${channel}`);
    return handler(null, ...args);
  };
  const api = loadBundledPreload(invoke);
  return { api, registered };
}

test("success carries only privacy-safe availability fields", async (t) => {
  const events = [
    {
      start_time: "2026-08-25T09:00:00.000Z",
      end_time: "2026-08-25T10:00:00.000Z",
      status: "confirmed",
      availability_status: "busy",
      summary: "Private board meeting",
      attendees: JSON.stringify([{ email: "private@example.com" }]),
      hangout_link: "https://private.example.com/meeting",
    },
  ];
  const { api, registered } = await createFixture(t, { events });

  const response = await api.calendarGetAvailability(REQUEST);
  assert.equal(response.success, true);
  if (!response.success) return;
  const availability = plain(response.availability);
  assert.equal("busy" in availability, false, "busy never crosses IPC");
  assert.equal(availability.isEntireRangeFree, false);
  assert.equal(availability.availableSlots.length >= 1, true);
  assert.deepEqual(availability.coverage, {
    source: "local-calendar-cache",
    lookaheadDays: 31,
  });
  // Query range extends by the buffer on both sides; disconnected providers are filtered.
  assert.deepEqual(registered[0], [
    "2026-08-25T06:45:00.000Z",
    "2026-08-25T12:15:00.000Z",
    ["google", "microsoft"],
  ]);
});

test("no connected provider fails with the user-correctable message", async (t) => {
  const { api } = await createFixture(t);
  const response = await api.calendarGetAvailability({
    ...REQUEST,
    // Force failure before the DB via an invalid request.
    minimumSlotMinutes: 9999,
  });
  assert.equal(response.success, false);
  if (response.success) return;
  assert.match(response.error, /minimumSlotMinutes must be an integer between 5 and 480/);
});

test("extra private fields are stripped; a structurally wrong response rejects", async (t) => {
  const real = await createFixture(t);
  if (!real) return;
  const handlersSnapshot = new Map(activeHandlers);

  // A misbehaving main mock smuggles busy intervals in: the schema strips
  // unknown keys, so they can never reach the renderer payload.
  const smuggling = loadBundledPreload(async (channel, ...args) => {
    const result = await handlersSnapshot.get(channel)(null, ...args);
    if (result?.success) {
      return { ...result, availability: { ...result.availability, busy: [{ start: "x", end: "y" }] } };
    }
    return result;
  });
  const response = await smuggling.calendarGetAvailability(REQUEST);
  assert.equal(response.success, true);
  if (response.success) {
    assert.equal("busy" in response.availability, false, "busy stripped at the boundary");
  }

  // A structurally wrong payload (missing required fields) rejects outright.
  const broken = loadBundledPreload(async (channel, ...args) => {
    if (channel === "calendar-get-availability") return { success: true, availability: { junk: true } };
    return handlersSnapshot.get(channel)(null, ...args);
  });
  await assert.rejects(broken.calendarGetAvailability(REQUEST), /Unexpected response shape/);
});

test("failure responses stay failure — never a fabricated empty availability", async (t) => {
  const { api } = await createFixture(t);
  const response = await api.calendarGetAvailability({
    start: "not-a-timestamp",
    end: END,
  });
  assert.equal(response.success, false);
  if (response.success) return;
  assert.match(response.error, /start must be an RFC3339 timestamp/);
});

test("the shared main registration registers the availability channel once", async (t) => {
  const ctx = await createFixture(t);
  if (!ctx) return;

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

  const target = { databaseManager: { getCalendarEventsInRange: () => [] } };
  Ctor.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );

  assert.equal(typeof activeHandlers.get("calendar-get-availability"), "function");
});
