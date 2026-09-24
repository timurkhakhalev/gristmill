const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createMeetingAudioTimeline,
  frameOffsetFromSessionOrigin,
} = require("../../src/helpers/meetingAudioTimeline.ts");

test("audio timeline records only received PCM and preserves delivery gaps as offsets", () => {
  const originAt = 10_000;
  let wallNow = originAt + 500;
  const timeline = createMeetingAudioTimeline({ originAt, wallNow: () => wallNow });
  const writes = [];
  const first = Buffer.alloc(4_800, 1); // 100 ms at 24 kHz, mono PCM16
  const second = Buffer.alloc(4_800, 2);

  timeline.write(first, (buffer, sampleOffset, capturedAt) => {
    writes.push({ buffer, sampleOffset, capturedAt });
  });
  wallNow += 2_000; // IPC delivery jitter does not synthesize silence.
  timeline.write(second, (buffer, sampleOffset, capturedAt) => {
    writes.push({ buffer, sampleOffset, capturedAt });
  });

  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map(({ sampleOffset }) => sampleOffset), [0, 2_400]);
  assert.deepEqual(writes.map(({ buffer }) => buffer.length), [4_800, 4_800]);
  assert.equal(writes[1].capturedAt, originAt + 100);
});

test("a restarted source begins at the later of its wall-clock offset and prior end", () => {
  const originAt = 50_000;
  let wallNow = originAt + 100;
  const timeline = createMeetingAudioTimeline({ originAt, wallNow: () => wallNow });
  const writes = [];
  timeline.write(Buffer.alloc(4_800), (buffer, sampleOffset) => {
    writes.push({ buffer, sampleOffset });
  });

  wallNow = originAt + 1_000;
  const restartOffset = timeline.markRestart();
  timeline.write(Buffer.alloc(2_400), (buffer, sampleOffset) => {
    writes.push({ buffer, sampleOffset });
  });

  assert.equal(restartOffset, 24_000);
  assert.deepEqual(writes.map(({ sampleOffset }) => sampleOffset), [0, 24_000]);
  assert.equal(writes.reduce((total, write) => total + write.buffer.length, 0), 7_200);
  assert.equal(frameOffsetFromSessionOrigin(originAt, originAt + 1_250), 30_000);
});
