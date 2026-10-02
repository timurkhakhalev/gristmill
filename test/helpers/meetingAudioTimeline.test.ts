const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { createMeetingAudioTimeline }: typeof import("../../src/helpers/meetingAudioTimeline.ts") = require("../../src/helpers/meetingAudioTimeline.ts");

test("audio timeline writes only PCM at its supplied actual frame anchors", () => {
  const timeline = createMeetingAudioTimeline();
  const writes: { buffer: Buffer; frameStart: number }[] = [];
  const first = Buffer.alloc(4_800, 1);
  const second = Buffer.alloc(4_800, 2);

  timeline.write(first, 0, (buffer, frameStart) => writes.push({ buffer, frameStart }));
  // Delivery delay does not change the source's actual frame position.
  timeline.write(second, 24_000, (buffer, frameStart) => writes.push({ buffer, frameStart }));

  assert.equal(timeline.lastFrame, 26_400);
  assert.deepEqual(writes.map(({ frameStart }) => frameStart), [0, 24_000]);
  assert.deepEqual(writes.map(({ buffer }) => buffer.length), [4_800, 4_800]);
});

test("a restarted source keeps the actual gap and rejects overlapping frame anchors", () => {
  const timeline = createMeetingAudioTimeline();
  const writes: number[] = [];
  timeline.write(Buffer.alloc(4_800), 0, (_buffer, frameStart) => writes.push(frameStart));
  const restartOffset = timeline.markRestart(24_000);
  timeline.write(Buffer.alloc(2_400), restartOffset, (_buffer, frameStart) => writes.push(frameStart));

  assert.equal(restartOffset, 24_000);
  assert.deepEqual(writes, [0, 24_000]);
  assert.throws(() => timeline.write(Buffer.alloc(2_400), 1_000, () => undefined), /frame range/);
});
