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
  assert.equal(firstMapping?.offsetNs, 1_000_000);
  assert.equal(firstMapping?.uncertaintyNs, 1_000);

  const second = sync.createProbe("2000000000", "22222222-2222-4222-8222-222222222222");
  const secondMapping = sync.accept(reply(second.nonce, 2_000_000_000n, 2_000_004_000n, 1_002_000n), "2000004000");
  assert.equal(secondMapping?.rate, 1.000002);
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
  assert.ok(accepted);
  assert.equal(sync.mappingAt("3000000000", "9000000000"), null);
  assert.equal(sync.mappingAt("3005000000", "3005000000"), null, "mapping cannot extrapolate past the last native clock anchor");
  assert.equal(sync.mappingAt("not-nanoseconds", "3000004000"), null);
});

test("clock mapping uncertainty includes fitted-rate residuals", () => {
  const sync = new MeetingClockSync();
  sync.reset("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const probes = [
    ["66666666-6666-4666-8666-666666666666", 1_000_000_000n, 1_000_000n],
    ["77777777-7777-4777-8777-777777777777", 2_000_000_000n, 1_002_000n],
    ["88888888-8888-4888-8888-888888888888", 3_000_000_000n, 1_010_000n],
  ] as const;
  let mapping: ReturnType<typeof sync.accept> = null;
  for (const [nonce, sourceSendNs, offsetNs] of probes) {
    const pending = sync.createProbe(sourceSendNs.toString(), nonce);
    mapping = sync.accept(reply(pending.nonce, sourceSendNs, sourceSendNs + 4_000n, offsetNs), (sourceSendNs + 4_000n).toString());
    assert.ok(mapping);
  }
  assert.ok(mapping);
  assert.ok(mapping.uncertaintyNs >= 4_000, "sample RTT uncertainty is enlarged by the observed rate-fit residual");
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
