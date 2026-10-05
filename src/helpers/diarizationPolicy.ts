// Clustering policy for the upload/batch diarization path. Kept free of
// electron imports so the rules stay unit-testable (pattern: cloudChunkPolicy).

// sherpa-onnx's cluster threshold is a cosine distance: higher merges more.
// 0.55 suits short clean audio, but over a long single-mic recording one
// speaker's embeddings drift wider than that and agglomerative clustering
// stops merging early — a 73-minute voice memo produced 46 "speakers". Ramp
// the threshold with duration instead of pretending one constant fits both.
export const DEFAULT_CLUSTER_THRESHOLD = 0.55;

export const LONG_AUDIO_CLUSTER_THRESHOLD = 0.8;

export const THRESHOLD_RAMP_START_SECONDS = 15 * 60;

export const THRESHOLD_RAMP_END_SECONDS = 60 * 60;

// A cluster with under a second of total speech is embedding noise, not a
// person — and the character-proportional merge hands every surviving cluster
// at least one sentence, so each blip becomes a phantom [Speaker N].
export const MIN_CLUSTER_TOTAL_SECONDS = 1;

interface PolicySegment {
  speaker: string;
  start: number;
  end: number;
}

export function clusterThresholdForDuration(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= THRESHOLD_RAMP_START_SECONDS) {
    return DEFAULT_CLUSTER_THRESHOLD;
  }

  if (durationSeconds >= THRESHOLD_RAMP_END_SECONDS) return LONG_AUDIO_CLUSTER_THRESHOLD;

  const progress =
    (durationSeconds - THRESHOLD_RAMP_START_SECONDS) /
    (THRESHOLD_RAMP_END_SECONDS - THRESHOLD_RAMP_START_SECONDS);

  return (
    DEFAULT_CLUSTER_THRESHOLD +
    (LONG_AUDIO_CLUSTER_THRESHOLD - DEFAULT_CLUSTER_THRESHOLD) * progress
  );
}

export function resolveClusterThreshold(
  durationSeconds: number,
  requestedThreshold: number | string | null | undefined
): number {
  const automaticThreshold = clusterThresholdForDuration(durationSeconds);

  if (requestedThreshold == null || requestedThreshold === "") return automaticThreshold;
  const parsedThreshold = Number(requestedThreshold);

  if (!Number.isFinite(parsedThreshold)) return automaticThreshold;

  return Math.min(1, Math.max(0, parsedThreshold));
}

export function dropNegligibleClusters<T extends PolicySegment>(
  segments: T[] | null | undefined,
  minTotalSeconds = MIN_CLUSTER_TOTAL_SECONDS
): T[] | null | undefined {
  if (!segments?.length) return segments;
  const totals = new Map<string, number>();

  for (const s of segments) {
    totals.set(s.speaker, (totals.get(s.speaker) || 0) + (s.end - s.start));
  }

  const keep = new Set(
    [...totals].filter(([, total]) => total >= minTotalSeconds).map(([speaker]) => speaker)
  );

  if (keep.size === 0 || keep.size === totals.size) return segments;

  return segments.filter((s) => keep.has(s.speaker));
}
