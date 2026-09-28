const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const load = () => import("../../src/utils/dateFormatting.js");
import type { TestContext } from "node:test";

test("future timestamps use a calendar date instead of the now label", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-21T12:00:00.000Z") });
  const { formatRelativeTime, formatShortDate } = await load();
  const futureTimestamp = "2026-08-21T14:00:00.000Z";

  assert.equal(
    formatRelativeTime(futureTimestamp, (key: string, _options?: Record<string, unknown>) => key),
    formatShortDate(futureTimestamp)
  );
});

test("explicit date and time formats override locale order and clock without changing the language", async () => {
  const { formatDate, formatTime, formatNoteDate } = await load();
  const previousTimezone = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    const date = new Date("2026-09-28T15:35:00Z");
    assert.equal(formatDate(date, "en", { year: "numeric", month: "short", day: "numeric" }, "dmy"), "28.09.2026");
    assert.equal(formatDate(date, "en", { year: "numeric", month: "short", day: "numeric" }, "mdy"), "09/28/2026");
    assert.equal(formatDate(date, "en", { year: "numeric", month: "short", day: "numeric" }, "ymd"), "2026-09-28");
    assert.equal(formatTime(date, "en", { hour: "numeric", minute: "2-digit" }, "12h"), "3:35 PM");
    assert.equal(formatTime(date, "en", { hour: "numeric", minute: "2-digit" }, "24h"), "15:35");
    assert.equal(formatTime(new Date("2026-09-29T00:00:00Z"), "en", { hour: "numeric", minute: "2-digit" }, "24h"), "00:00");
    assert.equal(formatNoteDate("2026-09-28T15:35:00Z", "en", "dmy", "24h"), "28.09.2026 · 15:35");
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});
