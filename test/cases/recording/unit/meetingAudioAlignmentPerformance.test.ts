import test from "node:test";
import assert from "node:assert/strict";
import { alignedAudioRanges } from "../../../../src/helpers/meetingAudioAlignment.ts";
import type { MeetingRecordingEpochDto, MeetingFrameAlignmentSegment } from "../../../../src/contracts/meetingRecording.js";

function segment(start: number, end: number): MeetingFrameAlignmentSegment {
  const ns = (frame: number) => String(1e9 + Math.round(frame / 24000 * 1e9));
  return {
    sourceGeneration: 1, sourceStartFrame: start, sourceEndFrame: end, timelineStartFrame: start,
    rate: 1, uncertaintyStartFrames: 2, uncertaintyEndFrames: 2,
    helperGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sourceStartNs: ns(start), sourceEndNs: ns(end), helperStartNs: ns(start), helperEndNs: ns(end),
    sampledSourceStartNs: ns(start), sampledSourceEndNs: ns(end), freshnessSourceNs: ns(end),
  };
}

function epoch(segments: MeetingFrameAlignmentSegment[], frames: number): MeetingRecordingEpochDto {
  return {
    recordingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", source: "mic", epochIndex: 0,
    timelineStartFrame: null, sourceStartFrame: 0, sourceGeneration: 1,
    alignmentSegments: segments, alignmentErrorCode: null, sampleRate: 24000, channels: 1,
    encoding: "opus", state: "finalized", frameCount: frames, ignoredTrailingBytes: 0, errorCode: null,
  };
}

test("two-hour alignment coverage uses every frame without a quadratic scan", () => {
  const packets = 72000;
  const input = epoch(Array.from({ length: packets }, (_, i) => segment(Math.max(0, i * 2400 - 96000), (i + 1) * 2400)), packets * 2400);
  const start = performance.now();
  const ranges = alignedAudioRanges(input);
  const ms = performance.now() - start;
  console.log("ALIGNMENT_PERFORMANCE", JSON.stringify({ segments: packets, ms, ranges: ranges.length }));
  assert.equal(ranges.reduce((sum, range) => sum + range.frameCount, 0), packets * 2400);
  assert.equal(ranges[0].fileStartFrame, 0);
  for (let i = 1; i < ranges.length; i++)
    assert.equal(ranges[i].fileStartFrame, ranges[i - 1].fileStartFrame + ranges[i - 1].frameCount);
  assert.ok(ms < 500, `two-hour alignment selection took ${ms.toFixed(1)}ms`);
});

test("alignment chooses the furthest overlap, preserves input-order ties, and rejects gaps or generation changes", () => {
  const a = segment(0, 2400);
  const b = { ...segment(0, 4800), timelineStartFrame: 10 };
  const tie = { ...segment(0, 4800), timelineStartFrame: 20 };
  const c = segment(2400, 7200);
  assert.deepEqual(alignedAudioRanges(epoch([b, a, tie, c], 7200)), [
    { fileStartFrame: 0, frameCount: 4800, timelineStartFrame: 10, rate: 1 },
    { fileStartFrame: 4800, frameCount: 2400, timelineStartFrame: 4800, rate: 1 },
  ]);
  assert.throws(() => alignedAudioRanges(epoch([a, segment(2401, 4800)], 4800)), { code: "audio-alignment-unavailable" });
  assert.throws(() => alignedAudioRanges(epoch([a, { ...segment(2400, 4800), helperGeneration: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }], 4800)), { code: "audio-alignment-unavailable" });
  assert.throws(() => alignedAudioRanges(epoch([{ ...a, uncertaintyEndFrames: 601 }], 2400)), { code: "audio-alignment-unavailable" });
});
