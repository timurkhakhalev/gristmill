import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { MeetingPlatformObservation, MeetingPlatformCoverage } from "../../../../src/contracts/meetingRecording.js";
const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { EventEmitter }: typeof import("node:events") = require("node:events");
const { PassThrough }: typeof import("node:stream") = require("node:stream");
const { randomUUID }: typeof import("node:crypto") = require("node:crypto");
const { installElectronStub }: typeof import("../../../helpers/harness/electronStub.ts") = require("../../../helpers/harness/electronStub.ts");
installElectronStub();
const { ZoomSpeakerCollector }: typeof import("../../../../src/helpers/zoomSpeakerCollector.ts") = require("../../../../src/helpers/zoomSpeakerCollector.ts");

// The macOS gate and bundled-helper resolver are real; the process and AX JSONL
// are synthetic. This does not read Zoom or invoke a native helper.
function fakeChild() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), signals: [] as string[] });
  const kill = (signal?: Parameters<ChildProcessWithoutNullStreams["kill"]>[0]) => {
    child.signals.push(String(signal));
    setImmediate(() => child.emit("close", 0));
    return true;
  };
  // A deliberate process-boundary double. The collector uses only streams,
  // close/error events and kill, all owned and completed by this fixture.
  return Object.assign(child, { kill }) as typeof child & ChildProcessWithoutNullStreams;
}
function emit(child: ReturnType<typeof fakeChild>, message: unknown) {
  child.stdout.emit("data", Buffer.from(JSON.stringify(message) + "\n"));
}
function observation(recordingId: string, sessionId: string, instanceKey: string, nameRevision = 1): MeetingPlatformObservation {
  return { platform: "zoom", bindingId: sessionId, activeParticipantIds: [instanceKey], clockGeneration: null, clockUncertaintyNs: "0", id: randomUUID(), recordingId, sessionId, instanceKey, nameRevision, episodeId: randomUUID(), displayName: "Synthetic Name", windowMode: "full", activity: "explicit", readStartHostNs: "100", readEndHostNs: "200", self: "unknown", singleSpeaker: null, provenance: "system-wide", reason: null };
}

test("recording-scoped collector flushes names/revisions/availability and rejects late retired-helper writes", { skip: process.platform !== "darwin" }, async (t) => {
  const id = randomUUID();
  const child = fakeChild();
  const saved: MeetingPlatformObservation[] = [];
  const coverages: MeetingPlatformCoverage[] = [];
  const collector = new ZoomSpeakerCollector(id, { saveMeetingPlatformObservation: (value) => saved.push(value), saveMeetingAudioClockAnchor() {}, setMeetingPlatformCoverage: (_id, coverage) => coverages.push({ ...coverage }) }, () => child);
  t.after(() => collector.stop());
  collector.start();
  const session = randomUUID();
  const first = observation(id, session, "instance-1");
  const renamed = { ...observation(id, session, "instance-1", 2), displayName: "Synthetic Rename" };
  const returning = observation(id, randomUUID(), "instance-2");
  for (const value of [first, renamed, returning]) emit(child, { type: "observation", observation: value });
  emit(child, { type: "coverage", reads: 20, samples: 3, state: "collecting", reason: "accessibility" });
  emit(child, { type: "coverage", reads: 40, samples: 3, state: "complete", reason: null });
  await collector.stop();
  assert.deepEqual(saved, [first, renamed, returning]);
  assert.equal(coverages.at(-1)?.state, "incomplete");
  assert.equal(coverages.at(-1)?.reason, "accessibility");
  assert.equal(coverages.at(-1)?.reads, 40);
  assert.equal(coverages.at(-1)?.samples, 3);
  emit(child, { type: "observation", observation: observation(id, session, "stale") });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(saved.length, 3);
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("permission/helper failure and cross-recording JSON stop only evidence, with no owned process left", { skip: process.platform !== "darwin" }, async (t) => {
  const child = fakeChild();
  const id = randomUUID();
  const saved: MeetingPlatformObservation[] = [];
  const coverage: MeetingPlatformCoverage[] = [];
  const collector = new ZoomSpeakerCollector(id, { saveMeetingPlatformObservation: (value) => saved.push(value), saveMeetingAudioClockAnchor() {}, setMeetingPlatformCoverage: (_id, value) => coverage.push({ ...value }) }, () => child);
  t.after(() => collector.stop());
  collector.start();
  emit(child, { type: "observation", observation: observation(randomUUID(), randomUUID(), "wrong-recording") });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await collector.stop();
  assert.deepEqual(saved, []);
  assert.equal(coverage.at(-1)?.reason, "ax-invalid-message");
  assert.equal(coverage.at(-1)?.state, "incomplete");
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("split Unicode JSONL preserves display names and an incomplete UTF8 tail rejects coverage", { skip: process.platform !== "darwin" }, async (t) => {
  const id = randomUUID();
  const child = fakeChild();
  const saved: MeetingPlatformObservation[] = [];
  const coverage: MeetingPlatformCoverage[] = [];
  const collector = new ZoomSpeakerCollector(id, { saveMeetingPlatformObservation: (value) => saved.push(value), saveMeetingAudioClockAnchor() {}, setMeetingPlatformCoverage: (_id, value) => coverage.push({ ...value }) }, () => child);
  t.after(() => collector.stop());
  collector.start();
  const value = { ...observation(id, randomUUID(), "unicode"), displayName: "Анна, 李 🦊" };
  const bytes = Buffer.from(JSON.stringify({ type: "observation", observation: value }) + "\n");
  // Every multibyte name character straddles at least one stream boundary.
  for (const byte of bytes) child.stdout.emit("data", Buffer.from([byte]));
  child.stdout.emit("data", Buffer.from([0xe2, 0x82]));
  await collector.stop();
  assert.equal(saved[0].displayName, value.displayName);
  assert.equal(coverage.at(-1)?.reason, "metadata-tail-incomplete");
});

test("failed helper ignoring SIGTERM is killed within the owned cleanup deadline before recording Stop", { skip: process.platform !== "darwin" }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = fakeChild();
  child.kill = (signal) => {
    child.signals.push(String(signal));
    if (signal === "SIGKILL") child.emit("close", 0);
    return true;
  };
  const id = randomUUID();
  const coverage: MeetingPlatformCoverage[] = [];
  const collector = new ZoomSpeakerCollector(id, { saveMeetingPlatformObservation() {}, saveMeetingAudioClockAnchor() {}, setMeetingPlatformCoverage: (_id, value) => coverage.push({ ...value }) }, () => child);
  t.after(() => collector.stop());
  collector.start();
  collector.invalidate("ax-helper-timeout");
  assert.deepEqual(child.signals, ["SIGTERM"]);
  t.mock.timers.tick(500);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(coverage.at(-1)?.reason, "ax-helper-timeout");
  await collector.stop();
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("collector retains native interval confirmations after an AX gap for production matching", { skip: process.platform !== "darwin" }, async (t) => {
  const { zoomSpeakerFixture }: typeof import("../../../lib/zoomSpeakerFixture.ts") = require("../../../lib/zoomSpeakerFixture.ts");
  const { matchMeetingPlatformSpeakers }: typeof import("../../../../src/helpers/meetingPlatformMatcher.ts") = require("../../../../src/helpers/meetingPlatformMatcher.ts");
  const id = randomUUID();
  const child = fakeChild();
  const saved: MeetingPlatformObservation[] = [];
  const coverage: MeetingPlatformCoverage[] = [];
  const collector = new ZoomSpeakerCollector(id, { saveMeetingPlatformObservation: (value) => saved.push(value), saveMeetingAudioClockAnchor() {}, setMeetingPlatformCoverage: (_id, value) => coverage.push({ ...value }) }, () => child);
  t.after(() => collector.stop());
  collector.start();
  emit(child, { type: "observation", observation: { ...observation(id, randomUUID(), "unavailable"), activity: "unavailable", displayName: "", reason: "ax-incomplete", readStartHostNs: "0", readEndHostNs: "500000000" } });
  emit(child, { type: "coverage", reads: 1, samples: 1, state: "collecting", reason: "ax-incomplete" });
  const fixture = zoomSpeakerFixture(id);
  fixture.observations.forEach((value) => emit(child, { type: "observation", observation: value }));
  emit(child, { type: "coverage", reads: 28, samples: 16, state: "complete", reason: null });
  await collector.stop();
  assert.equal(saved.length, 16);
  assert.equal(coverage.at(-1)?.state, "incomplete");
  const decisions = matchMeetingPlatformSpeakers({ ...fixture, observations: saved, epochs: [{  recordingId: id, source: "system", epochIndex: 0, timelineStartFrame: 0, frameCount: 14 * 24_000, state: "finalized" }], partOffsets: [{ recordingId: id, startFrame: 0, frameCount: 14 * 24_000 }] });
  assert.equal(decisions.filter((d) => d.status === "accepted").length, 3);
  assert.equal(decisions[0].reason, "ax-incomplete");
});

test("AX failure cannot discard native audio clock anchors required by Meet", async () => {
  const anchors: import("../../../../src/contracts/meetingRecording.js").MeetingAudioClockAnchor[] = [];
  const collector = new ZoomSpeakerCollector(randomUUID(), { saveMeetingPlatformObservation() {}, saveMeetingAudioClockAnchor: (anchor) => anchors.push(anchor), setMeetingPlatformCoverage() {} });
  collector.invalidate("accessibility-denied");
  const generation = randomUUID();
  collector.bindClock(generation, 0, 0);
  collector.recordDeliveredFrames(generation, 24_000);
  collector.recordClock({ type: "clock", generation, startFrame: 0, endFrame: 24_000, hostStartNs: "1000000000", hostEndNs: "2000000000", timebaseNumer: 1, timebaseDenom: 1, conversion: "uncalibrated", reason: null });
  await collector.stop();
  assert.equal(anchors.length, 1);
});
