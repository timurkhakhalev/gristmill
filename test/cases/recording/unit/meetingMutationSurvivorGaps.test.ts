const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const {
  createMeetingSystemAudioWatchdog,
  STALL_MS,
  MAX_RESTARTS,
} = require("../../../../src/helpers/meetingSystemAudioWatchdog.ts");

const createMeetingAudioTimeline = require("../../../../src/helpers/meetingAudioTimeline.ts");
const { MeetingClockSync } = require("../../../../src/helpers/meetingClockSync.ts");
const { meetingResamplerManifest, meetingResamplerDecisionSummary } = require("../../../../src/helpers/meetingResamplerMapping.ts");
const { calibratedEpoch } = require("../../../helpers/harness/meetingResampler.ts");
const { createMeetingRecordingStartCoordinator, runMeetingAutoEndRestart } = require("../../../../src/helpers/meetingRecordingSession.ts");

const START_TIME = 1_000_000;
const TICK_MS = 2_000;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function createDeferredGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, release: () => release() };
}

const createWatchdogHarness = ({
  startImpl,
  stopImpl,
}: { startImpl?: () => Promise<void> | void; stopImpl?: () => Promise<void> | void } = {}) => {
  let now = START_TIME;
  const calls: unknown[] = [];
  const interruptions: any[] = [];

  const watchdog = createMeetingSystemAudioWatchdog({
    now: () => now,
    onInterrupted: (payload: unknown) => interruptions.push(payload),
    onResumed: () => undefined,
  });

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
    attach,
    advance,
    restarts: () => calls.filter((call) => call === "start").length,
    deliver: (audible = false) => watchdog.recordChunk(audible),
    arm: () => {
      attach();
      watchdog.start({ systemAudioStrategy: "native", watchesDelivery: true });
      watchdog.recordStarted();
      watchdog.recordChunk(true);
    },
  };
};

test("watchdog: a device invalidation during an in-flight restart is deferred, not dropped", async () => {
  const restartGate = createDeferredGate();
  let startedCount = 0;
  const h = createWatchdogHarness({
    startImpl: () => {
      startedCount += 1;

      return restartGate.promise;
    },
  });
  h.arm();

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

test("watchdog: restart attempts stop at the cap even when ticks keep finding stalls", async () => {
  const h = createWatchdogHarness();
  h.arm();

  await h.advance((STALL_MS + TICK_MS) * (MAX_RESTARTS + 2));

  assert.equal(h.restarts(), MAX_RESTARTS);
  const gaveUp = h.interruptions.filter((entry) => entry.recovering === false);
  assert.equal(gaveUp.length, 1);
  assert.equal(gaveUp[0].reason, "no_audio_delivered");
});

test("audio timeline: rejects unsafe origins without disturbing a valid timeline", () => {
  for (const origin of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createMeetingAudioTimeline({ originFrame: origin }), RangeError);
  }

  const timeline = createMeetingAudioTimeline({ originFrame: 4_800 });
  assert.equal(timeline.lastFrame, 4_800);
  assert.throws(() => timeline.write(Buffer.alloc(2_400), 0, () => undefined), /frame range/);
  assert.throws(() => timeline.markRestart(2_400), RangeError);
  assert.equal(timeline.markRestart(9_600), 9_600);
});

test("audio timeline: rejects empty, odd and misaligned writes before any output", () => {
  const cases: [Buffer, number][] = [
    [Buffer.alloc(0), 0],
    [Buffer.alloc(3), 0],
    [Buffer.alloc(2), 1.5],
    [Buffer.alloc(2), -2],
  ];

  for (const [buffer, frameStart] of cases) {
    let emitted = 0;
    const timeline = createMeetingAudioTimeline();
    assert.throws(
      () =>
        timeline.write(buffer, frameStart, () => {
          emitted += 1;
        }),
      /frame range/
    );
    assert.equal(emitted, 0, "no samples may be emitted for an invalid write");
  }

  // After a rejection the anchor is unchanged and the next valid write proceeds from it.
  const timeline = createMeetingAudioTimeline();
  timeline.write(Buffer.alloc(4), 0, () => undefined);
  assert.equal(timeline.lastFrame, 2);
  assert.throws(() => timeline.write(Buffer.alloc(4), 1, () => undefined), /frame range/);
  timeline.write(Buffer.alloc(4), 2, () => undefined);
  assert.equal(timeline.lastFrame, 4);
});

test("session lifecycle: a cancellation scoped to another session cannot cancel the active start", async () => {
  const coordinator = createMeetingRecordingStartCoordinator();
  const events: unknown[] = [];
  const release = createDeferredGate();

  const activeStart = coordinator.runStart("meeting-1", async () => {
    events.push("capture:meeting-1");
    await release.promise;
  });

  assert.equal(await coordinator.cancelActiveStart("meeting-2"), null, "a foreign session id must not cancel the active start");

  release.release();
  await activeStart;
  assert.deepEqual(events, ["capture:meeting-1"], "the start ran to completion");
});

test("session lifecycle: auto-end restart aborts when a recording is live, before and after the note read", async () => {
  // Early guard: the note is never read when a recording is already live.
  let noteReads = 0;
  const earlyStarted: unknown[] = [];
  const earlyOutcome = await runMeetingAutoEndRestart(
    { sessionId: "meeting-1" },
    autoEndContext(),
    {
      getActiveSessionId: () => "meeting-live",
      getLatestSegments: () => [],
      getNote: async () => {
        noteReads += 1;

        return { transcript: "[]" };
      },
      parseSegments: (raw: string) => JSON.parse(raw) as never,
      startRecording: async () => {
        earlyStarted.push(1);

        return true;
      },
    } as never
  );

  assert.deepEqual(earlyOutcome, { status: "aborted", reason: "already-recording" });
  assert.equal(earlyStarted.length, 0);
  assert.equal(noteReads, 0, "the early guard must fire before the note read");

  // Late guard: a recording wins the race across the awaited note read.
  let active: string | null = null;
  const lateStarted: unknown[] = [];
  const noteRead = createDeferredGate();
  const lateOutcomePromise = runMeetingAutoEndRestart(
    { sessionId: "meeting-1" },
    autoEndContext(),
    {
      getActiveSessionId: () => active,
      getLatestSegments: () => [],
      getNote: async () => {
        await noteRead.promise;

        return { transcript: "[]" };
      },
      parseSegments: (raw: string) => JSON.parse(raw) as never,
      startRecording: async () => {
        lateStarted.push(1);

        return true;
      },
    } as never
  );

  active = "meeting-live";
  noteRead.release();

  assert.deepEqual(await lateOutcomePromise, { status: "aborted", reason: "already-recording" });
  assert.equal(lateStarted.length, 0);
});

function autoEndContext() {
  return {
    sessionId: "meeting-1",
    args: { noteId: 7, noteTitle: "Standup", folderId: 3, seedSegments: [], autoEndEligible: true },
  };
}

test("clock sync: every accept guard clause rejects on its own", () => {
  const reply = (
    nonce: string,
    sourceSendNs: bigint,
    sourceReceiveNs: bigint,
    offsetNs: bigint,
    helperGeneration = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    helperFrame = 0,
    type = "probe"
  ) => ({
    type,
    nonce,
    helperReceiveNs: (sourceSendNs + offsetNs + 1_000n).toString(),
    helperSendNs: (sourceReceiveNs + offsetNs - 1_000n).toString(),
    helperGeneration,
    helperFrame,
  });

  const sync = new MeetingClockSync();
  sync.reset("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

  let createdProbes = 0;
  const makeProbe = (send: bigint) => {
    createdProbes += 1;

    return sync.createProbe(send.toString(), `00000000-0000-4000-8000-${createdProbes.toString(16).padStart(12, "0")}`);
  };

  const good = (nonce: string, send: bigint) => reply(nonce, send, send + 4_000_000n, 1_002_000n);

  // One probe cannot establish a rate; the mapping appears from the second onward.
  assert.equal(sync.accept(good(makeProbe(1_000_000_000n).nonce, 1_000_000_000n), "1004000000"), null);

  assert.ok(sync.accept(good(makeProbe(1_400_000_000n).nonce, 1_400_000_000n), "1404000000"), "the happy path must still map");

  const replyAt = (send: bigint) => reply(makeProbe(send).nonce, send, send + 4_000_000n, 1_002_000n);
  const cases: [string, () => unknown][] = [
    ["unrequested nonce", () => sync.accept(reply("missing", 1_800_000_000n, 1_800_004_000n, 1_002_000n), "1804000000")],
    ["unknown reply type", () => sync.accept({ ...replyAt(1_800_000_000n), type: "other" }, "1804000000")],
    ["foreign helper generation", () => sync.accept(reply(replyAt(1_800_000_000n).nonce, 1_800_000_000n, 1_800_004_000n, 1_002_000n, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), "1804000000")],
    ["fractional helper frame", () => sync.accept({ ...replyAt(1_800_000_000n), helperFrame: 1.5 }, "1804000000")],
    ["negative helper frame", () => sync.accept({ ...replyAt(1_800_000_000n), helperFrame: -1 }, "1804000000")],
    ["source receive before send", () => sync.accept(reply(replyAt(1_800_000_000n).nonce, 1_800_004_000n, 1_800_000_000n, 1_002_000n), "1800000000")],
    ["helper send before receive", () => sync.accept(reply(replyAt(1_800_000_000n).nonce, 1_800_000_000n, 1_800_004_000n, -1_002_000n), "1804000000")],
    ["unparseable local receive time", () => sync.accept(replyAt(1_800_000_000n), "not-nanoseconds")],
  ];

  for (const [name, run] of cases) {
    assert.equal(run(), null, `${name} must be rejected`);
  }

  // The happy path still maps after every rejection.
  const trailing = makeProbe(2_200_000_000n);
  assert.ok(sync.accept(good(trailing.nonce, 2_200_000_000n), "2204000000"), "guards must not poison later accepts");
});

test("clock sync: continuation beyond the calibrated span extrapolates with growing uncertainty", () => {
  const sync = new MeetingClockSync();
  sync.reset("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

  const sendProbe = (t: bigint, nonce: string) => {
    const probe = sync.createProbe(t.toString(), nonce);

    return sync.accept(
      {
        type: "probe" as const,
        nonce: probe.nonce,
        helperReceiveNs: (t + 1_002_000n).toString(),
        helperSendNs: (t + 4_000_000n + 1_000_000n).toString(),
        helperGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        helperFrame: 0,
      },
      (t + 4_000_000n).toString()
    );
  };

  assert.equal(sendProbe(1_000_000_000n, "11111111-1111-4111-8111-111111111111"), null);
  assert.ok(sendProbe(2_000_000_000n, "22222222-2222-4222-8222-222222222222"), "two probes establish the clock model");

  const at500 = sync.mappingAt("2500004000", "2500004000");
  const at1000 = sync.mappingAt("3000004000", "3000004000");

  assert.ok(at500 && at1000);
  // The estimate advances by the mean rate; the offset grows by the elapsed source time.
  assert.equal(at500.helperEstimateNs, "2501005008");
  assert.equal(at1000.helperEstimateNs, "3001005012");
  assert.equal(at500.offsetNs, 1_001_008);
  assert.equal(at1000.offsetNs, 1_001_012);
  // Uncertainty grows with the extrapolation distance (clipped hull intercepts widen).
  assert.equal(at500.uncertaintyNs, 1_997);
  assert.equal(at1000.uncertaintyNs, 2_997);
  // Helper bounds bracket the estimate on both continuations.
  for (const mapping of [at500, at1000]) {
    assert.ok(BigInt(mapping.helperMinimumNs) <= BigInt(mapping.helperEstimateNs));
    assert.ok(BigInt(mapping.helperEstimateNs) <= BigInt(mapping.helperMaximumNs));
  }

  // Beyond the bounded continuation window (5 s past the last source sample) there is no mapping.
  assert.equal(sync.mappingAt("7300004000", "7300004000"), null);
  // A stale freshness view (queried against a source time older than the model span) is rejected too.
  assert.equal(sync.mappingAt("2500004000", "7300004000"), null);
});

test("clock sync: the eight-sample window keeps the latest midpoints, not the first accepted", () => {
  const sync = new MeetingClockSync();
  sync.reset("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

  const send = (t: bigint, index: number) => {
    const probe = sync.createProbe(t.toString(), `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`);

    return sync.accept(
      {
        type: "probe" as const,
        nonce: probe.nonce,
        helperReceiveNs: (t + 1_000_000n + BigInt(index) * 2_000n).toString(),
        helperSendNs: (t + 4_000_000n + 1_000_000n + BigInt(index) * 2_000n).toString(),
        helperGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        helperFrame: 0,
      },
      (t + 4_000_000n).toString()
    );
  };

  // Ten ascending probes; the window must retain the eight latest midpoints.
  for (let index = 0; index < 10; index++) {
    send(1_100_000_000n + BigInt(index) * 100_000_000n, index);
  }

  const continuation = sync.mappingAt("2400000000", "2400000000");
  assert.ok(continuation);
  assert.equal(continuation.helperEstimateNs, "2401025961");
  assert.equal(continuation.uncertaintyNs, 86);
});

test("resampler mapping: provenance continuity accepts at the exact uncertainty edge and resets beyond it", () => {
  const manifestAt = (anchor: number) =>
    meetingResamplerManifest(
      "mic",
      [calibratedEpoch([{ frames: 96000, start: 0, uncertainty: 10 }, { frames: 96000, start: anchor }])],
      () => "private.f32",
      200_000
    );

  const atEdge = manifestAt(96_011);
  assert.deepEqual(atEdge.decisions, [
    { epochPosition: 0, rangeIndex: 1, precedingEnd: 96_000, anchor: 96_011, correction: 11, reason: "accepted" },
  ]);
  assert.equal(atEdge.epochs[0].rows[0].timelineEnd, 96_011);
  assert.equal(atEdge.epochs[0].rows[1].reset, false);
  assert.equal(atEdge.boundaryResets, 0);

  const beyond = manifestAt(96_012);
  assert.equal(beyond.decisions[0]?.reason, "uncertainty");
  assert.equal(beyond.epochs[0].rows[0].timelineEnd, 96_000);
  assert.equal(beyond.epochs[0].rows[1].reset, true);
});

test("resampler mapping: validation guards keep distinct messages and strict extent semantics", () => {
  const epoch = () => calibratedEpoch([{ frames: 96000, start: 0 }]);
  const prepare = (extent: number, source = "mic") =>
    meetingResamplerManifest(source, [epoch()], () => "private.f32", extent);

  assert.throws(() => prepare(Number.NaN), {
    name: "Error",
    message: "Meeting audio preparation has invalid integer coordinates",
  });
  assert.throws(() => prepare(1_000.5), {
    name: "Error",
    message: "Meeting audio preparation has invalid integer coordinates",
  });
  assert.throws(() => prepare(0), {
    name: "Error",
    message: "Meeting audio preparation has no extent",
  });
  assert.throws(() => prepare(96_000, "loudness"), {
    name: "Error",
    message: "Meeting audio preparation source mismatch",
  });
  assert.throws(() => prepare(95_999), {
    name: "Error",
    message: "Meeting audio preparation has inconsistent coverage",
  });
  assert.throws(
    () => meetingResamplerManifest("mic", [calibratedEpoch([{ frames: 96000, start: 0, rate: 1.002 }])], () => "private.f32", 200_000),
    { name: "Error", message: "Meeting audio preparation has unsupported alignment" }
  );

  // The inclusive alignment-rate bounds accept exactly 0.999 and 1.001; just outside throws.
  for (const rate of [0.999, 1.001]) {
    const manifest = meetingResamplerManifest(
      "mic",
      [calibratedEpoch([{ frames: 96000, start: 0, rate, uncertainty: 100 }, { frames: 96000, start: 96_000 }])],
      () => "private.f32",
      200_000
    );

    assert.ok(manifest.epochs[0].rows.length >= 1);
  }

  assert.throws(
    () => meetingResamplerManifest("mic", [calibratedEpoch([{ frames: 96000, start: 0, rate: 0.9989 }])], () => "private.f32", 200_000),
    /unsupported alignment/
  );
  assert.throws(
    () => meetingResamplerManifest("mic", [calibratedEpoch([{ frames: 96000, start: 0, rate: 1.0011 }])], () => "private.f32", 200_000),
    /unsupported alignment/
  );
});

test("resampler mapping: an accepted continuation followed by an epoch boundary keeps reset accounting exact", () => {
  const first = calibratedEpoch([{ frames: 96000, start: 0 }, { frames: 96000, start: 96_010 }], 0, 1);
  const second = calibratedEpoch([{ frames: 96000, start: 192_010 }], 1, 1);
  const manifest = meetingResamplerManifest("mic", [first, second], () => "private.f32", 300_000);

  assert.deepEqual(
    manifest.epochs.map((epoch: any) => epoch.rows.map((row: any) => row.reset)),
    [
      [true, false],
      [true],
    ]
  );
  assert.equal(manifest.boundaryResets, 1);
  assert.deepEqual(
    manifest.decisions.map((decision: any) => decision.reason),
    ["accepted"]
  );
  assert.deepEqual(meetingResamplerDecisionSummary(manifest), {
    candidates: 1,
    accepted: 1,
    rejected: 0,
    uncertainty: 0,
    effectiveRate: 0,
    acceptedShare: 1,
    corrections: [10],
    boundaryResets: 1,
  });
});
