export type MeetingAudioSource = "mic" | "system";

export function downsample24kTo16k(pcmBuffer: Buffer): Buffer {
  const input = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);
  const ratio = 1.5;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIdx = i * ratio;
    const idx = Math.floor(srcIdx);
    const frac = srcIdx - idx;
    const s0 = input[idx];
    const s1 = idx + 1 < input.length ? input[idx + 1] : s0;
    output[i] = Math.round(s0 + frac * (s1 - s0));
  }

  return Buffer.from(output.buffer);
}

export function pcm16ToWav(pcmBuffer: Buffer, sampleRate = 16000, channels = 1): Buffer {
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

export function pcm16ToFloat32(pcmBuffer: Buffer): Float32Array {
  const input = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    output[i] = input[i] / 32768;
  }
  return output;
}

// Energy floors used by the meeting auto-end activity monitor.
export const MEETING_MIC_ACTIVITY_RMS = 0.006;
export const MEETING_SYSTEM_ACTIVITY_RMS = 0.004;

// RMS of raw s16le PCM in [0, 1]. Tolerates the odd-length and unaligned
// buffers that helper stdout reads produce (an Int16Array view would throw on
// an odd byteOffset), which is why it doesn't reuse pcm16ToFloat32.
export function computePcm16Rms(pcmBuffer: Buffer | null | undefined): number {
  if (!pcmBuffer || pcmBuffer.length < 2) return 0;

  const sampleCount = pcmBuffer.length >> 1;
  let sumSquares = 0;

  if ((pcmBuffer.byteOffset & 1) === 0) {
    const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      const sample = samples[i] / 32768;
      sumSquares += sample * sample;
    }
  } else {
    for (let i = 0; i < sampleCount; i++) {
      const sample = pcmBuffer.readInt16LE(i * 2) / 32768;
      sumSquares += sample * sample;
    }
  }

  return Math.sqrt(sumSquares / sampleCount);
}

// RMS and peak for the system capture level and interruption watchdog.
export function computeChunkStats(buffer: Buffer | null | undefined): { rms: number; peak: number; sampleCount: number } {
  if (!buffer || buffer.length < 2) {
    return { rms: 0, peak: 0, sampleCount: 0 };
  }
  const samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length >> 1);
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const n = samples[i] / 0x7fff;
    sumSq += n * n;
    const abs = n < 0 ? -n : n;
    if (abs > peak) peak = abs;
  }
  return { rms: Math.sqrt(sumSq / samples.length), peak, sampleCount: samples.length };
}

const audioUtils = {
  downsample24kTo16k,
  pcm16ToWav,
  pcm16ToFloat32,
  computePcm16Rms,
  MEETING_MIC_ACTIVITY_RMS,
  MEETING_SYSTEM_ACTIVITY_RMS,
};

export default audioUtils;
