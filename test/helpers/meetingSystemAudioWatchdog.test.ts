const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const createMeetingSystemAudioWatchdog = require("../../src/helpers/meetingSystemAudioWatchdog.ts");

const { STALL_MS, GONE_QUIET_MS, MAX_RESTARTS, TICK_GAP_MS } = createMeetingSystemAudioWatchdog;

const { RECOVERY_RETRY_MS } = createMeetingSystemAudioWatchdog;

const START_TIME = 1_000_000;

const TICK_MS = 2_000;

// The restart hook settles on the microtask queue, so every helper that can
// trigger one yields the loop before the caller inspects state.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const createHarness = ({
  startImpl,
  stopImpl,
}: { startImpl?: () => Promise<void> | void; stopImpl?: () => Promise<void> | void } = {}) => {
  let now = START_TIME;
  const calls: unknown[] = [];
  const interruptions: any[] = [];
  const resumed: unknown[] = [];

  const watchdog = createMeetingSystemAudioWatchdog({
    now: () => now,
    onInterrupted: (payload: unknown) => interruptions.push(payload),
    onResumed: () => resumed.push(now),
  });

  // Mirrors startManagedMeetingSystemAudio: capture is attached when it starts,
  // which is before the session is armed.
  const attach = () =>
    watchdog.attachCapture({
      stop: () => {
        calls.push("stop");

        return Promise.resolve(stopImpl?.());
      },
      start: () => {
        calls.push("start");

        return Promise.resolve(startImpl?.());
      },
    });

  const advance = async (ms: number) => {
    let remaining = ms;

    while (remaining > 0) {
      const step = Math.min(TICK_MS, remaining);
      now += step;
      remaining -= step;
      watchdog.tick();
      await flush();
    }
  };

  return {
    watchdog,
    calls,
    interruptions,
    resumed,
    attach,
    advance,
    jump: (ms: number) => {
      now += ms;
    },
    restarts: () => calls.filter((call) => call === "start").length,
    deliver: (audible = false) => watchdog.recordChunk(audible),
  };
};

// Real ordering: attach, arm, then the first chunk proves the stream delivers.
const startNative = (harness: any, { deliver = true, confirmed = true } = {}) => {
  harness.attach();
  harness.watchdog.start({ systemAudioStrategy: "native", watchesDelivery: true });

  if (confirmed) harness.watchdog.recordStarted();

  if (deliver) harness.deliver(true);
};

test("a stream that keeps delivering never restarts", async () => {
  const h = createHarness();
  startNative(h);

  for (let i = 0; i < 100; i += 1) {
    h.deliver(true);
    await h.advance(TICK_MS);
  }

  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.interruptions, []);
});

test("delivery stopping past the stall window restarts capture once", async () => {
  const h = createHarness();
  startNative(h);

  await h.advance(STALL_MS);
  assert.equal(h.restarts(), 0, "must not fire before the window elapses");

  await h.advance(TICK_MS);
  assert.deepEqual(h.calls, ["stop", "start"], "recovery bounces the helper process");
  assert.deepEqual(h.interruptions, [
    { systemAudioStrategy: "native", reason: "no_audio_delivered", recovering: true },
  ]);
});

// The regression that shipped in the first draft: capture attaches during start
// and the session is armed afterwards, so arming must not detach it. It did,
// and the watchdog reported stalls it could not actually recover from.
test("arming the session keeps the capture attached by the start path", async () => {
  const h = createHarness();
  h.attach();
  h.watchdog.start({ systemAudioStrategy: "native", watchesDelivery: true });
  h.deliver(true);

  h.watchdog.reportDeviceInvalidated();
  await flush();

  assert.deepEqual(h.calls, ["stop", "start"], "arming must not drop the restart target");
});

test("a restart resets the stall window rather than firing again immediately", async () => {
  const h = createHarness();
  startNative(h);

  await h.advance(STALL_MS + TICK_MS);
  assert.equal(h.restarts(), 1);

  // Still no audio, but the clock restarts from the restart, not the last chunk.
  await h.advance(STALL_MS);
  assert.equal(h.restarts(), 1);

  await h.advance(TICK_MS);
  assert.equal(h.restarts(), 2);
});

test("restart attempts are capped and the give-up report is sent exactly once", async () => {
  const h = createHarness();
  startNative(h);

  await h.advance((STALL_MS + TICK_MS) * (MAX_RESTARTS + 4));

  assert.equal(h.restarts(), MAX_RESTARTS);
  const gaveUp = h.interruptions.filter((entry) => entry.recovering === false);
  assert.equal(gaveUp.length, 1);
  assert.equal(gaveUp[0].reason, "no_audio_delivered");
  assert.equal(h.interruptions.filter((entry) => entry.recovering === true).length, MAX_RESTARTS);
});

test("giving up suppresses the later quiet report rather than piling on", async () => {
  const h = createHarness();
  startNative(h);

  await h.advance((STALL_MS + TICK_MS) * (MAX_RESTARTS + 1));
  assert.equal(h.interruptions.filter((entry) => entry.recovering === false).length, 1);

  // The delivery branch is latched off, so the quiet check is reachable again;
  // it must not add a second, weaker verdict on top of the give-up one.
  await h.advance(GONE_QUIET_MS + TICK_MS);
  assert.equal(h.interruptions.filter((entry) => entry.reason === "gone_quiet").length, 0);
});

test("reconnecting a device after exhausted recovery starts a fresh attempt", async () => {
  const h = createHarness();
  startNative(h);

  await h.advance((STALL_MS + TICK_MS) * (MAX_RESTARTS + 1));
  assert.equal(h.restarts(), MAX_RESTARTS);

  h.watchdog.reportDeviceInvalidated();
  await flush();
  assert.equal(h.restarts(), MAX_RESTARTS + 1);
  assert.equal(h.interruptions.filter((entry) => entry.recovering === false).length, 1);
});

test("an exited helper can recover later without another device notification", async () => {
  const h = createHarness();
  startNative(h);
  await h.advance((STALL_MS + TICK_MS) * (MAX_RESTARTS + 1));
  assert.equal(h.restarts(), MAX_RESTARTS);
  await h.advance(RECOVERY_RETRY_MS - TICK_MS);
  assert.equal(h.restarts(), MAX_RESTARTS);
  await h.advance(TICK_MS);
  assert.equal(h.restarts(), MAX_RESTARTS + 1);
  h.deliver(false);
  assert.equal(h.resumed.length, 1);
  assert.equal(h.interruptions.filter((entry) => !entry.recovering).length, 1);
});

test("a device invalidation restarts without waiting for the stall window", async () => {
  const h = createHarness();
  startNative(h);

  h.watchdog.reportDeviceInvalidated();
  await flush();

  assert.deepEqual(h.calls, ["stop", "start"]);
  assert.deepEqual(h.interruptions, [
    { systemAudioStrategy: "native", reason: "device_invalidated", recovering: true },
  ]);
});

test("device warnings from retiring capture do not use another restart attempt", async () => {
  const h = createHarness({ stopImpl: () => h.watchdog.reportDeviceInvalidated() });
  startNative(h);

  h.watchdog.reportDeviceInvalidated();
  await flush();

  assert.deepEqual(h.calls, ["stop", "start"]);
  assert.equal(h.interruptions.length, 1);
});

test("replacement device warnings respect the restart cap", async () => {
  const h = createHarness({ startImpl: () => h.watchdog.reportDeviceInvalidated() });
  startNative(h);

  h.watchdog.reportDeviceInvalidated();
  await flush();

  assert.equal(h.restarts(), MAX_RESTARTS);
  assert.equal(h.interruptions.filter((entry) => entry.recovering).length, MAX_RESTARTS);
  assert.deepEqual(h.interruptions.at(-1), {
    systemAudioStrategy: "native",
    reason: "device_invalidated",
    recovering: false,
  });
});

test("a restart that throws still clears the in-flight flag", async () => {
  const h = createHarness({
    startImpl: () => Promise.reject(new Error("helper would not start")),
  });

  startNative(h);

  await h.advance(STALL_MS + TICK_MS);
  assert.equal(h.restarts(), 1);

  await h.advance(STALL_MS + TICK_MS);
  assert.equal(h.restarts(), 2, "a failed restart must not wedge the watchdog");
});

test("nothing is judged while a restart is still in flight", async () => {
  let release!: () => void;

  const h = createHarness({
    startImpl: () => new Promise<void>((resolve) => (release = resolve)),
  });

  startNative(h);

  await h.advance(STALL_MS + TICK_MS);
  assert.equal(h.restarts(), 1);

  // The helper is slow to come back; ticks during that must not stack restarts.
  await h.advance(STALL_MS * 3);
  assert.equal(h.restarts(), 1);

  release();
  await flush();
  await h.advance(STALL_MS + TICK_MS);
  assert.equal(h.restarts(), 2);
});

test("delivery gaps are ignored for strategies that may legitimately go idle", async () => {
  const h = createHarness();
  h.attach();
  h.watchdog.start({ systemAudioStrategy: "wasapi-loopback", watchesDelivery: false });
  h.deliver(true);

  await h.advance(STALL_MS * 10);

  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.interruptions, []);
});

// A pending native start has no first-delivery deadline.
test("an unconfirmed start is not judged on delivery", async () => {
  const h = createHarness();
  startNative(h, { deliver: false, confirmed: false });

  await h.advance(STALL_MS * 10);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.interruptions, []);

  // Once it has delivered, the window applies normally.
  h.deliver(true);
  await h.advance(STALL_MS + TICK_MS);
  assert.equal(h.restarts(), 1);
});

// Date.now() jumps across sleep, and a blocked main process delivers the timer
// tick before the stdout data it should have been judging.
test("a tick gap longer than the sleep threshold rebases the delivery window", async () => {
  const h = createHarness();
  startNative(h);

  await h.advance(TICK_MS);
  h.jump(TICK_GAP_MS + STALL_MS * 5);
  h.watchdog.tick();
  await flush();

  assert.deepEqual(h.calls, [], "waking from sleep must not read as a dead tap");

  // The rebase is one-shot: a stall that outlives it is still caught.
  await h.advance(STALL_MS + TICK_MS);
  assert.equal(h.restarts(), 1);
});

test("a call that goes quiet is reported once and never restarted", async () => {
  const h = createHarness();
  startNative(h);

  // Chunks keep arriving, so delivery is healthy; they are simply silent.
  let elapsed = 0;

  while (elapsed <= GONE_QUIET_MS + TICK_MS * 2) {
    h.deliver(false);
    await h.advance(TICK_MS);
    elapsed += TICK_MS;
  }

  assert.deepEqual(h.calls, [], "a quiet call must never cost the user a restart");
  assert.deepEqual(h.interruptions, [
    { systemAudioStrategy: "native", reason: "gone_quiet", recovering: false },
  ]);
});

test("a session that was never audible does not report going quiet", async () => {
  const h = createHarness();
  h.attach();
  h.watchdog.start({ systemAudioStrategy: "wasapi-loopback", watchesDelivery: false });

  let elapsed = 0;

  while (elapsed <= GONE_QUIET_MS * 2) {
    h.deliver(false);
    await h.advance(TICK_MS);
    elapsed += TICK_MS;
  }

  // That case belongs to the one-shot start-of-session warning, not here.
  assert.deepEqual(h.interruptions, []);
});

for (const systemAudioStrategy of ["native", "wasapi-loopback"]) {
  test(`${systemAudioStrategy} warns again when a new quiet period follows audible recovery`, async () => {
    const h = createHarness();
    h.attach();
    h.watchdog.start({ systemAudioStrategy, watchesDelivery: systemAudioStrategy === "native" });

    for (let quietPeriod = 0; quietPeriod < 2; quietPeriod += 1) {
      h.deliver(true);

      for (let elapsed = 0; elapsed <= GONE_QUIET_MS + TICK_MS; elapsed += TICK_MS) {
        h.deliver(false);
        await h.advance(TICK_MS);
      }

      assert.equal(h.interruptions.length, quietPeriod + 1);
    }

    assert.deepEqual(h.calls, [], "silence is a warning, never a reason to restart");
    assert.ok(h.interruptions.every((entry) => entry.reason === "gone_quiet"));
  });
}

test("audible audio reports resumption once for each quiet warning", async () => {
  const h = createHarness();
  startNative(h);
  assert.deepEqual(h.resumed, [], "ordinary audible capture is not a resumption");

  for (let quietPeriod = 0; quietPeriod < 2; quietPeriod += 1) {
    for (let elapsed = 0; elapsed <= GONE_QUIET_MS + TICK_MS; elapsed += TICK_MS) {
      h.deliver(false);
      await h.advance(TICK_MS);
    }

    assert.equal(h.resumed.length, quietPeriod, "silence must keep the warning active");
    h.deliver(true);
    assert.equal(h.resumed.length, quietPeriod + 1, "audible return clears the quiet warning");
    h.deliver(true);
    assert.equal(h.resumed.length, quietPeriod + 1, "subsequent audible chunks do not repeat it");
  }
});

test("resumption dismisses the live interruption after capture returns", async () => {
  const h = createHarness();
  startNative(h);
  h.watchdog.reportDeviceInvalidated();
  await flush();
  h.deliver(true);

  assert.equal(h.interruptions.length, 1);
  assert.equal(h.resumed.length, 1);
});

test("actual delivery after exhausted recovery clears the failure and rearms monitoring", async () => {
  const h = createHarness();
  startNative(h);
  await h.advance((STALL_MS + TICK_MS) * (MAX_RESTARTS + 1));

  h.deliver(true);
  assert.equal(h.resumed.length, 1);
  h.deliver(true);
  assert.equal(h.resumed.length, 1, "only the first recovered chunk dismisses the interruption");

  for (let elapsed = 0; elapsed <= GONE_QUIET_MS + TICK_MS; elapsed += TICK_MS) {
    h.deliver(false);
    await h.advance(TICK_MS);
  }

  h.watchdog.reportDeviceInvalidated();
  await flush();

  assert.equal(h.restarts(), MAX_RESTARTS + 1);
  assert.equal(h.interruptions.filter((entry) => entry.reason === "gone_quiet").length, 1);
});

test("successful route changes do not exhaust the recording's recovery budget", async () => {
  const h = createHarness();
  startNative(h);

  for (let change = 0; change < MAX_RESTARTS + 3; change += 1) {
    h.watchdog.reportDeviceInvalidated();
    await flush();
    h.deliver(false); // Silent PCM still proves that the tap is delivering.
  }

  assert.equal(h.restarts(), MAX_RESTARTS + 3);
  assert.equal(h.resumed.length, MAX_RESTARTS + 3);
  assert.equal(h.interruptions.filter((entry) => !entry.recovering).length, 0);
});

test("flushing the retiring helper's tail cannot report recovery", async () => {
  const h = createHarness({ stopImpl: () => h.deliver(true) });
  startNative(h);
  h.watchdog.reportDeviceInvalidated();
  await flush();
  assert.deepEqual(h.resumed, []);
  h.deliver(false);
  assert.equal(h.resumed.length, 1);
});

test("a helper failure restarts immediately instead of waiting for missing chunks", async () => {
  const h = createHarness();
  startNative(h);
  h.watchdog.reportCaptureFailed();
  await flush();
  assert.deepEqual(h.calls, ["stop", "start"]);
  assert.equal(h.interruptions[0].recovering, true);
});

test("stop ends the session and a late restart cannot resurrect it", async () => {
  let release!: () => void;

  const h = createHarness({
    startImpl: () => new Promise<void>((resolve) => (release = resolve)),
  });

  startNative(h);

  await h.advance(STALL_MS + TICK_MS);
  assert.equal(h.restarts(), 1);

  h.watchdog.stop();
  release();
  await flush();

  await h.advance(STALL_MS * 5);
  assert.equal(h.restarts(), 1);
});

// A meeting can end in the window between the helper being killed and the
// replacement being spawned. Without the generation check the restart would
// complete anyway and leave an orphan process holding a CoreAudio process tap.
test("a session that ends mid-restart never starts a replacement helper", async () => {
  let releaseStop!: () => void;

  const h = createHarness({
    stopImpl: () => new Promise<void>((resolve) => (releaseStop = resolve)),
  });

  startNative(h);

  await h.advance(STALL_MS + TICK_MS);
  assert.deepEqual(h.calls, ["stop"], "suspended between the two halves");

  h.watchdog.stop();
  releaseStop();
  await flush();
  await flush();

  assert.deepEqual(h.calls, ["stop"], "the replacement must never be spawned");
});

test("a session that ends while the replacement is starting stops the orphan", async () => {
  let releaseStart!: () => void;

  const h = createHarness({
    startImpl: () => new Promise<void>((resolve) => (releaseStart = resolve)),
  });

  startNative(h);

  await h.advance(STALL_MS + TICK_MS);
  assert.deepEqual(h.calls, ["stop", "start"]);

  h.watchdog.reportDeviceInvalidated();
  h.watchdog.stop();
  releaseStart();
  await flush();
  await flush();

  assert.deepEqual(h.calls, ["stop", "start", "stop"], "the helper it started must be killed");
  assert.equal(h.interruptions.length, 1, "queued invalidation must not outlive its session");
});

test("starting again clears the previous session's attempt count", async () => {
  const h = createHarness();
  startNative(h);
  await h.advance((STALL_MS + TICK_MS) * (MAX_RESTARTS + 1));
  assert.equal(h.restarts(), MAX_RESTARTS);

  h.watchdog.stop();
  startNative(h);
  await h.advance(STALL_MS + TICK_MS);

  assert.equal(h.restarts(), MAX_RESTARTS + 1);
});

test("confirmed start without a complete chunk recovers at the first-delivery deadline", async () => {
  const h = createHarness();
  startNative(h, { deliver: false });
  await h.advance(STALL_MS);
  assert.equal(h.restarts(), 0);
  await h.advance(TICK_MS);
  assert.equal(h.restarts(), 1);
  assert.deepEqual(h.interruptions, [
    { systemAudioStrategy: "native", reason: "no_audio_delivered", recovering: true },
  ]);
  assert.equal(h.resumed.length, 0, "an ACK alone is not recovered delivery");
  h.deliver(false);
  assert.equal(h.resumed.length, 1);
});

test("sleep rebases the deadline before the first chunk", async () => {
  const h = createHarness();
  startNative(h, { deliver: false });
  await h.advance(TICK_MS);
  h.jump(TICK_GAP_MS * 4);
  h.watchdog.tick();
  await flush();
  await h.advance(STALL_MS);
  assert.equal(h.restarts(), 0);
  await h.advance(TICK_MS);
  assert.equal(h.restarts(), 1);
});

test("replacement ACK without chunks has its own bounded delivery window", async () => {
  const h = createHarness({ startImpl: () => h.watchdog.recordStarted() });
  startNative(h, { deliver: false });

  for (let attempt = 1; attempt <= MAX_RESTARTS; attempt++) {
    await h.advance(STALL_MS + TICK_MS);
    assert.equal(h.restarts(), attempt);
    assert.equal(h.resumed.length, 0);
  }

  await h.advance(STALL_MS + TICK_MS);
  assert.equal(h.restarts(), MAX_RESTARTS);
  assert.equal(h.interruptions.at(-1).recovering, false);
  h.watchdog.stop();
  h.watchdog.recordStarted();
  await h.advance(STALL_MS + TICK_MS);
  assert.equal(h.restarts(), MAX_RESTARTS);
});

// M0/M1 mutation survivor follow-ups (#382): deferred invalidation and restart-cap observation.
test("watchdog: a device invalidation during an in-flight restart is deferred, not dropped", async () => {
  const restartGate = createDeferredGate();
  let startedCount = 0;
  const h = createHarness({
    startImpl: () => {
      startedCount += 1;

      return restartGate.promise;
    },
  });
  startNative(h);

  // Stall past the window: the first restart begins and stays in flight.
  await h.advance(STALL_MS + TICK_MS);
  assert.equal(startedCount, 1);
  assert.deepEqual(h.calls.slice(0, 1), ["stop"]);

  // A device invalidation arrives while the replacement has not started:
  // it must be retained and consumed after the in-flight restart settles.
  h.watchdog.reportDeviceInvalidated();
  await flush();
  assert.equal(startedCount, 1, "no second start while the first restart is in flight");

  restartGate.release();
  await flush();
  assert.equal(startedCount, 2, "the deferred invalidation triggers exactly one follow-up restart");
  assert.equal(h.restarts(), 2);
});

test("a capture failure during replacement startup does not queue a device invalidation", async () => {
  const restartGate = createDeferredGate();
  const h = createHarness({ startImpl: () => restartGate.promise });
  startNative(h);

  await h.advance(STALL_MS + TICK_MS);
  assert.equal(h.restarts(), 1, "the replacement is starting");

  h.watchdog.reportCaptureFailed();
  await flush();
  assert.equal(h.restarts(), 1, "the in-flight restart remains the only attempt");

  restartGate.release();
  await flush();
  assert.equal(h.restarts(), 1, "capture failure must not queue a device-invalidated restart");
  assert.deepEqual(h.interruptions.map((event) => event.reason), ["no_audio_delivered"]);
});


function createDeferredGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, release: () => release() };
}

test("a stop during an in-flight restart leaves the retiring helper retired", async () => {
  let now = START_TIME;
  const calls: unknown[] = [];
  let releaseStop!: () => void;
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const watchdog = createMeetingSystemAudioWatchdog({
    now: () => now,
    onInterrupted: () => undefined,
    onResumed: () => undefined,
  });

  watchdog.attachCapture({
    stop: () => {
      calls.push("stop");

      return stopGate;
    },
    start: () => {
      calls.push("start");

      return Promise.resolve();
    },
  });
  watchdog.start({ systemAudioStrategy: "native", watchesDelivery: true });
  watchdog.recordStarted();
  watchdog.recordChunk(true);

  // Fire the restart and hold its stop half so the swap is in flight.
  now += STALL_MS + TICK_MS;
  watchdog.tick();
  await flush();
  assert.deepEqual(calls, ["stop"]);

  // Teardown during the swap: the stale generation must refuse the restart's second half.
  watchdog.stop();
  releaseStop();
  await flush();
  await flush();

  assert.deepEqual(calls, ["stop"], "a stale restart must not start the replacement after teardown");
});
