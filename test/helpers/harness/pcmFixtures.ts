// Deterministic PCM generators for meeting-audio tests. 24 kHz mono float in [-1, 1].
export const SAMPLE_RATE = 24000;

export interface PcmOptions {
  durationMs: number;
  amplitude?: number;
  sampleRate?: number;
}

const samplesFor = (durationMs: number, sampleRate: number): number =>
  Math.round((durationMs / 1000) * sampleRate);

export function makeSine({
  frequencyHz = 440,
  durationMs,
  amplitude = 0.5,
  sampleRate = SAMPLE_RATE,
  phase = 0,
}: PcmOptions & { frequencyHz?: number; phase?: number }): Float32Array {
  const out = new Float32Array(samplesFor(durationMs, sampleRate));
  const step = (2 * Math.PI * frequencyHz) / sampleRate;

  for (let i = 0; i < out.length; i += 1) out[i] = amplitude * Math.sin(phase + i * step);

  return out;
}

// Numerical Recipes LCG — same seed ⇒ same samples on every platform.
export function makeSeededNoise({
  durationMs,
  amplitude = 0.5,
  seed = 1,
  sampleRate = SAMPLE_RATE,
}: PcmOptions & { seed?: number }): Float32Array {
  const out = new Float32Array(samplesFor(durationMs, sampleRate));
  let state = seed >>> 0;

  for (let i = 0; i < out.length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = amplitude * ((state / 4294967296) * 2 - 1);
  }

  return out;
}

export function mix(...tracks: Float32Array[]): Float32Array {
  const length = Math.max(0, ...tracks.map((t) => t.length));
  const out = new Float32Array(length);

  for (const track of tracks) {
    for (let i = 0; i < track.length; i += 1) out[i] += track[i];
  }

  for (let i = 0; i < out.length; i += 1) out[i] = Math.max(-1, Math.min(1, out[i]));

  return out;
}

export function scale(track: Float32Array, gain: number): Float32Array {
  const out = new Float32Array(track.length);

  for (let i = 0; i < track.length; i += 1) out[i] = track[i] * gain;

  return out;
}

export function delayBy(
  track: Float32Array,
  delayMs: number,
  sampleRate = SAMPLE_RATE
): Float32Array {
  const lead = samplesFor(delayMs, sampleRate);
  const out = new Float32Array(track.length + lead);
  out.set(track, lead);

  return out;
}

export function toInt16Buffer(track: Float32Array): Buffer {
  const buf = Buffer.alloc(track.length * 2);

  for (let i = 0; i < track.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, track[i]));
    const value = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, value)), i * 2);
  }

  return buf;
}

export function chunkBuffer(buffer: Buffer, samplesPerChunk: number): Buffer[] {
  const bytes = samplesPerChunk * 2;
  const chunks: Buffer[] = [];

  for (let offset = 0; offset < buffer.length; offset += bytes) {
    chunks.push(buffer.subarray(offset, Math.min(buffer.length, offset + bytes)));
  }

  return chunks;
}

export function rmsOf(track: Float32Array): number {
  if (!track.length) return 0;
  let sumSq = 0;

  for (let i = 0; i < track.length; i += 1) sumSq += track[i] * track[i];

  return Math.sqrt(sumSq / track.length);
}

export const dbToGain = (db: number): number => 10 ** (db / 20);
