const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/meetingCompanionPolicy.ts");

const WORK_AREA = { x: 0, y: 25, width: 1440, height: 875 };

test("the companion shows only while recording with the control panel unfocused", async () => {
  const { shouldShowMeetingCompanion } = await load();

  assert.equal(shouldShowMeetingCompanion(true, false), true);
  assert.equal(shouldShowMeetingCompanion(true, true), false);
  assert.equal(shouldShowMeetingCompanion(false, false), false);
});

test("the default spot sits on the right edge, inside the work area", async () => {
  const { defaultCompanionPosition, clampToWorkArea, MEETING_COMPANION_SIZE } = await load();

  const point = defaultCompanionPosition(WORK_AREA, MEETING_COMPANION_SIZE);
  assert.equal(point.x, WORK_AREA.width - MEETING_COMPANION_SIZE - 12);
  assert.deepEqual(clampToWorkArea(point, WORK_AREA, MEETING_COMPANION_SIZE), point);
});

test("dragging past any edge keeps the whole bubble on screen", async () => {
  const { clampToWorkArea } = await load();

  assert.deepEqual(clampToWorkArea({ x: -50, y: 0 }, WORK_AREA, 64), { x: 0, y: 25 });
  assert.deepEqual(clampToWorkArea({ x: 5000, y: 5000 }, WORK_AREA, 64), { x: 1376, y: 836 });
  // Displays left of or above the primary one have negative origins.
  const left = { x: -1920, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(clampToWorkArea({ x: -1000.4, y: 500.6 }, left, 64), { x: -1000, y: 501 });
});
