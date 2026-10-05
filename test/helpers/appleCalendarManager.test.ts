const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const Module = require("node:module");

const managerModulePath = require.resolve("../../src/helpers/appleCalendarManager.ts");
const originalLoad = Module._load;

function loadManager(children?: unknown[]) {
  delete require.cache[managerModulePath];
  Module._load = function loadWithElectronMock(request: string, parent: unknown, isMain: boolean) {
    if (request === "electron") {
      return { app: { isPackaged: true }, BrowserWindow: { getAllWindows: () => [] } };
    }
    if (children && request === "child_process") return { spawn: () => children.shift() };
    if (children && request.includes("binaryResolver")) return { resolveBundledBinary: () => "/owned-test-helper" };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(managerModulePath);
  } finally {
    Module._load = originalLoad;
  }
}

test("an unexpected helper exit schedules a restart while Apple Calendar is connected", () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    const AppleCalendarManager = loadManager();
    const databaseManager = {
      getAppleCalendars: () => [{ id: "calendar-1" }],
    };
    const manager = new AppleCalendarManager(databaseManager, {});
    const child = {};
    let restartCount = 0;
    manager._helperProcess = child;
    manager._scheduleHelperRestart = () => {
      restartCount += 1;
    };

    manager._onHelperGone(child);

    assert.equal(manager._helperProcess, null);
    assert.equal(restartCount, 1);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

test("_mapEvent falls back to a meeting link found in location or notes", () => {
  const AppleCalendarManager = loadManager();
  const manager = new AppleCalendarManager({}, {});

  const mapped = manager._mapEvent({
    id: "evt-1:1755165600",
    calendar_id: "calendar-1",
    title: "External call",
    start: "2026-08-14T10:00:00Z",
    end: "2026-08-14T10:30:00Z",
    is_all_day: false,
    status: "confirmed",
    location: "Zoom: https://example.zoom.us/j/123456789",
    notes_urls: [],
    attendees: [],
  });

  assert.equal(mapped.provider, "apple");
  assert.equal(mapped.hangout_link, "https://example.zoom.us/j/123456789");
  assert.equal(mapped.attendees_count, 0);
  assert.equal(mapped.attendees, null);
});

test("a deliberate stop prevents the exited child from scheduling a restart", () => {
  const AppleCalendarManager = loadManager();
  const databaseManager = {
    getAppleCalendars: () => [{ id: "calendar-1" }],
  };
  const manager = new AppleCalendarManager(databaseManager, {});
  const child = { kill: () => {} };
  let restartCount = 0;
  manager._helperProcess = child;
  manager._scheduleHelperRestart = () => {
    restartCount += 1;
  };

  manager.stop();
  manager._onHelperGone(child);

  assert.equal(restartCount, 0);
});

test("_mapEvent preserves EventKit availability and the current user's response", () => {
  const AppleCalendarManager = loadManager();
  const manager = new AppleCalendarManager({}, {});
  const mapped = manager._mapEvent({
    id: "evt-availability",
    calendar_id: "calendar-1",
    start: "2026-08-14T10:00:00Z",
    end: "2026-08-14T10:30:00Z",
    is_all_day: false,
    status: "confirmed",
    availability: "free",
    attendees: [{ email: "me@example.com", status: "declined", self: true }],
  });

  assert.equal(mapped.availability_status, "free");
  assert.equal(mapped.self_response_status, "declined");
});

test("stdout from disconnected or replaced helpers cannot change data or pending permission", t => {
  const { EventEmitter } = require("node:events");
  const makeChild = () => Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true,
  });
  const old = makeChild(), replacement = makeChild();
  const Apple = loadManager([old, replacement]);
  let rows: Array<{ id: string; title: string }> = [{ id: "old", title: "Old" }];
  let writes = 0, reminders = 0;
  const db = {
    getAppleCalendars: () => rows,
    clearAppleCalendarData: () => { rows = []; writes++; },
    saveAppleCalendars: (calendars: typeof rows) => { rows = calendars; writes++; },
    replaceAppleCalendarEvents: () => { writes++; }, upsertContacts() {},
  };
  const manager = new Apple(db, { reset() {}, reconcileProvider() {}, scheduleNextMeeting: () => { reminders++; } });
  t.after(() => { manager.stop(); delete require.cache[managerModulePath]; });
  const emit = (child: typeof old, payload: unknown) => child.stdout.emit("data", Buffer.from(JSON.stringify(payload) + "\n"));
  const snapshot = { type: "snapshot", calendars: [{ id: "old", title: "Old" }], events: [] };
  assert.equal(manager._spawnHelper(false), true);
  manager.disconnect();
  const baseline = [writes, reminders];
  emit(old, snapshot);
  emit(old, { type: "permission", status: "granted" });
  assert.equal(manager.isConnected(), false);
  assert.deepEqual([writes, reminders], baseline);
  assert.equal(manager._spawnHelper(false), true);
  let resolved = 0;
  manager._pendingConnect = { awaitingSnapshot: false, resolve: () => { resolved++; } };
  emit(old, { type: "permission", status: "denied" });
  emit(old, snapshot);
  assert.equal(resolved, 0);
  assert.equal(manager._pendingConnect.awaitingSnapshot, false);
  assert.deepEqual([writes, reminders], baseline);
  emit(replacement, { type: "permission", status: "granted" });
  assert.equal(manager._pendingConnect.awaitingSnapshot, true);
  emit(replacement, { ...snapshot, calendars: [{ id: "new", title: "New" }] });
  assert.equal(resolved, 1);
  assert.deepEqual(rows, [{ id: "new", title: "New" }]);
  const afterReplacement = [writes, reminders];
  emit(old, { type: "permission", status: "denied" });
  emit(old, snapshot);
  assert.deepEqual(rows, [{ id: "new", title: "New" }]);
  assert.deepEqual([writes, reminders], afterReplacement);
});
