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
