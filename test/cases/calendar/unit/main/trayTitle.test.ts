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
      if (request === "./i18nMain.js") return { i18nMain: { t: (key: string, args: { time?: string; m?: number }) =>
        key === "tray.inTime" ? `in ${args.time}` : `${args.m}m` } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    delete require.cache[modulePath];
    const { TrayManager }: typeof import("../../../../../src/helpers/tray.js") = require(modulePath);
    const manager = new TrayManager();
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
    assert.equal(title, "Current");
    manager.updateTrayTitle(end - 1);
    assert.equal(title, "Current");
    manager.updateTrayTitle(end);
    assert.equal(title, "Next • in 10m");
    manager.updateTrayTitle(end + 40 * 60000);
    assert.equal(title, "");
    manager.calendarSource = { getUpcomingEvents: () => [event("A long meeting title", start, end)] };
    manager.updateTrayTitle(start);
    assert.equal(title, "A long meeting…");
    manager.menuOpen = true;
    manager.calendarSource = { getUpcomingEvents: () => [] };
    manager.updateTrayMenu();
    assert.equal(title, "");
  } finally {
    Module._load = originalLoad;
    Object.defineProperty(process, "platform", platform);
    delete require.cache[modulePath];
  }
});
