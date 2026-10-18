const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const {
  MeetingClockSync,
}: typeof import("../../../../src/helpers/meetingClockSync.ts") = require("../../../../src/helpers/meetingClockSync.ts");

type ClockProbeReply = import("../../../../src/helpers/meetingClockSync.ts").MeetingClockProbeReply;

const reply = (
  nonce: string,
  sourceSendNs: bigint,
  sourceReceiveNs: bigint,
  offsetNs: bigint,
  helperGeneration = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
) => ({
  type: "probe" as const,
  nonce,
  helperReceiveNs: (sourceSendNs + offsetNs + 1_000n).toString(),
  helperSendNs: (sourceReceiveNs + offsetNs - 1_000n).toString(),
  helperGeneration,
  helperFrame: 0,
});

test("clock sync accepts bounded probes and estimates clock rate without wall-clock timestamps", () => {
  const sync = new MeetingClockSync();
  sync.reset("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const first = sync.createProbe("1000000000", "11111111-1111-4111-8111-111111111111");
  const firstReply = reply(first.nonce, 1_000_000_000n, 1_000_004_000n, 1_000_000n);
  const firstMapping = sync.accept(firstReply, "1000004000");
  assert.equal(firstMapping, null, "one probe cannot establish a rate");

  const second = sync.createProbe("2000000000", "22222222-2222-4222-8222-222222222222");

  const secondMapping = sync.accept(
    reply(second.nonce, 2_000_000_000n, 2_000_004_000n, 1_002_000n),
    "2000004000"
  );

  assert.ok(secondMapping);
  assert.ok(Math.abs(secondMapping.rate - 1.000002) < 1e-8);
  const mappedFrame = sync.frameAt("1500002000", "1001000000", 24_000, 0, "2000004000");
  assert.equal(mappedFrame, 12_000);
  const originalDateNow = Date.now;

  try {
    Date.now = () => 0;
    assert.equal(sync.frameAt("1500002000", "1001000000", 24_000, 0, "2000004000"), mappedFrame);
    Date.now = () => Number.MAX_SAFE_INTEGER;
    assert.equal(sync.frameAt("1500002000", "1001000000", 24_000, 0, "2000004000"), mappedFrame);
  } finally {
    Date.now = originalDateNow;
  }
});

test("clock sync rejects asymmetric bounds, stale generations, malformed times, and stale mappings", () => {
  const sync = new MeetingClockSync();
  sync.reset("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const bad = sync.createProbe("1000000000", "33333333-3333-4333-8333-333333333333");
  assert.equal(
    sync.accept(
      {
        ...reply(bad.nonce, 1_000_000_000n, 1_000_004_000n, 1_000_000n),
        helperReceiveNs: "999999999",
      },
      "1000004000"
    ),
    null
  );

  const oldGeneration = sync.createProbe("2000000000", "44444444-4444-4444-8444-444444444444");
  sync.reset("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  assert.equal(
    sync.accept(
      reply(oldGeneration.nonce, 2_000_000_000n, 2_000_004_000n, 1_000_000n),
      "2000004000"
    ),
    null
  );

  const current = sync.createProbe("3000000000", "55555555-5555-4555-8555-555555555555");

  const accepted = sync.accept(
    reply(
      current.nonce,
      3_000_000_000n,
      3_000_004_000n,
      1_000_000n,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    ),
    "3000004000"
  );

  assert.equal(accepted, null);
  const next = sync.createProbe("3300000000");
  assert.ok(
    sync.accept(
      reply(
        next.nonce,
        3_300_000_000n,
        3_300_004_000n,
        1_000_000n,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
      ),
      "3300004000"
    )
  );
  assert.equal(sync.mappingAt("3300000000", "9000000000"), null);
  assert.ok(
    sync.mappingAt("3305000000", "3305000000"),
    "bounded continuation supports the next live chunk"
  );
  assert.equal(
    sync.mappingAt("9300000000", "3300004000"),
    null,
    "query continuation is bounded independently of model freshness"
  );
  assert.equal(sync.mappingAt("not-nanoseconds", "3000004000"), null);
});

test("inconsistent probes do not renew freshness or enlarge a feasible model", () => {
  const sync = new MeetingClockSync();
  sync.reset("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

  for (const time of [1_000_000_000n, 2_000_000_000n]) {
    const probe = sync.createProbe(time.toString());
    sync.accept(reply(probe.nonce, time, time + 4_000n, 1_000_000n), (time + 4_000n).toString());
  }

  const baseline = sync.mappingAt("2000004000", "2000004000");
  assert.ok(baseline);
  const invalid = sync.createProbe("3000000000");
  assert.equal(
    sync.accept(reply(invalid.nonce, 3_000_000_000n, 3_000_004_000n, 10_000_000n), "3000004000"),
    null
  );
  assert.deepEqual(sync.mappingAt("2000004000", "2000004000"), baseline);
  assert.equal(
    sync.mappingAt("7000005000", "7000005000"),
    null,
    "rejected probe does not extend TTL"
  );
  const continuation = sync.mappingAt("6000000000", "6000000000");
  assert.ok(continuation);
  assert.ok(
    continuation.uncertaintyNs > baseline.uncertaintyNs,
    "continuation uncertainty includes rate bounds"
  );
});

test("clock sync bounds pending nonces and never accepts an unrequested reply", () => {
  const sync = new MeetingClockSync();
  sync.reset("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

  const probes = Array.from({ length: 9 }, (_, index) =>
    sync.createProbe(
      String(1_000_000_000 + index),
      `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
    )
  );

  assert.equal(
    sync.accept(reply(probes[0].nonce, 1_000_000_000n, 1_000_004_000n, 1_000_000n), "1000004000"),
    null
  );
  assert.equal(
    sync.accept(reply("missing", 1_000_000_000n, 1_000_004_000n, 1_000_000n), "1000004000"),
    null
  );
});

test("calibration enforces the exact minimum span and five-second continuation bound", () => {
  const sync = new MeetingClockSync();
  sync.reset("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

  const probeAt = (time: bigint) => {
    const probe = sync.createProbe(time.toString());

    return sync.accept(
      reply(probe.nonce, time, time + 4_000n, 1_000_000n),
      (time + 4_000n).toString()
    );
  };

  assert.equal(probeAt(1_000_000_000n), null);
  assert.equal(probeAt(1_249_000_000n), null);
  assert.ok(probeAt(1_250_000_000n));
  assert.ok(sync.mappingAt("6250004000", "6250004000"));
  assert.equal(sync.mappingAt("6250004001", "6250004001"), null);
  assert.equal(sync.mappingAt("6250004001", "1250004000"), null);
  // A sleep-sized discontinuity starts a new calibration, never extends the old fit.
  assert.equal(probeAt(10_000_000_000n), null);
  assert.equal(sync.mappingAt("10000004000", "10000004000"), null);
  assert.ok(probeAt(10_250_000_000n));
  assert.equal(sync.mappingAt("1250004000", "10250004000"), null);
});

// M0/M1 mutation survivor follow-ups (#382): accept-guard matrix, continuation extrapolation, sample window.
test("clock sync: every accept guard clause rejects on its own", () => {
  const reply = (
    nonce: string,
    sourceSendNs: bigint,
    sourceReceiveNs: bigint,
    offsetNs: bigint,
    helperGeneration = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    helperFrame = 0,
    type: string = "probe"
  ): ClockProbeReply => ({
    type: type as ClockProbeReply["type"],
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

  const replyAt = (send: bigint): ClockProbeReply => reply(makeProbe(send).nonce, send, send + 4_000_000n, 1_002_000n);
  const cases: [string, () => unknown][] = [
    ["unrequested nonce", () => sync.accept(reply("missing", 1_800_000_000n, 1_800_004_000n, 1_002_000n), "1804000000")],
    ["unknown reply type", () => sync.accept({ ...replyAt(1_800_000_000n), type: "other" as unknown as ClockProbeReply["type"] }, "1804000000")],
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

test("clock sync: a later overlapping sample never becomes the freshest anchor", () => {
  const sync = new MeetingClockSync();
  sync.reset("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

  const sendProbe = (t: bigint, index: number) => {
    const probe = sync.createProbe(t.toString(), `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`);

    return sync.accept(
      {
        type: "probe" as const,
        nonce: probe.nonce,
        helperReceiveNs: (t + 1_000_000n).toString(),
        helperSendNs: (t + 4_000_000n + 1_000_000n).toString(),
        helperGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        helperFrame: 0,
      },
      (t + 4_000_000n).toString()
    );
  };

  // Probe times 400 ms apart keep the model span satisfied.
  sendProbe(1_000_000_000n, 1);
  sendProbe(1_400_000_000n, 2);

  // An overlapping probe accepted last with an EARLIER source end cannot produce a fresh
  // mapping itself (its end predates the model's latest source end), but it is retained.
  assert.equal(sendProbe(1_250_000_000n, 3), null, "an earlier-ended sample cannot produce a fresh mapping itself");

  // The freshest anchor stays the 1.4 s sample even with the out-of-order sample stored:
  // the last-sample selection sorts by source end, not acceptance order.
  const continuation = sync.mappingAt("6000000000", "6000000000");
  assert.ok(continuation);
  assert.equal(continuation.sampleCount, 3, "the overlapping sample is retained in the window");
  assert.equal(continuation.sampledAtSourceNs, "1402000000");
  assert.equal(continuation.helperEstimateNs, "6001000000");
});

test("clock sync: frame mapping rejects invalid mappings, origins and rates before converting", () => {
  const sync = new MeetingClockSync();
  sync.reset("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

  const sendProbe = (t: bigint, index: number) => {
    const probe = sync.createProbe(t.toString(), `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`);

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

  sendProbe(1_000_000_000n, 1);
  assert.ok(sendProbe(1_400_000_000n, 2), "two probes establish the calibrated mapping");

  // No mapping: a request beyond the bounded continuation window returns null end to end.
  assert.equal(sync.frameAt("9000000000", "1001000000", 24_000, 0, "9000000000"), null);
  // Unparseable origin: the conversion cannot place the frame.
  assert.equal(sync.frameAt("1200000000", "not-nanoseconds", 24_000, 0, "1404000000"), null);
  // Fractional sample rate: not a safe integer.
  assert.equal(sync.frameAt("1200000000", "1001000000", 1.5, 0, "1404000000"), null);
  // Zero sample rate: non-positive.
  assert.equal(sync.frameAt("1200000000", "1001000000", 0, 0, "1404000000"), null);

  // The valid call still converts on the calibrated mapping.
  assert.ok(sync.frameAt("1200000000", "1001000000", 24_000, 0, "1404000000") !== null);
});
