import test from "node:test";
import assert from "node:assert/strict";
import { waveformVerdict } from "../../../benchmarks/meeting-waveform-oracle.mts";
import { verifyWaveformControls } from "../../../benchmarks/meeting-waveform-check.mts";

test("fractional comparison preserves its damaged-speech negative control", () => {
  verifyWaveformControls();
});

test("PCM16 quiet windows use bounded absolute error, including exact silence", () => {
  const x = Float32Array.from({ length: 1024 }, (_, i) => Math.sin(i) * 0.7 / 32768);
  const y = new Float32Array(2048);
  for (let i = 0; i < x.length; i++) y[i + 512] = Math.round(x[i] * 32768) / 32768;
  assert.equal(waveformVerdict(x, y, 0.5).passed, true);
  assert.equal(waveformVerdict(new Float32Array(1024), new Float32Array(2048), NaN).passed, true);
  y[901] += 3 / 32768;
  assert.equal(waveformVerdict(x, y, 1).passed, false, "a localized added spike must fail even between correlation samples");
});

test("quiet reference does not excuse added noise or missing audible signal", () => {
  assert.equal(waveformVerdict(new Float32Array(1024), new Float32Array(2048).fill(0.01), 1).passed, false);
  assert.equal(waveformVerdict(new Float32Array(1024).fill(0.01), new Float32Array(2048), 0).passed, false);
});
