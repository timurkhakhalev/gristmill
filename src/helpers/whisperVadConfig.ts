const { DEFAULTS, LIMITS } = require("../constants/whisperVad.json");

type VadConfig = Record<string, number>;

type VadSettings = Record<string, unknown> | null | undefined;

export const DEFAULT_WHISPER_VAD_CONFIG: Readonly<VadConfig> = Object.freeze({ ...DEFAULTS });

export const VAD_LIMITS = Object.freeze(LIMITS);

export function clampVadField(key: string, value: unknown): number {
  const fallback = (DEFAULTS as VadConfig)[key];
  const n = value === null || value === undefined || value === "" ? fallback : Number(value);

  if (!Number.isFinite(n)) return fallback;

  const { min, max, round } = (
    LIMITS as Record<string, { min: number; max: number; round?: boolean }>
  )[key];

  const clamped = Math.min(max, Math.max(min, n));

  return round ? Math.round(clamped) : clamped;
}

export function sanitizeWhisperVadConfig(input: Record<string, unknown> | null = {}): VadConfig {
  const merged = { ...DEFAULTS, ...(input || {}) };
  const out: VadConfig = {};

  for (const key of Object.keys(DEFAULTS)) {
    out[key] = clampVadField(key, merged[key]);
  }

  return out;
}

export function resolveContextSileroEnabled(
  settings: VadSettings = {},
  context = "dictation"
): boolean {
  // Dictation is opt-in: VAD on pause-heavy dictations can strip the speech and
  // leave Whisper decoding near-silence seeded with the dictionary prompt, which
  // replaces the transcript with dictionary words (#1454). Long-form contexts
  // (notes, meetings) keep VAD to skip extended silence.
  if (context === "dictation")
    return (settings as Record<string, unknown> | null)?.dictationSileroEnabled === true;

  if (context === "noteRecording")
    return (settings as Record<string, unknown> | null)?.noteRecordingSileroEnabled !== false;

  if (context === "meeting")
    return (settings as Record<string, unknown> | null)?.meetingSileroEnabled !== false;

  return true;
}
