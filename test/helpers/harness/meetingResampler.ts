import type { MeetingRecordingEpochDto, MeetingFrameAlignmentSegment } from "../../../src/contracts/meetingRecording.js";
export function calibratedEpoch(spec: Array<{ frames: number; start: number; rate?: number; uncertainty?: number; endUncertainty?: number }>, epochIndex = 0, generation = 1): MeetingRecordingEpochDto {
  let cursor = 0;
  const ns = (frame: number) => String(1_000_000_000n + BigInt(frame) * 1_000_000_000n / 24_000n);
  const alignmentSegments: MeetingFrameAlignmentSegment[] = spec.map(value => {
    const start = cursor; cursor += value.frames;
    return {
      sourceGeneration: generation, sourceStartFrame: start, sourceEndFrame: cursor, timelineStartFrame: value.start,
      rate: value.rate ?? 1, uncertaintyStartFrames: value.uncertainty ?? 60, uncertaintyEndFrames: value.endUncertainty ?? value.uncertainty ?? 60,
      helperGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceStartNs: ns(start), sourceEndNs: ns(cursor),
      helperStartNs: ns(start), helperEndNs: ns(cursor), sampledSourceStartNs: ns(start), sampledSourceEndNs: ns(cursor), freshnessSourceNs: ns(cursor),
    };
  });
  return {
    recordingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", source: "mic", epochIndex, sourceGeneration: generation,
    sourceStartFrame: 0, timelineStartFrame: null, alignmentSegments, alignmentErrorCode: null, sampleRate: 24000,
    channels: 1, encoding: "opus", state: "finalized", frameCount: cursor, ignoredTrailingBytes: 0, errorCode: null,
  };
}
