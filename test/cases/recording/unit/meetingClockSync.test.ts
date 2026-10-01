const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { MeetingClockSync }: typeof import("../../../../src/helpers/meetingClockSync.ts") = require("../../../../src/helpers/meetingClockSync.ts");

const reply = (nonce: string, sourceSendNs: bigint, sourceReceiveNs: bigint, offsetNs: bigint, helperGeneration = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") => ({
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
  const secondMapping = sync.accept(reply(second.nonce, 2_000_000_000n, 2_000_004_000n, 1_002_000n), "2000004000");
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
  assert.equal(sync.accept({ ...reply(bad.nonce, 1_000_000_000n, 1_000_004_000n, 1_000_000n), helperReceiveNs: "999999999" }, "1000004000"), null);

  const oldGeneration = sync.createProbe("2000000000", "44444444-4444-4444-8444-444444444444");
  sync.reset("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  assert.equal(sync.accept(reply(oldGeneration.nonce, 2_000_000_000n, 2_000_004_000n, 1_000_000n), "2000004000"), null);

  const current = sync.createProbe("3000000000", "55555555-5555-4555-8555-555555555555");
  const accepted = sync.accept(reply(current.nonce, 3_000_000_000n, 3_000_004_000n, 1_000_000n, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), "3000004000");
  assert.equal(accepted, null);
  const next = sync.createProbe("3300000000");
  assert.ok(sync.accept(reply(next.nonce, 3_300_000_000n, 3_300_004_000n, 1_000_000n, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), "3300004000"));
  assert.equal(sync.mappingAt("3300000000", "9000000000"), null);
  assert.ok(sync.mappingAt("3305000000", "3305000000"), "bounded continuation supports the next live chunk");
  assert.equal(sync.mappingAt("9300000000", "3300004000"), null, "query continuation is bounded independently of model freshness");
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
  assert.equal(sync.accept(reply(invalid.nonce, 3_000_000_000n, 3_000_004_000n, 10_000_000n), "3000004000"), null);
  assert.deepEqual(sync.mappingAt("2000004000", "2000004000"), baseline);
  assert.equal(sync.mappingAt("7000005000", "7000005000"), null, "rejected probe does not extend TTL");
  const continuation = sync.mappingAt("6000000000", "6000000000");
  assert.ok(continuation);
  assert.ok(continuation.uncertaintyNs > baseline.uncertaintyNs, "continuation uncertainty includes rate bounds");
});

test("clock sync bounds pending nonces and never accepts an unrequested reply", () => {
  const sync = new MeetingClockSync();
  sync.reset("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const probes = Array.from({ length: 9 }, (_, index) => sync.createProbe(
    String(1_000_000_000 + index),
    `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
  ));
  assert.equal(sync.accept(reply(probes[0].nonce, 1_000_000_000n, 1_000_004_000n, 1_000_000n), "1000004000"), null);
  assert.equal(sync.accept(reply("missing", 1_000_000_000n, 1_000_004_000n, 1_000_000n), "1000004000"), null);
});

test("calibration enforces the exact minimum span and five-second continuation bound", () => {
  const sync = new MeetingClockSync();
  sync.reset("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const probeAt = (time: bigint) => {
    const probe = sync.createProbe(time.toString());
    return sync.accept(reply(probe.nonce, time, time + 4_000n, 1_000_000n), (time + 4_000n).toString());
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
