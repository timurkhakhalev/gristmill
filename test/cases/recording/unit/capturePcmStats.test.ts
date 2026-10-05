const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const audio = require("../../../../src/utils/audioUtils.ts");

const fx: typeof import("../../../helpers/harness/pcmFixtures") = require("../../../helpers/harness/pcmFixtures");

test("computeChunkStats matches the inline RMS/peak math (Int16 / 0x7fff)", () => {
  const buf = fx.toInt16Buffer(new Float32Array([0.5, -0.5, 0.25, -0.25]));
  const { rms, peak, sampleCount } = audio.computeChunkStats(buf);
  assert.equal(sampleCount, 4);
  assert.ok(Math.abs(peak - 16384 / 0x7fff) < 1e-6);
  const expectedRms = Math.sqrt(((16384 / 0x7fff) ** 2 * 2 + (8192 / 0x7fff) ** 2 * 2) / 4);
  assert.ok(Math.abs(rms - expectedRms) < 1e-6);
});

test("computeChunkStats returns zeros for buffers shorter than one sample", () => {
  assert.deepEqual(audio.computeChunkStats(Buffer.alloc(1)), { rms: 0, peak: 0, sampleCount: 0 });
  assert.deepEqual(audio.computeChunkStats(Buffer.alloc(0)), { rms: 0, peak: 0, sampleCount: 0 });
});

test("computeChunkStats honours byteOffset on subarray views (matches a fresh copy of the same samples)", () => {
  const track = new Float32Array([0.5, -0.5, 0.25, -0.25, 0.75, -0.75]);
  const view = fx.chunkBuffer(fx.toInt16Buffer(track), 3)[1]; // second 3-sample chunk, byteOffset 6
  assert.ok(view.byteOffset > 0, `fixture must be an offset view (byteOffset ${view.byteOffset})`);
  const copy = Buffer.from(view); // fresh buffer, byteOffset 0, same bytes
  assert.deepEqual(audio.computeChunkStats(view), audio.computeChunkStats(copy));
  assert.equal(audio.computeChunkStats(view).sampleCount, 3);
});
