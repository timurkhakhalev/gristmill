const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const CalendarSyncInterval = require("../../src/helpers/calendarSyncInterval.ts");
const { FOCUS_SYNC_THROTTLE_MS } = CalendarSyncInterval;

type Outcome = { total: number; succeeded: number; failed: number; errors: string[] };
function createRunner(syncFn: () => Promise<Outcome | void>, overrides: Record<string, unknown> = {}) {
  return new CalendarSyncInterval(syncFn, {
    intervalMs: 1000,
    maxIntervalMs: 4000,
    logScope: "test",
    ...overrides,
  });
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

const FAILURE = { total: 2, succeeded: 0, failed: 2, errors: ["provider down", "provider down"] };
const PARTIAL = { total: 2, succeeded: 1, failed: 1, errors: ["calendar b failed"] };

test("backoff doubles the interval per consecutive failure up to the cap", () => {
  const runner = createRunner(() => Promise.resolve());

  assert.equal(runner._getInterval(), 1000);
  runner._consecutiveFailures = 1;
  assert.equal(runner._getInterval(), 2000);
  runner._consecutiveFailures = 2;
  assert.equal(runner._getInterval(), 4000);
  runner._consecutiveFailures = 5;
  assert.equal(runner._getInterval(), 4000);
});

test("notifySuccess resets the backoff to the base interval", () => {
  const runner = createRunner(() => Promise.resolve());

  runner._consecutiveFailures = 3;
  runner.notifySuccess();

  assert.equal(runner._getInterval(), 1000);
  runner.stop();
});

// Regression: the managers resolve with `failed > 0` instead of rejecting on a
// full provider outage. The runner must treat that resolved outcome as failure
// and back off, not as a successful pass.
test("a resolved outcome with failures backs off even though the promise fulfilled", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const runner = createRunner(() => {
    calls += 1;
    return Promise.resolve(FAILURE);
  });

  runner.start();
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);
  await flushPromises();

  // 1000ms interval was replaced by a 2000ms one after the resolved failure.
  assert.equal(runner._consecutiveFailures, 1);
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);
  t.mock.timers.tick(1000);
  assert.equal(calls, 2);

  runner.stop();
});

// Regression: a partial outcome (some calendars updated) must also back off —
// an incomplete pass is not a healthy pass.
test("a partially failed outcome backs off", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const runner = createRunner(() => {
    calls += 1;
    return Promise.resolve(PARTIAL);
  });

  runner.start();
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);
  await flushPromises();
  assert.equal(runner._consecutiveFailures, 1);

  runner.stop();
});

// Regression: recovery (a clean outcome after failures) restores the base
// interval. Without the reset the timer stays backed off after the provider
// recovers, delaying every later sync.
test("a clean outcome after failures restores the normal interval", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  let fail = true;
  const runner = createRunner(() => {
    calls += 1;
    return Promise.resolve(fail ? FAILURE : { total: 2, succeeded: 2, failed: 0, errors: [] });
  });

  runner.start();
  t.mock.timers.tick(1000);
  await flushPromises();
  assert.equal(runner._consecutiveFailures, 1);

  // Provider recovers: the next run at the backed-off 2000ms succeeds.
  fail = false;
  t.mock.timers.tick(2000);
  assert.equal(calls, 2);
  await flushPromises();
  await flushPromises();
  assert.equal(runner._consecutiveFailures, 0);
  assert.equal(runner._getInterval(), 1000);

  runner.stop();
});

// Regression: a sync that resolves after stop() must not restart the timer.
// The old reschedule-on-failure path re-armed setInterval unconditionally, so a
// late failure resurrected a stopped runner.
test("a late resolved failure after stop does not restart the timer", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let resolveSync: (value: Outcome) => void = () => {};
  let calls = 0;
  const runner = createRunner(() => {
    calls += 1;
    return new Promise<Outcome>((resolve) => {
      resolveSync = resolve;
    });
  });

  runner.start();
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);

  runner.stop();
  resolveSync(FAILURE);
  await flushPromises();
  await flushPromises();

  t.mock.timers.tick(100000);
  assert.equal(calls, 1, "stopped runner must ignore the late completion");
  assert.equal(runner.timer, null);
});

// Regression (R166-1): guarding every reschedule on a `_running` flag silently
// stopped the managers' explicit out-of-band paths (wake, selection) from
// rescheduling after a stop — the old code called _schedule() unconditionally
// there. The runner must distinguish an explicit outcome from a tick completion
// that merely raced a stop.
test("an explicit out-of-band outcome schedules after stop while a racing tick completion does not", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let resolveTick: (value: Outcome) => void = () => {};
  let calls = 0;
  const runner = createRunner(() => {
    calls += 1;
    return new Promise<Outcome>((resolve) => {
      resolveTick = resolve;
    });
  });

  runner.start();
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);

  // A tick completion that lands after stop must not re-arm the timer.
  runner.stop();
  assert.equal(runner.timer, null);
  resolveTick(FAILURE);
  await flushPromises();
  await flushPromises();
  assert.equal(runner.timer, null, "racing tick completion must not re-arm");

  // An explicit out-of-band outcome (post-stop wake / selection) still does.
  runner.notifyOutcome(FAILURE);
  assert.notEqual(runner.timer, null, "explicit out-of-band outcome must reschedule");
  assert.equal(runner._consecutiveFailures, 1);

  runner.stop();
});

// Regression (R166-2): the focus path's rejection handler only logged, so a
// rejected focus sync never counted toward backoff. It must record the same
// failure shape as the interval tick.
test("a rejected focus sync records a failure and backs off", async () => {
  let calls = 0;
  const runner = createRunner(() => {
    calls += 1;
    return Promise.reject(new Error("boom"));
  });

  runner.syncOnFocus();
  await flushPromises();
  await flushPromises();

  assert.equal(calls, 1);
  assert.equal(runner._consecutiveFailures, 1);
  assert.equal(runner._getInterval(), 2000);

  runner.stop();
});

test("a failed sync reschedules the next run at the backed-off interval", async (t: import("node:test").TestContext) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const runner = createRunner(() => {
    calls += 1;
    return Promise.reject(new Error("boom"));
  });

  runner.start();
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);
  await flushPromises();

  // The 1000ms interval was replaced by a 2000ms one after the failure
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);
  t.mock.timers.tick(1000);
  assert.equal(calls, 2);

  runner.stop();
});

test("focus syncs are throttled to one per window", async () => {
  let calls = 0;
  const runner = createRunner(() => {
    calls += 1;
    return Promise.resolve();
  });

  runner.syncOnFocus();
  runner.syncOnFocus();
  assert.equal(calls, 1);

  runner._lastFocusSync = Date.now() - FOCUS_SYNC_THROTTLE_MS - 1;
  runner.syncOnFocus();
  assert.equal(calls, 2);

  await flushPromises();
  runner.stop();
});

for (const outcome of ["failed", "rejected", "clean"] as const) {
  test(`late focus ${outcome} outcome cannot re-arm a stopped timer`, async t => {
    t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 100_000 });
    let resolve!: (value: Outcome) => void, reject!: (error: Error) => void;
    let calls = 0;
    const runner = createRunner(() => ++calls === 1
      ? new Promise<Outcome>((done, fail) => { resolve = done; reject = fail; })
      : Promise.resolve(FAILURE));
    t.after(() => runner.stop());
    runner.notifyOutcome(FAILURE);
    runner.syncOnFocus();
    assert.equal(calls, 1);
    runner.stop();
    if (outcome === "rejected") reject(new Error("provider down"));
    else resolve(outcome === "failed" ? FAILURE : { total: 1, succeeded: 1, failed: 0, errors: [] });
    await flushPromises();
    assert.equal(runner.timer, null);
    assert.equal(runner._consecutiveFailures, 1, "old outcome cannot change backoff");
    t.mock.timers.tick(100_000);
    assert.equal(calls, 1);
    runner.syncOnFocus();
    await flushPromises();
    assert.equal(calls, 2);
    assert.notEqual(runner.timer, null, "a deliberate new focus failure can schedule backoff");
  });
}
