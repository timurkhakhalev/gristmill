const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const {
  parseFfmpegDuration,
}: typeof import("../../src/helpers/ffmpegUtils") = require("../../src/helpers/ffmpegUtils");

test("parseFfmpegDuration reads the input duration from ffmpeg output", () => {
  const stderr = "Input #0, mp3, from 'recording.mp3':\n  Duration: 01:13:00.25, start: 0.000000";
  assert.equal(parseFfmpegDuration(stderr), 4380.25);
});

test("parseFfmpegDuration returns null when ffmpeg reports no duration", () => {
  assert.equal(parseFfmpegDuration("Duration: N/A"), null);
  assert.equal(parseFfmpegDuration(""), null);
});
