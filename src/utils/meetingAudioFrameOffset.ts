export const MEETING_AUDIO_SAMPLE_RATE = 24_000;

export const frameOffsetFromSessionOrigin = (originAt: number, sourceStartedAt: number): number =>
  Math.max(
    0,
    Math.round(((sourceStartedAt - originAt) * MEETING_AUDIO_SAMPLE_RATE) / 1000)
  );
