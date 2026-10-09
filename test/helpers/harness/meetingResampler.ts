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

/** Independent fixed-rate oracle over explicit signal reflection, using the bundled decoder's mature-buffer path. */
export function reflectedRateConversionOracle(raw: Float32Array): Float32Array {
  const { spawnSync }: typeof import("node:child_process") = require("node:child_process");
  const assert: typeof import("node:assert/strict") = require("node:assert/strict");
  const ffmpeg: string = require("ffmpeg-static");
  assert.ok(raw.length > 0 && raw.length % 2 === 0);
  const padded = new Float32Array(raw.length + 256);
  for (let i = 0; i < padded.length; i++) {
    const coordinate = Math.abs(i - 128), periodIndex = coordinate % (raw.length * 2);
    const original = periodIndex < raw.length ? periodIndex : raw.length * 2 - 1 - periodIndex;
    padded[i] = raw[original];
  }
  const filtered = spawnSync(ffmpeg, ["-v", "error", "-f", "f32le", "-ar", "48000", "-ac", "1", "-i", "pipe:0", "-ar", "24000", "-f", "f32le", "pipe:1"], { input: Buffer.from(padded.buffer) });
  assert.equal(filtered.status, 0, filtered.stderr.toString());
  assert.equal(filtered.stdout.length, (raw.length / 2 + 128) * 4);
  const output = new Float32Array(filtered.stdout.buffer.slice(filtered.stdout.byteOffset, filtered.stdout.byteOffset + filtered.stdout.byteLength));
  return output.slice(64, 64 + raw.length / 2);
}
