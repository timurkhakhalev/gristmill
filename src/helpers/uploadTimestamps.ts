// Which extra multipart fields ask a BYOK transcription provider for
// segment-level timestamps, and how its verbose response maps back to
// segments. Gated per provider/model because unsupported combinations
// (gpt-4o-transcribe rejects verbose_json; custom/self-hosted servers may
// 400 on unknown fields) must keep the plain-text request untouched — a
// missing timestamp is a degraded export, never a failed upload.
import { z } from "zod";

export interface VerboseTranscriptionSegment {
  text: string;
  start: number;
  end: number;
}

const finiteTimestamp = z
  .number()
  .refine((value) => Number.isFinite(value))
  .nullish()
  .catch(null);

const verboseSegmentSchema = z.object({
  text: z.string(),
  start: finiteTimestamp,
  end: finiteTimestamp,
});

const verboseResponseSchema = z.looseObject({ segments: z.array(z.unknown()).optional() });

export function timestampRequestFields(
  provider: string,
  model: string | null
): Record<string, string> | null {
  if (provider === "openai" && model === "whisper-1") {
    return { response_format: "verbose_json" };
  }

  if (provider === "groq") {
    return { response_format: "verbose_json" };
  }

  if (provider === "mistral") {
    return { timestamp_granularities: "segment" };
  }

  return null;
}

// verbose_json (OpenAI/Groq) and Mistral's segment granularity both carry
// `segments: [{ text, start, end }]`. Null when the response has nothing
// usable, so callers fall back to the plain transcript.
export function mapVerboseSegments<T>(responseData: T): VerboseTranscriptionSegment[] | null {
  const envelope = verboseResponseSchema.safeParse(responseData);

  if (!envelope.success || !envelope.data.segments) return null;

  const mapped: VerboseTranscriptionSegment[] = [];

  for (const raw of envelope.data.segments) {
    const parsed = verboseSegmentSchema.safeParse(raw);

    if (!parsed.success) continue;
    const text = parsed.data.text.trim();
    const rawStart = parsed.data.start;
    const rawEndValue = parsed.data.end;

    if (!text || rawStart === null || rawStart === undefined) continue;
    const start = Math.max(0, rawStart);
    const rawEnd = rawEndValue === null || rawEndValue === undefined ? start : rawEndValue;
    const end = Math.max(start, rawEnd);
    mapped.push({ text, start, end });
  }

  return mapped.length ? mapped : null;
}
