import assert from "node:assert/strict";
import { compareWaveforms } from "./meeting-waveform-oracle.mts";

export function verifyWaveformControls() {
  const signal = (t: number) =>
    [700, 2300, 5100, 9100].reduce(
      (v, f) => v + Math.sin((2 * Math.PI * f * t) / 24000 + f / 1000),
      0
    ) / 4;
  const x = Float32Array.from({ length: 1024 }, (_, i) => signal(i - 512));
  const y = Float32Array.from({ length: 2048 }, (_, i) => signal(i - 1024 - 0.5));
  const control = compareWaveforms(x, y, 1);
  assert.ok(control.fractional > 0.99);
  const damaged = y.slice();
  damaged.fill(0, 0, 1024);
  const negative = compareWaveforms(x, damaged, 1);
  assert.ok(negative.fractional < 0.8, "oracle must detect missing half-window");
  return { control, negative };
}
