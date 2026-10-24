const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const {
  composeMeetingAudioParts,
  meetingTimelineFrameCount,
}: typeof import("../../../../src/helpers/meetingAudioParts.ts") = require("../../../../src/helpers/meetingAudioParts.ts");

type MeetingEpoch = Parameters<typeof meetingTimelineFrameCount>[1][number];
type MeetingPart = Parameters<typeof composeMeetingAudioParts>[0][number];
type AlignmentSegment = MeetingEpoch["alignmentSegments"][number];

const segment = (timelineStartFrame: number, sourceEndFrame = 24_000): AlignmentSegment => ({
  sourceGeneration: 1,
  sourceStartFrame: 0,
  sourceEndFrame,
  timelineStartFrame,
  rate: 1,
  uncertaintyStartFrames: 0,
  uncertaintyEndFrames: 0,
  helperGeneration: "helper",
  sourceStartNs: "0",
  sourceEndNs: String(sourceEndFrame),
  helperStartNs: "0",
  helperEndNs: String(sourceEndFrame),
  sampledSourceStartNs: "0",
  sampledSourceEndNs: String(sourceEndFrame),
  freshnessSourceNs: String(sourceEndFrame),
});

const epoch = (overrides: Partial<MeetingEpoch> = {}): MeetingEpoch => ({
  recordingId: "part-a",
  source: "mic",
  epochIndex: 0,
  timelineStartFrame: 0,
  sourceStartFrame: 0,
  sourceGeneration: null,
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
});

const part = (overrides: Partial<MeetingPart> = {}): MeetingPart => {
  const startedAt = overrides.startedAt ?? "2026-10-19T10:00:00.000Z";

  return {
    id: "part-a",
    groupId: "group",
    noteId: 1,
    captureState: "ready",
    startedAt,
    endedAt: new Date(Date.parse(startedAt) + 2_000).toISOString(),
    sourceMetadata: {},
    config: null,
    configError: null,
    captureErrorCode: null,
    audioState: "available",
    audioErrorCode: null,
    currentRunId: null,
    createdAt: "2026-10-19T10:00:00.000Z",
    updatedAt: "2026-10-19T10:00:00.000Z",
    ...overrides,
  };
};

test("parts sort by start time, accumulate frame offsets and shift every entry", () => {
  const first = part({ id: "part-a", startedAt: "2026-10-19T10:00:00.000Z" });
  const second = part({ id: "part-b", startedAt: "2026-10-19T10:01:00.000Z" });
  const tracks: Record<string, MeetingEpoch[]> = {
    "part-a": [
      epoch({ recordingId: "part-a", frameCount: 24_000 }),
      epoch({ recordingId: "part-a", source: "system", timelineStartFrame: 30_000, frameCount: 18_000 }),
    ],
    "part-b": [
      epoch({
        recordingId: "part-b",
        frameCount: 48_000,
        alignmentSegments: [segment(500)],
      }),
    ],
  };

  const combined = composeMeetingAudioParts([second, first], (id) => tracks[id]);

  assert.deepEqual(combined.partOffsets, [
    { recordingId: "part-a", startFrame: 0, frameCount: 48_000 },
    { recordingId: "part-b", startFrame: 48_000, frameCount: 48_000 },
  ]);
  assert.deepEqual(
    combined.epochs.map(({ recordingId, timelineStartFrame }) => ({
      recordingId,
      timelineStartFrame,
    })),
    [
      { recordingId: "part-a", timelineStartFrame: 0 },
      { recordingId: "part-a", timelineStartFrame: 30_000 },
      { recordingId: "part-b", timelineStartFrame: 48_000 },
    ]
  );
  assert.equal(combined.epochs[2].alignmentSegments[0].timelineStartFrame, 48_500);
  assert.equal(combined.recording.startedAt, first.startedAt);
  // The combined extent is 96 000 frames, i.e. four seconds at 24 kHz.
  assert.equal(combined.recording.endedAt, "2026-10-19T10:00:04.000Z");
  assert.deepEqual(combined.recording.sourceMetadata.captureEndFrame, 96_000);
  assert.deepEqual(combined.recording.sourceMetadata.mic, { intentionallyEmpty: false });
});

test("equal start times fall back to the recording id", () => {
  const sameStart = "2026-10-19T10:00:00.000Z";
  const combined = composeMeetingAudioParts(
    [part({ id: "part-b", startedAt: sameStart }), part({ id: "part-a", startedAt: sameStart })],
    () => [epoch()]
  );

  assert.deepEqual(
    combined.partOffsets.map(({ recordingId }) => recordingId),
    ["part-a", "part-b"]
  );
});

test("an unproven timeline start stays null while its segments still shift", () => {
  const first = part({ id: "part-a" });
  const second = part({ id: "part-b", startedAt: "2026-10-19T10:01:00.000Z" });
  const tracks: Record<string, MeetingEpoch[]> = {
    "part-a": [epoch({ recordingId: "part-a", frameCount: 24_000 })],
    "part-b": [
      epoch({
        recordingId: "part-b",
        timelineStartFrame: null,
        sourceGeneration: 1,
        frameCount: 24_000,
        alignmentSegments: [segment(500)],
      }),
    ],
  };

  const combined = composeMeetingAudioParts([first, second], (id) => tracks[id]);

  assert.equal(combined.epochs[1].timelineStartFrame, null);
  // The first part's clock extent (48 000 frames) is the offset.
  assert.equal(combined.epochs[1].alignmentSegments[0].timelineStartFrame, 48_500);
});

test("an empty part list is rejected", () => {
  assert.throws(() => composeMeetingAudioParts([], () => []), {
    message: "Meeting has no audio parts",
  });
});

test("the combined mic is empty only when every part proves it", () => {
  const empty = (id: string) =>
    part({
      id,
      startedAt: id === "part-a" ? "2026-10-19T10:00:00.000Z" : "2026-10-19T10:01:00.000Z",
      sourceMetadata: { mic: { intentionallyEmpty: true } },
    });

  const both = composeMeetingAudioParts([empty("part-a"), empty("part-b")], () => [epoch()]);

  assert.deepEqual(both.recording.sourceMetadata.mic, { intentionallyEmpty: true });

  const mixed = composeMeetingAudioParts(
    [empty("part-a"), part({ id: "part-b", startedAt: "2026-10-19T10:01:00.000Z" })],
    () => [epoch()]
  );

  assert.deepEqual(mixed.recording.sourceMetadata.mic, { intentionallyEmpty: false });
});

test("an anchored capture end wins over a shorter epoch extent", () => {
  const recording = part({ sourceMetadata: { captureEndFrame: 30_000 } });

  assert.equal(meetingTimelineFrameCount(recording, [epoch({ frameCount: 24_000 })]), 30_000);

  // The schema treats a malformed anchor as absent and falls back to the clock.
  const malformed = part({ sourceMetadata: { captureEndFrame: "30000" } });

  assert.equal(meetingTimelineFrameCount(malformed, [epoch({ frameCount: 24_000 })]), 48_000);
});

test("the latest calibrated epoch end rounds its frame extent", () => {
  const recording = part({ startedAt: "2026-10-19T10:00:00.000Z", endedAt: "2026-10-19T10:00:00.000Z" });
  const calibrated = epoch({
    timelineStartFrame: null,
    sourceGeneration: 1,
    frameCount: 1_200,
    alignmentSegments: [{ ...segment(10_000, 1_200), rate: 0.9995 }],
  });

  // 10 000 + round(1 200 * 0.9995) = 10 000 + 1 199.
  assert.equal(meetingTimelineFrameCount(recording, [calibrated]), 11_199);
});

test("an invalid clock range is rejected", () => {
  const missingEnd = part({ endedAt: null });

  assert.throws(() => meetingTimelineFrameCount(missingEnd, [epoch({ frameCount: 0 })]), {
    message: "Meeting recording timeline is invalid",
  });

  const backwards = part({ endedAt: "2026-10-19T09:59:59.000Z" });

  assert.throws(() => meetingTimelineFrameCount(backwards, [epoch({ frameCount: 0 })]), {
    message: "Meeting recording timeline is invalid",
  });
});

test("display skips unproven epochs that processing rejects", () => {
  const unproven = epoch({
    frameCount: 24_000,
    timelineStartFrame: null,
    sourceGeneration: 1,
    sourceStartFrame: null,
  });

  assert.throws(() => meetingTimelineFrameCount(part(), [unproven]), {
    code: "audio-alignment-unavailable",
  });
  assert.equal(meetingTimelineFrameCount(part(), [unproven], true), 48_000);
});

test("processing rejects a source made only of uncalibratable fragments", () => {
  const fragment = epoch({
    frameCount: 100,
    timelineStartFrame: null,
    sourceGeneration: 1,
    alignmentSegments: [],
  });
  const recording = part({ sourceMetadata: { captureEndFrame: 0 } });

  assert.throws(() => meetingTimelineFrameCount(recording, [fragment]), {
    code: "audio-alignment-unavailable",
  });
  assert.equal(meetingTimelineFrameCount(recording, [fragment], true), 0);
});
