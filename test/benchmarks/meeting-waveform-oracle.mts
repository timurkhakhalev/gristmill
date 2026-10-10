// Independent fractional-delay waveform comparison; no native-resampler calls.
const sinc = (x: number) => (Math.abs(x) < 1e-10 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
function sample(y: Float32Array, t: number) {
  const base = Math.floor(t);
  let sum = 0,
    weight = 0;
  for (let j = base - 15; j <= base + 16; j++) {
    const d = t - j;
    const w = sinc(d) * 0.5 * (1 + Math.cos((Math.PI * d) / 16));
    sum += y[j] * w;
    weight += w;
  }
  return sum / weight;
}
function score(x: Float32Array, y: Float32Array, ratio: number, lag: number, fractional: boolean) {
  let dot = 0,
    ex = 0,
    ey = 0;
  for (let j = 256; j < 768; j += 4) {
    const t = 1024 + (j - 512) * ratio + lag;
    const a = x[j],
      b = fractional ? sample(y, t) : y[Math.round(t)];
    dot += a * b;
    ex += a * a;
    ey += b * b;
  }
  return dot / Math.sqrt(ex * ey);
}
export function compareWaveforms(x: Float32Array, y: Float32Array, ratio: number) {
  let integer = -1,
    integerLag = 0;
  for (let lag = -96; lag <= 96; lag++) {
    const c = score(x, y, ratio, lag, false);
    if (c > integer) {
      integer = c;
      integerLag = lag;
    }
  }
  let fractional = -1,
    lag = 0;
  for (let step = -32; step <= 32; step++) {
    const shift = integerLag + step / 32;
    const c = score(x, y, ratio, shift, true);
    if (c > fractional) {
      fractional = c;
      lag = shift;
    }
  }
  // Integer correlation can pick the wrong local peak for high-frequency audio.
  // On an unresolved window search the whole allowed lag interval fractionally.
  if (fractional <= 0.8) {
    for (let step = -96 * 4; step <= 96 * 4; step++) {
      const shift = step / 4,
        c = score(x, y, ratio, shift, true);
      if (c > fractional) {
        fractional = c;
        lag = shift;
      }
    }
    const coarse = lag;
    for (let step = -8; step <= 8; step++) {
      const shift = coarse + step / 32,
        c = score(x, y, ratio, shift, true);
      if (c > fractional) {
        fractional = c;
        lag = shift;
      }
    }
  }
  return { integer, integerLag, fractional, lag };
}

/** PCM16 cannot preserve waveform correlation below one quantization step.
 * Inspect every central sample, at zero lag, before allowing absolute-error validation.
 */
export function waveformVerdict(x: Float32Array, y: Float32Array, fractional: number) {
  const step = 1 / 32768;
  let energy = 0, error = 0, peakError = 0;
  for (let j = 256; j < 768; j++) {
    const difference = x[j] - y[j + 512];
    energy += x[j] * x[j];
    error += difference * difference;
    peakError = Math.max(peakError, Math.abs(difference));
  }
  const rms = Math.sqrt(energy / 512), errorRms = Math.sqrt(error / 512);
  const quiet = rms <= step;
  return { quiet, rms, errorRms, peakError,
    passed: quiet ? errorRms <= step && peakError <= 2 * step : fractional > 0.8 };
}
