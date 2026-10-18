const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const {
  createMeetingAudioTimeline,
}: typeof import("../../src/helpers/meetingAudioTimeline.ts") = require("../../src/helpers/meetingAudioTimeline.ts");

test("audio timeline writes only PCM at its supplied actual frame anchors", () => {
  const timeline = createMeetingAudioTimeline();
  const writes: { buffer: Buffer; frameStart: number }[] = [];
  const first = Buffer.alloc(4_800, 1);
  const second = Buffer.alloc(4_800, 2);

  timeline.write(first, 0, (buffer, frameStart) => writes.push({ buffer, frameStart }));
  // Delivery delay does not change the source's actual frame position.
  timeline.write(second, 24_000, (buffer, frameStart) => writes.push({ buffer, frameStart }));

  assert.equal(timeline.lastFrame, 26_400);
  assert.deepEqual(
    writes.map(({ frameStart }) => frameStart),
    [0, 24_000]
  );
  assert.deepEqual(
    writes.map(({ buffer }) => buffer.length),
    [4_800, 4_800]
  );
});

test("a restarted source keeps the actual gap and rejects overlapping frame anchors", () => {
  const timeline = createMeetingAudioTimeline();
  const writes: number[] = [];
  timeline.write(Buffer.alloc(4_800), 0, (_buffer, frameStart) => writes.push(frameStart));
  const restartOffset = timeline.markRestart(24_000);
  timeline.write(Buffer.alloc(2_400), restartOffset, (_buffer, frameStart) =>
    writes.push(frameStart)
  );

  assert.equal(restartOffset, 24_000);
  assert.deepEqual(writes, [0, 24_000]);
  assert.throws(() => timeline.write(Buffer.alloc(2_400), 1_000, () => undefined), /frame range/);
});

// M0/M1 mutation survivor follow-ups (#382): guard clauses observed through public exports.
test("audio timeline: rejects unsafe origins without disturbing a valid timeline", () => {
  for (const origin of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createMeetingAudioTimeline({ originFrame: origin }), RangeError);
  }

  const timeline = createMeetingAudioTimeline({ originFrame: 4_800 });
  assert.equal(timeline.lastFrame, 4_800);
  assert.throws(() => timeline.write(Buffer.alloc(2_400), 0, () => undefined), /frame range/);
  assert.throws(() => timeline.markRestart(2_400), RangeError);
  assert.equal(timeline.markRestart(9_600), 9_600);
});

test("audio timeline: rejects empty, odd and misaligned writes before any output", () => {
  const cases: [Buffer, number][] = [
    [Buffer.alloc(0), 0],
    [Buffer.alloc(3), 0],
    [Buffer.alloc(2), 1.5],
    [Buffer.alloc(2), -2],
  ];

  for (const [buffer, frameStart] of cases) {
    let emitted = 0;
    const timeline = createMeetingAudioTimeline();
    assert.throws(
      () =>
        timeline.write(buffer, frameStart, () => {
          emitted += 1;
        }),
      /frame range/
    );
    assert.equal(emitted, 0, "no samples may be emitted for an invalid write");
  }

  // After a rejection the anchor is unchanged and the next valid write proceeds from it.
  const timeline = createMeetingAudioTimeline();
  timeline.write(Buffer.alloc(4), 0, () => undefined);
  assert.equal(timeline.lastFrame, 2);
  assert.throws(() => timeline.write(Buffer.alloc(4), 1, () => undefined), /frame range/);
  timeline.write(Buffer.alloc(4), 2, () => undefined);
  assert.equal(timeline.lastFrame, 4);
});

test("audio timeline: restart and origin errors keep their exact messages and a no-op restart keeps the anchor", () => {
  const timeline = createMeetingAudioTimeline();
  assert.throws(() => timeline.markRestart(-1), {
    name: "RangeError",
    message: "Invalid meeting audio restart frame",
  });
  // A restart at the current anchor is a legal no-op: it returns the anchor unchanged.
  assert.equal(timeline.markRestart(0), 0);
  assert.equal(timeline.lastFrame, 0);
  assert.throws(() => createMeetingAudioTimeline({ originFrame: -1 }), {
    name: "RangeError",
    message: "Invalid meeting audio origin frame",
  });
});
