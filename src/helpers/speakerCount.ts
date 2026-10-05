import { MAX_SPEAKER_COUNT } from "../constants/speakerDetection.json";

// expected_speaker_count is a total that already includes you, so anything below
// 1 is meaningless. Storage and persisted settings hand values back as raw
// JSON — numbers, strings, booleans, sloppy arrays — so invalid values arrive
// as data rather than as programmer error and Number() coercion stays part of
// the contract. A Symbol cannot round-trip storage and still throws.
export function normalizeStoredSpeakerCount(value: unknown): number | null {
  const count = Number(value);

  if (!Number.isInteger(count) || count < 1) return null;

  return Math.min(count, MAX_SPEAKER_COUNT);
}
