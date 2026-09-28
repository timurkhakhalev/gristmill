const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const {
  NotificationDismissTimer,
  getNotificationTimeoutMs,
}: typeof import("../../src/helpers/notificationTimer") = require("../../src/helpers/notificationTimer");

test("every meeting prompt hides after one minute", () => {
  assert.equal(getNotificationTimeoutMs("calendar"), 60 * 1000);
  assert.equal(getNotificationTimeoutMs("audio"), 60 * 1000);
  assert.equal(getNotificationTimeoutMs("process"), 60 * 1000);
});

test("fires exactly once after the configured duration", (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  let fired = 0;
  const timer = new NotificationDismissTimer(() => fired++);

  timer.start(30_000);
  t.mock.timers.tick(29_999);
  assert.equal(fired, 0);
  t.mock.timers.tick(1);
  assert.equal(fired, 1);
  t.mock.timers.tick(60_000);
  assert.equal(fired, 1);
});

test("pause halts the countdown", (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  let fired = 0;
  const timer = new NotificationDismissTimer(() => fired++);

  timer.start(30_000);
  t.mock.timers.tick(29_000);
  timer.pause();
  t.mock.timers.tick(120_000);

  assert.equal(fired, 0, "a paused timer must never fire");
});

test("resume continues with the remaining time", (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  let fired = 0;
  const timer = new NotificationDismissTimer(() => fired++);

  timer.start(30_000);
  t.mock.timers.tick(10_000);
  timer.pause();
  t.mock.timers.tick(120_000);
  timer.resume();
  t.mock.timers.tick(19_999);
  assert.equal(fired, 0, "the countdown must pick up where it left off");
  t.mock.timers.tick(1);
  assert.equal(fired, 1);
});

test("resume keeps a minimum runway", (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  let fired = 0;
  const timer = new NotificationDismissTimer(() => fired++);

  timer.start(30_000);
  t.mock.timers.tick(29_500);
  timer.pause();
  timer.resume();
  t.mock.timers.tick(500);
  assert.equal(fired, 0, "the card must not vanish right as the pointer leaves");
  t.mock.timers.tick(4_500);
  assert.equal(fired, 1);
});

test("cancel prevents firing and clears any paused state", (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  let fired = 0;
  const timer = new NotificationDismissTimer(() => fired++);

  timer.start(30_000);
  timer.pause();
  timer.cancel();
  timer.resume();
  t.mock.timers.tick(120_000);

  assert.equal(fired, 0, "cancel must also discard the paused remainder");
});

test("pause and resume without a started timer are no-ops", (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  let fired = 0;
  const timer = new NotificationDismissTimer(() => fired++);

  timer.pause();
  timer.resume();
  t.mock.timers.tick(120_000);

  assert.equal(fired, 0);
});

test("start replaces a running countdown", (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  let fired = 0;
  const timer = new NotificationDismissTimer(() => fired++);

  timer.start(30_000);
  t.mock.timers.tick(29_000);
  timer.start(30_000);
  t.mock.timers.tick(29_999);
  assert.equal(fired, 0, "the old deadline must not survive a restart");
  t.mock.timers.tick(1);
  assert.equal(fired, 1);
});
