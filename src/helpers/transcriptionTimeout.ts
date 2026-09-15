// Floor keeps short dictations on the same 5-minute budget as before.
export const TRANSCRIPTION_TIMEOUT_FLOOR_MS = 300000;
// 10x real-time budget covers big models on slow CPUs.
export const TRANSCRIPTION_TIMEOUT_PER_AUDIO_SECOND_MS = 10000;
// Flat 60-minute cap when duration is unknown; a hung server must still fail.
export const UNKNOWN_DURATION_TIMEOUT_MS = 3600000;
// 24-hour ceiling keeps the scaled value well under the 32-bit setTimeout limit.
export const TRANSCRIPTION_TIMEOUT_CEILING_MS = 86400000;
// Every local engine is fed 16 kHz mono s16le, so byte length is a duration estimate.
export const PCM16_MONO_16K_BYTES_PER_SECOND = 16000 * 2;

export function computeTranscriptionTimeoutMs(estimatedDurationSeconds: number | null | undefined): number {
  if (typeof estimatedDurationSeconds !== "number" || !Number.isFinite(estimatedDurationSeconds) || estimatedDurationSeconds <= 0) {
    return UNKNOWN_DURATION_TIMEOUT_MS;
  }
  return Math.min(
    TRANSCRIPTION_TIMEOUT_CEILING_MS,
    Math.max(
      TRANSCRIPTION_TIMEOUT_FLOOR_MS,
      Math.ceil(estimatedDurationSeconds * TRANSCRIPTION_TIMEOUT_PER_AUDIO_SECOND_MS)
    )
  );
}
