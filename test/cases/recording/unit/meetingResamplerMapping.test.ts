import test from "node:test";
import assert from "node:assert/strict";
import { alignedAudioRanges } from "../../../../src/helpers/meetingAudioAlignment.ts";
import { meetingResamplerManifest, meetingResamplerMappingText, meetingResamplerDecisionSummary } from "../../../../src/helpers/meetingResamplerMapping.ts";
import { calibratedEpoch } from "../../../helpers/harness/meetingResampler.ts";
const prepare = (epoch: ReturnType<typeof calibratedEpoch>, extent = 1_000_000) => meetingResamplerManifest("mic", [epoch], () => "private.f32", extent);
for (const jitter of [-50, -1, 1, 50]) test(`fixed anchor reconciles ${jitter} frames within confidence and rate`, () => {
  const manifest = prepare(calibratedEpoch([{ frames: 96000, start: 0 }, { frames: 96000, start: 96000 + jitter }]));
  assert.equal(manifest.epochs[0].rows[0].timelineEnd, 96000 + jitter);
  assert.equal(manifest.epochs[0].rows[1].reset, false);
  assert.deepEqual(manifest.decisions, [{ epochPosition: 0, rangeIndex: 1, precedingEnd: 96000, anchor: 96000 + jitter, correction: Math.abs(jitter), reason: "accepted" }]);
});
test("confidence does not authorize an excessive effective rate on short ranges", () => {
  const manifest = prepare(calibratedEpoch([{ frames: 96000, start: 0, uncertainty: 600 }, { frames: 96000, start: 96500, uncertainty: 600 }]));
  assert.equal(manifest.epochs[0].rows[0].timelineEnd, 96000);
  assert.equal(manifest.epochs[0].rows[1].reset, true);
  assert.equal(manifest.decisions[0].reason, "effective-rate");
});
test("overlapping intervals cannot move the fixed next anchor outside previous confidence", () => {
  const manifest = prepare(calibratedEpoch([{ frames: 96000, start: 0, uncertainty: 10 }, { frames: 96000, start: 96020, uncertainty: 60 }]));
  assert.equal(manifest.decisions[0].reason, "uncertainty");
  assert.equal(manifest.epochs[0].rows[0].timelineEnd, 96000);
});
for (const rate of [0.999, 1.001]) test(`inclusive effective-rate edge ${rate}`, () => {
  const anchor = Math.round(96000 * rate);
  const manifest = prepare(calibratedEpoch([{ frames: 96000, start: 0, uncertainty: 100 }, { frames: 96000, start: anchor }]));
  assert.equal(manifest.decisions[0].reason, "accepted");
  assert.equal(manifest.epochs[0].rows[0].timelineEnd, anchor);
  const rejected = prepare(calibratedEpoch([{ frames: 96000, start: 0, uncertainty: 100 }, { frames: 96000, start: anchor + (rate < 1 ? -1 : 1) }]));
  assert.equal(rejected.decisions[0].reason, "effective-rate");
});
test("successive corrections use the current preceding start and keep exact anchors", () => {
  const manifest = prepare(calibratedEpoch([{ frames: 96000, start: 0 }, { frames: 96000, start: 96050 }, { frames: 96000, start: 192000 }]));
  assert.deepEqual(manifest.epochs[0].rows.map(row => row.timelineEnd), [96050, 192000, 288000]);
  assert.deepEqual(manifest.decisions.map(value => value.reason), ["accepted", "accepted"]);
});
test("clipped asymmetric calibration retains stable original index and conservative endpoint bound", () => {
  const epoch = calibratedEpoch([{ frames: 96000, start: 0, uncertainty: 2, endUncertainty: 100 }]);
  epoch.sourceStartFrame = 12000; epoch.frameCount = 48000;
  const invalid = { ...epoch.alignmentSegments[0], uncertaintyEndFrames: 601 };
  epoch.alignmentSegments.unshift(invalid);
  const range = alignedAudioRanges(epoch)[0];
  assert.equal(range.frameCount, 48000);
  assert.deepEqual(range.provenance, { kind: "calibrated", segmentIndex: 1, sourceGeneration: 1, helperGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceStartFrame: 0, sourceEndFrame: 96000, uncertaintyFrames: 101 });
  assert.equal(range.timelineStartFrame, 12000);
});
test("historical anchors have no invented confidence and epochs reset even without a gap", () => {
  const first = calibratedEpoch([{ frames: 2400, start: 0 }]);
  const second = calibratedEpoch([{ frames: 2400, start: 2400 }], 1, 2);
  second.sourceGeneration = null; second.timelineStartFrame = 2400;
  assert.deepEqual(alignedAudioRanges(second)[0].provenance, { kind: "historical-anchored" });
  const manifest = meetingResamplerManifest("mic", [first, second], () => "private.f32", 4800);
  assert.equal(manifest.boundaryResets, 1);
  assert.equal(manifest.epochs[1].rows[0].reset, true);
  assert.equal(meetingResamplerDecisionSummary(manifest).acceptedShare, null);
});
test("decision metrics prioritize uncertainty, retain corrections and exclude epoch resets", () => {
  const first = calibratedEpoch([{ frames: 96000, start: 0, uncertainty: 1 }, { frames: 96000, start: 96500 }, { frames: 96000, start: 192550 }]);
  const second = calibratedEpoch([{ frames: 96000, start: 400000 }], 1);
  const manifest = meetingResamplerManifest("mic", [first, second], () => "private.f32", 600000);
  assert.deepEqual(meetingResamplerDecisionSummary(manifest), { candidates: 2, accepted: 1, rejected: 1, uncertainty: 1, effectiveRate: 0, acceptedShare: 0.5, corrections: [500, 50], boundaryResets: 1 });
  assert.match(meetingResamplerMappingText(manifest.epochs[0].rows), /^0 96000 0 96000 1\n/);
});
test("mapper rejects invalid bounds/rates and preserves strict unknown alignment", () => {
  const epoch = calibratedEpoch([{ frames: 96000, start: 0 }]);
  assert.throws(() => prepare(epoch, 95999), /coverage/);
  assert.throws(() => prepare(epoch, Infinity), /coordinates/);
  epoch.alignmentSegments[0].rate = 1.002;
  assert.throws(() => prepare(epoch), /unsupported alignment/);
  epoch.alignmentSegments = [];
  assert.throws(() => prepare(epoch), { code: "audio-alignment-unavailable" });
});

test("unproven empty source fails; explicit intentional silence is manifest input", () => {
  assert.throws(() => meetingResamplerManifest("mic", [], () => "absent", 48000), /no proven input/);
  const manifest = meetingResamplerManifest("mic", [], () => "absent", 48000, true);
  assert.equal(manifest.intentionalSilence, true); assert.deepEqual(manifest.epochs, []);
});
