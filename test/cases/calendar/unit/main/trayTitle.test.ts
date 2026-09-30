const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const Module = require("node:module");
type CalendarEventRow = import("../../../../../src/helpers/database.js").CalendarEventRow;

test("menubar keeps the current calendar meeting until its end, then shows the next", () => {
  const modulePath = require.resolve("../../../../../dist-main/src/helpers/tray.js");
  const originalLoad = Module._load;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Module._load = function(request: string, parent: { filename?: string }, isMain: boolean) {
    if (parent?.filename === modulePath) {
      if (request === "electron") return {};
      if (request === "./debugLogger.js") return { error: () => {} };
      if (request === "./dockManager.js") return {};
      if (request === "./menuManager.js") return { MenuManager: {} };
      if (request === "./i18nMain.js") return { i18nMain: { language: "en", t: (key: string, args: { time?: string; m?: number } = {}) =>
        key === "tray.inTime" ? `in ${args.time}` : key === "tray.timeLeft" ? `${args.time} left` : `${args.m}m` } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    delete require.cache[modulePath];
    const { TrayManager }: typeof import("../../../../../src/helpers/tray.js") = require(modulePath);
    const manager = new TrayManager();
    const rangeEvent = { start_time: "2026-09-29T10:00:00Z", end_time: "2026-09-29T11:30:00Z" } as CalendarEventRow;
    manager.timeFormat = "24h";
    const clock24 = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", hourCycle: "h23" });
    assert.equal(manager.formatTimeRange(rangeEvent), `${clock24.format(new Date(rangeEvent.start_time))} - ${clock24.format(new Date(rangeEvent.end_time))}`);
    manager.timeFormat = "12h";
    assert.match(manager.formatTimeRange(rangeEvent), /AM|PM/);
    let refresh: (() => void) | undefined;
    const originalInterval = global.setInterval;
    try {
      global.setInterval = ((callback: () => void, delay: number) => {
        assert.equal(delay, 1000);
        refresh = callback;
        return { unref() {} };
      }) as unknown as typeof setInterval;
      manager.startRefreshTimer();
    } finally {
      global.setInterval = originalInterval;
      manager.refreshTimer = null;
    }
    let updates = 0;
    const originalUpdate = manager.updateTrayMenu;
    manager.updateTrayMenu = () => { updates++; };
    refresh!();
    assert.equal(updates, 1);
    manager.updateTrayMenu = originalUpdate;
    let title = "";
    manager.tray = { setTitle: (value: string) => { title = value; } } as never;
    const start = Date.parse("2026-09-29T10:00:00Z");
    const end = start + 30 * 60000;
    const event = (summary: string, from: number, to: number): CalendarEventRow => ({
      summary, start_time: new Date(from).toISOString(), end_time: new Date(to).toISOString(),
    } as CalendarEventRow);
    manager.calendarSource = { getUpcomingEvents: () => [
      event("Next", end + 10 * 60000, end + 40 * 60000),
      event("Current", start, end),
      event("Ended", start - 60 * 60000, start - 2 * 60000),
    ] };
    manager.updateTrayTitle(start - 60000);
    assert.equal(title, "Current • in 1m");
    manager.updateTrayTitle(start);
    assert.equal(title, "Current • 30m left");
    manager.updateTrayTitle(end - 1);
    assert.equal(title, "Current • 1m left");
    manager.updateTrayTitle(end);
    assert.equal(title, "Next • in 10m");
    manager.updateTrayTitle(end + 40 * 60000);
    assert.equal(title, "");
    manager.calendarSource = { getUpcomingEvents: () => [event("A long meeting title", start, end)] };
    manager.updateTrayTitle(start);
    assert.equal(title, "A long meet… • 30m left");
    manager.menuOpen = true;
    manager.calendarSource = { getUpcomingEvents: () => [] };
    manager.updateTrayMenu();
    assert.equal(title, "");
    const withId = (item: CalendarEventRow, id: string): CalendarEventRow => ({ ...item, provider: "google", id });
    const nowEvent = withId(event("Now", start, end), "now");
    manager.calendarSource = { getUpcomingEvents: () => [nowEvent, withId(event("Later", end + 10 * 60000, end + 40 * 60000), "later")] };
    manager.menuOpen = false;
    manager.meetingCaptureActive = false;
    const currentItem = manager.buildCurrentMeetingItem(start + 60000);
    assert.equal(currentItem?.label, "Now");
    assert.equal(Array.isArray(currentItem?.submenu) && currentItem.submenu.length, 2);
    manager.meetingCaptureActive = true;
    assert.equal(manager.buildCurrentMeetingItem(start + 60000)?.submenu, undefined);
    manager.meetingCaptureActive = false;
    manager.tray = { setTitle: (value: string) => { title = value; } } as never;
    manager.updateTrayMenu = () => {};
    manager.skipEvent(nowEvent);
    assert.equal(manager.buildCurrentMeetingItem(start + 60000), null);
    manager.updateTrayTitle(start + 60000);
    assert.equal(title, "Later • in 39m");
    manager.skippedEvents.clear();
    let popups = 0;
    manager.tray = { popUpContextMenu: () => { popups++; } } as never;
    manager.contextMenu = {} as never;
    manager.menuOpen = false;
    manager.menuClosedAt = 0;
    manager.showTrayMenu(1000);
    assert.equal(popups, 1);
    manager.menuOpen = true;
    manager.showTrayMenu(1000);
    assert.equal(popups, 1);
    manager.menuOpen = false;
    manager.menuClosedAt = 1000;
    manager.showTrayMenu(1100);
    assert.equal(popups, 1);
    manager.showTrayMenu(1400);
    assert.equal(popups, 2);
  } finally {
    Module._load = originalLoad;
    Object.defineProperty(process, "platform", platform);
    delete require.cache[modulePath];
  }
});
