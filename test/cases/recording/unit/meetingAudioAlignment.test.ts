import test from "node:test";
import assert from "node:assert/strict";
import {
  alignedAudioRanges,
  isUncalibratableEpochFragment,
} from "../../../../src/helpers/meetingAudioAlignment.ts";
import type { MeetingFrameAlignmentSegment, MeetingRecordingEpochDto } from "../../../../src/contracts/meetingRecording.ts";

// Class-level fixtures for recording:audio-alignment (#416, follow-up from the
// PR #410 ledger): each case drives one tracked survivor family - uncertainty
// bounds, freshness window edges, mixed generations, tie-break ordering,
// helperGeneration changes, mid-epoch gaps and rate != 1 rounding.

const HELPER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HELPER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function segment(overrides: Partial<MeetingFrameAlignmentSegment> = {}): MeetingFrameAlignmentSegment {
  return {
    sourceGeneration: 1,
    sourceStartFrame: 0,
    sourceEndFrame: 24_000,
    timelineStartFrame: 0,
    rate: 1,
    uncertaintyStartFrames: 2,
    uncertaintyEndFrames: 2,
    helperGeneration: HELPER_A,
    sourceStartNs: "1000000000",
    sourceEndNs: "1001000000",
    helperStartNs: "1000000000",
    helperEndNs: "1001000000",
    sampledSourceStartNs: "999000000",
    sampledSourceEndNs: "1000000000",
    freshnessSourceNs: "1000000000",
    ...overrides,
  };
}

function epoch(overrides: Partial<MeetingRecordingEpochDto> = {}): MeetingRecordingEpochDto {
  return {
    recordingId: "rec-1",
    source: "mic",
    epochIndex: 0,
    timelineStartFrame: null,
    sourceStartFrame: 0,
    sourceGeneration: 1,
    alignmentSegments: [],
    alignmentErrorCode: null,
    sampleRate: 24_000,
    channels: 1,
    encoding: "opus",
    state: "finalized",
    frameCount: 24_000,
    ignoredTrailingBytes: 0,
    errorCode: null,
    ...overrides,
  };
}

test("fragment gate: fragments at the 6000-frame calibration bound and below are uncalibratable", () => {
  const below = epoch({ frameCount: 5_999 });
  assert.equal(isUncalibratableEpochFragment(below), true);
  assert.deepEqual(alignedAudioRanges(below), []);

  const atBound = epoch({ frameCount: 6_000 });
  assert.equal(isUncalibratableEpochFragment(atBound), false);

  const zero = epoch({ frameCount: 0 });
  assert.equal(isUncalibratableEpochFragment(zero), false);

  const anchored = epoch({ frameCount: 100, timelineStartFrame: 5_000 });
  assert.equal(isUncalibratableEpochFragment(anchored), false);

  const withSegments = epoch({ frameCount: 100, alignmentSegments: [segment()] });
  assert.equal(isUncalibratableEpochFragment(withSegments), false);
});

test("freshness window edges: equality passes, ±5 s boundaries diverge, one ns past rejects", () => {
  // freshness == sampledSourceEndNs passes (>= edge).
  const equal = epoch({ alignmentSegments: [segment()] });
  assert.equal(alignedAudioRanges(equal).length, 1);

  // Exact +5 s boundary (freshness = sampledSourceEndNs + 5_000_000_000):
  // the >= freshness link passes at equality - real and <= mutant agree here.
  const atFiveSeconds = epoch({
    alignmentSegments: [
      segment({ freshnessSourceNs: "6000000000" }),
    ],
  });
  assert.equal(alignedAudioRanges(atFiveSeconds).length, 1);

  // One ns past the age window (freshness > sampledEnd + 5 s) breaks the
  // freshness-age link.
  const stale = epoch({
    alignmentSegments: [
      segment({ freshnessSourceNs: "6000000001" }),
    ],
  });
  assert.throws(() => alignedAudioRanges(stale), /audio-alignment-unavailable/);

  // freshness BELOW sampledSourceEndNs breaks the freshness link in isolation
  // (real rejects; the stale fixture above keeps its D-reference valid).
  const belowWindow = epoch({
    alignmentSegments: [
      segment({ freshnessSourceNs: "999999999" }),
    ],
  });
  assert.throws(() => alignedAudioRanges(belowWindow), /audio-alignment-unavailable/);

  // sourceStartNs below sampledSourceStartNs - 5 s breaks the start-window link.
  const earlyStart = epoch({
    alignmentSegments: [
      segment({ sourceStartNs: "999999999", sampledSourceStartNs: "6000000000" }),
    ],
  });
  assert.throws(() => alignedAudioRanges(earlyStart), /audio-alignment-unavailable/);

  // sourceEndNs above sampledSourceEndNs + 5 s breaks the end-window link.
  const lateEnd = epoch({
    alignmentSegments: [
      segment({ sourceEndNs: "6000000001" }),
    ],
  });
  assert.throws(() => alignedAudioRanges(lateEnd), /audio-alignment-unavailable/);
});

test("uncertainty boundary: 600 passes per link, 601 on either side rejects the segment", () => {
  const atCap = epoch({
    alignmentSegments: [
      segment({ uncertaintyStartFrames: 600, uncertaintyEndFrames: 600 }),
    ],
  });
  assert.equal(alignedAudioRanges(atCap).length, 1);

  const startPast = epoch({
    alignmentSegments: [
      segment({ uncertaintyStartFrames: 601 }),
    ],
  });
  assert.throws(() => alignedAudioRanges(startPast), /audio-alignment-unavailable/);

  const endPast = epoch({
    alignmentSegments: [
      segment({ uncertaintyEndFrames: 601 }),
    ],
  });
  assert.throws(() => alignedAudioRanges(endPast), /audio-alignment-unavailable/);
});

test("mixed sourceGeneration: segments from another generation are ignored for coverage", () => {
  const foreign = epoch({
    alignmentSegments: [
      segment({ sourceGeneration: 2 }),
    ],
  });
  assert.throws(() => alignedAudioRanges(foreign), /audio-alignment-unavailable/);

  const both = epoch({
    alignmentSegments: [
      segment({ sourceGeneration: 2 }),
      segment(),
    ],
  });
  const ranges = alignedAudioRanges(both);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].provenance.kind, "calibrated");
});

test("equal-endpoint tie-break keeps input order; earlier endpoints sort first", () => {
  // Two segments with identical sourceStartFrame/sourceEndFrame but different
  // helper generations: the tie must resolve to input order (order 0 wins).
  const tied = epoch({
    frameCount: 12_000,
    alignmentSegments: [
      segment({ helperGeneration: HELPER_B, sourceEndFrame: 12_000 }),
      segment({ sourceEndFrame: 12_000 }),
    ],
  });
  const ranges = alignedAudioRanges(tied);
  assert.equal(ranges.length, 1);
  if (ranges[0].provenance.kind === "calibrated") {
    assert.equal(ranges[0].provenance.helperGeneration, HELPER_B);
    assert.equal(ranges[0].provenance.segmentIndex, 0);
  }

  // Reversed input order with distinct endpoints must still cover in start order.
  const reversed = epoch({
    frameCount: 48_000,
    alignmentSegments: [
      segment({ sourceStartFrame: 24_000, sourceEndFrame: 48_000, sourceEndNs: "1002000000" }),
      segment(),
    ],
  });
  const ordered = alignedAudioRanges(reversed);
  assert.equal(ordered.length, 2);
  assert.deepEqual(ordered.map((range) => range.fileStartFrame), [0, 24_000]);
});

test("helperGeneration change across the epoch excludes segments from another helper generation", () => {
  const mixed = epoch({
    frameCount: 48_000,
    alignmentSegments: [
      segment(),
      segment({
        sourceStartFrame: 24_000,
        sourceEndFrame: 48_000,
        sourceEndNs: "1002000000",
        helperGeneration: HELPER_B,
      }),
    ],
  });
  assert.throws(() => alignedAudioRanges(mixed), /audio-alignment-unavailable/);

  const consistent = epoch({
    frameCount: 48_000,
    alignmentSegments: [
      segment(),
      segment({
        sourceStartFrame: 24_000,
        sourceEndFrame: 48_000,
        sourceEndNs: "1002000000",
        helperStartNs: "1001000000",
      }),
    ],
  });
  assert.equal(alignedAudioRanges(consistent).length, 2);
});

test("mid-epoch coverage gap throws audio-alignment-unavailable", () => {
  const gapped = epoch({
    frameCount: 48_000,
    alignmentSegments: [
      segment({ sourceStartFrame: 0, sourceEndFrame: 12_000 }),
      segment({ sourceStartFrame: 36_000, sourceEndFrame: 48_000 }),
    ],
  });
  assert.throws(() => alignedAudioRanges(gapped), /audio-alignment-unavailable/);
});

test("rate != 1 rounds the timeline offset per segment", () => {
  const offset = epoch({
    alignmentSegments: [
      segment({ timelineStartFrame: 1_000, rate: 1.001, uncertaintyStartFrames: 600, uncertaintyEndFrames: 600 }),
    ],
  });
  const ranges = alignedAudioRanges(offset);
  assert.equal(ranges.length, 1);
  // cursor 0, sourceStartFrame 0 -> timeline = 1000 + round(0 * 1.001) = 1000.
  assert.equal(ranges[0].timelineStartFrame, 1_000);

  const shifted = epoch({
    alignmentSegments: [
      segment({ timelineStartFrame: 1_000, rate: 1.001, uncertaintyStartFrames: 600, uncertaintyEndFrames: 600 }),
      segment({
        sourceStartFrame: 20_000,
        sourceEndFrame: 24_480,
        sourceEndNs: "1002000000",
        timelineStartFrame: 1_000,
        rate: 1.001,
        uncertaintyStartFrames: 600,
        uncertaintyEndFrames: 600,
        helperStartNs: "1001000000",
      }),
    ],
    frameCount: 24_480,
  });
  const shiftedRanges = alignedAudioRanges(shifted);
  assert.equal(shiftedRanges.length, 2);
  // Second piece: cursor enters at 24000 (segment start 20000) -> timeline =
  // 1000 + round((24000 - 20000) * 1.001) = 1000 + 4004 = 5004.
  assert.equal(shiftedRanges[1].timelineStartFrame, 5_004);
  assert.equal(shiftedRanges[1].fileStartFrame, 24_000);
  if (shiftedRanges[1].provenance.kind === "calibrated") {
    assert.equal(shiftedRanges[1].provenance.uncertaintyFrames, 601);
  }
});
