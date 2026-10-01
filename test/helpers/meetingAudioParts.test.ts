const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { composeMeetingAudioParts } = require("../../src/helpers/meetingAudioMixer.ts");

test("combined ASR timeline keeps source gaps and excludes the intentional pause", () => {
  const first = { id: "first", startedAt: "2026-09-25T10:00:00.000Z", endedAt: "2026-09-25T10:00:02.000Z" };
  const second = { id: "second", startedAt: "2026-09-25T10:05:00.000Z", endedAt: "2026-09-25T10:05:01.000Z" };
  const tracks = {
    first: [
      { recordingId: "first", source: "mic", startFrame: 0, frameCount: 24_000 },
      { recordingId: "first", source: "system", startFrame: 30_000, frameCount: 18_000 },
    ],
    second: [
      { recordingId: "second", source: "mic", startFrame: 0, frameCount: 24_000 },
      { recordingId: "second", source: "system", startFrame: 12_000, frameCount: 12_000 },
    ],
  };
  const combined = composeMeetingAudioParts([first, second], (id: keyof typeof tracks) => tracks[id]);
  assert.deepEqual(combined.partOffsets, [{ recordingId: "first", startFrame: 0, frameCount: 48_000 }, { recordingId: "second", startFrame: 48_000, frameCount: 24_000 }]);
  assert.equal(combined.recording.startedAt, first.startedAt);
  assert.equal(combined.recording.endedAt, "2026-09-25T10:00:03.000Z");
  assert.deepEqual(combined.epochs.map(({ recordingId, source, startFrame }: { recordingId: string; source: string; startFrame: number }) => ({ recordingId, source, startFrame })), [
    { recordingId: "first", source: "mic", startFrame: 0 },
    { recordingId: "first", source: "system", startFrame: 30_000 },
    { recordingId: "second", source: "mic", startFrame: 48_000 },
    { recordingId: "second", source: "system", startFrame: 60_000 },
  ]);
});
