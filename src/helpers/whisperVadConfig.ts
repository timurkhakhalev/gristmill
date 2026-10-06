import vadConstants from "../constants/whisperVad.json";

const { DEFAULTS, LIMITS } = vadConstants;

export type VadConfig = {
  threshold: number;
  minSpeechDurationMs: number;
  minSilenceDurationMs: number;
  maxSpeechDurationS: number;
  speechPadMs: number;
  samplesOverlap: number;
};

type VadSettings =
  | {
      noteRecordingSileroEnabled?: boolean;
      meetingSileroEnabled?: boolean;
      dictationSileroEnabled?: boolean;
    }
  | null
  | undefined;

export const DEFAULT_WHISPER_VAD_CONFIG: Readonly<VadConfig> = Object.freeze({ ...DEFAULTS });

export const VAD_LIMITS = Object.freeze(LIMITS);

const VAD_KEYS = [
  "threshold",
  "minSpeechDurationMs",
  "minSilenceDurationMs",
  "maxSpeechDurationS",
  "speechPadMs",
  "samplesOverlap",
] as const;

type VadKey = (typeof VAD_KEYS)[number];

type VadLimit = { min: number; max: number; round?: boolean };

// SAFETY: the packaged whisperVad.json is this repo's own constants file;
// the assertion pins its key set to the VAD_KEYS tuple above.
const DEFAULTS_BY_KEY = DEFAULTS as Record<VadKey, number>;

// SAFETY: same packaged constants file; the assertion pins the limit shape.
const LIMITS_BY_KEY = LIMITS as Record<VadKey, VadLimit>;

// `value` is the merged settings entry; Number() plus the finite check below
// is the parse that turns it into the clamped domain number.
export function clampVadField(key: VadKey, value: unknown): number {
  const fallback = DEFAULTS_BY_KEY[key];
  const n = value === null || value === undefined || value === "" ? fallback : Number(value);

  if (!Number.isFinite(n)) return fallback;

  const { min, max, round } = LIMITS_BY_KEY[key];

  const clamped = Math.min(max, Math.max(min, n));

  return round ? Math.round(clamped) : clamped;
}

export function sanitizeWhisperVadConfig(input: Partial<VadConfig> | null = {}): VadConfig {
  const merged = { ...DEFAULTS, ...(input || {}) };
  // SAFETY: the loop below assigns every VAD key exactly once.
  const out: VadConfig = {} as VadConfig;

  for (const key of VAD_KEYS) {
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
  if (context === "dictation") return settings?.dictationSileroEnabled === true;

  if (context === "noteRecording") return settings?.noteRecordingSileroEnabled !== false;

  if (context === "meeting") return settings?.meetingSileroEnabled !== false;

  return true;
}
