/**
 * Pure meeting mic gate: RMS/peak chunk stats and the send/zero/skip verdict.
 *
 * Extracted verbatim from ipcHandlers.js (dispatchMeetingAudioBuffer for the
 * streaming path, transcribeLocalMeetingChunk for the local path). Phase 0 keeps
 * today's policy exactly; Phase 1 changes the policy here, behind these tests.
 */
import type { MeetingAudioSource } from "../utils/audioUtils.js";

export const MEETING_MIC_SILENCE_RMS = 0.0015;
export const MEETING_MIC_SILENCE_PEAK = 0.05;
export const MEETING_MIC_BLEED_RMS_CEILING = 0.018;
export const MEETING_MIC_BLEED_PEAK_CEILING = 0.07;

export interface MicChunkStats {
  rms: number;
  peak: number;
  sampleCount: number;
}

export type MicChunkMode = "local" | "streaming";
export type MicChunkVerdict =
  | { action: "send"; reason: null }
  | { action: "zero"; reason: "silence" | "bleed_floor" }
  | { action: "skip"; reason: "silence" | "system_dominant" };

export interface ResolveMicChunkActionOptions extends MicChunkStats {
  mode: MicChunkMode;
  source: MeetingAudioSource;
  isSystemSpeaking: () => boolean;
}

const SEND: MicChunkVerdict = Object.freeze({ action: "send", reason: null });

export function computeChunkStats(buffer: Buffer | null | undefined): MicChunkStats {
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

export function resolveMicChunkAction({
  mode,
  source,
  rms,
  peak,
  sampleCount,
  isSystemSpeaking,
}: ResolveMicChunkActionOptions): MicChunkVerdict {
  if (!sampleCount) return SEND;

  const isMic = source === "mic";
  const silent = rms < MEETING_MIC_SILENCE_RMS && peak < MEETING_MIC_SILENCE_PEAK;
  const quiet = rms < MEETING_MIC_BLEED_RMS_CEILING && peak < MEETING_MIC_BLEED_PEAK_CEILING;

  if (mode === "local") {
    if (silent) return { action: "skip", reason: "silence" };
    if (isMic && quiet && isSystemSpeaking()) return { action: "skip", reason: "system_dominant" };
    return SEND;
  }

  if (!isMic) return SEND;
  if (silent) return { action: "zero", reason: "silence" };
  if (quiet && isSystemSpeaking()) return { action: "zero", reason: "bleed_floor" };
  return SEND;
}
