// The typed calendar event senders: managers broadcast through these, so a
// malformed payload is dropped and diagnosed before reaching renderers —
// only the validation result ever crosses. Electron's BrowserWindow is
// stubbed to capture broadcasts.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const sent : unknown[] = [];
const electronStub = {
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } },
    ],
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};

test.after(() => {
  Module._load = originalLoad;
});

let senders;

test.before(async () => {
  senders = await import("../../src/helpers/calendarEvents.ts");
});

test("account and status events broadcast only valid payloads", () => {
  sent.length = 0;
  senders.sendGcalConnectionChanged({ accounts: [{ email: "g@x.io" }] });
  senders.sendMcalConnectionChanged({ accounts: [] });
  senders.sendAcalConnectionChanged({ connected: true, sourceNames: ["iCloud"] });
  senders.sendGcalEventsSynced();
  senders.sendMcalEventsSynced();
  senders.sendAcalEventsSynced();

  assert.deepEqual(
    sent.map((entry) => entry.channel),
    [
      "gcal-connection-changed",
      "mcal-connection-changed",
      "acal-connection-changed",
      "gcal-events-synced",
      "mcal-events-synced",
      "acal-events-synced",
    ]
  );
  assert.deepEqual(sent[0].payload, { accounts: [{ email: "g@x.io" }] });
  assert.deepEqual(sent[2].payload, { connected: true, sourceNames: ["iCloud"] });
  assert.deepEqual(sent[3].payload, {});
});

test("malformed payloads are dropped, not broadcast", () => {
  sent.length = 0;
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    senders.sendGcalConnectionChanged({ accounts: [{ email: 42 }] });
    senders.sendGcalConnectionChanged({ accounts: null });
    senders.sendMcalConnectionChanged({ connected: true });
    senders.sendAcalConnectionChanged({ connected: true, sourceNames: "iCloud" });
    senders.sendAcalConnectionChanged(null);
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(sent, []);
  assert.equal(errors.length, 5);
  for (const message of errors) assert.match(message, /dropped malformed/);
});
