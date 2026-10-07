import type { DiarizationSegment } from "./diarization.js";

interface SpeakerMergeSegment {
  speaker: string;
  start: number;
  end: number;
}

export interface MergedSpeakerSegment {
  speaker: string;
  text: string;
  start: number;
  end: number;
}

export function splitIntoSentences(text: string): string[] {
  // SAFETY: Intl.Segmenter is an optional runtime capability; probing the
  // global before use keeps older runtimes on the regex fallback below.
  if (typeof Intl !== "undefined" && (Intl as { Segmenter?: unknown }).Segmenter) {
    try {
      const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });

      return Array.from(segmenter.segment(text), (s: { segment: string }) =>
        s.segment.trim()
      ).filter((s: string) => s.length > 0);
    } catch {
      // fall through to regex
    }
  }

  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function formatTimestamp(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function mergeSpeakersWithText(
  segments: DiarizationSegment[] | null | undefined,
  text: string,
  durationSeconds: number
): MergedSpeakerSegment[] {
  if (!segments || segments.length === 0) {
    return [{ speaker: "speaker_0", text, start: 0, end: durationSeconds || 0 }];
  }

  // Segments arrive in stdout order, not sorted — never assume the last one ends latest.
  const maxSegmentEnd = segments.reduce((max, s) => Math.max(max, s.end || 0), 0);

  const sentences = splitIntoSentences(text);

  if (sentences.length === 0) {
    return [{ speaker: segments[0].speaker, text, start: segments[0].start, end: maxSegmentEnd }];
  }

  const totalDuration = durationSeconds || maxSegmentEnd || 1;
  const totalChars = sentences.reduce((sum: number, s) => sum + s.length, 0);

  const assigned: MergedSpeakerSegment[] = [];
  let charOffset = 0;

  for (const sentence of sentences) {
    const sentenceMidpoint = ((charOffset + sentence.length / 2) / totalChars) * totalDuration;
    charOffset += sentence.length;

    let bestSegment: SpeakerMergeSegment | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const seg of segments) {
      const distance =
        sentenceMidpoint < seg.start
          ? seg.start - sentenceMidpoint
          : sentenceMidpoint > seg.end
            ? sentenceMidpoint - seg.end
            : 0;

      if (distance < bestDistance) {
        bestDistance = distance;
        bestSegment = seg;
      }

      if (distance === 0) break;
    }

    // SAFETY: segments is non-empty (checked above), so the loop always
    // selects a best segment before reaching here.
    const chosen = bestSegment as SpeakerMergeSegment;
    assigned.push({
      speaker: chosen.speaker,
      text: sentence,
      start: chosen.start,
      end: chosen.end,
    });
  }

  const consolidated: MergedSpeakerSegment[] = [];

  for (const item of assigned) {
    const prev = consolidated[consolidated.length - 1];

    if (prev && prev.speaker === item.speaker) {
      prev.text += " " + item.text;
      prev.end = Math.max(prev.end, item.end);
    } else {
      consolidated.push({ ...item });
    }
  }

  return consolidated;
}

export function formatSpeakerTranscript(mergedSegments: MergedSpeakerSegment[]): string {
  const speakerMap = new Map<string, number>();
  let nextIndex = 1;

  return mergedSegments
    .map((seg) => {
      if (!speakerMap.has(seg.speaker)) {
        speakerMap.set(seg.speaker, nextIndex++);
      }

      const label = `Speaker ${speakerMap.get(seg.speaker)}`;
      const timeRange = `${formatTimestamp(seg.start)} - ${formatTimestamp(seg.end)}`;

      return `[${label}] ${timeRange}\n${seg.text}`;
    })
    .join("\n\n");
}
