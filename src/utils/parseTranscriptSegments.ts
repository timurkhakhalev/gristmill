import type { TranscriptSegment } from "../stores/meetingRecordingStore";
import { normalizeTranscriptSegments } from "./transcriptSpeakerState";
import logger from "./logger";
export function parseTranscriptSegments(raw: string): TranscriptSegment[] {
  if (!raw.startsWith("[")) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{
      text: string;
      source?: "mic" | "system";
      timestamp?: number;
      endTimestamp?: number;
      speaker?: string;
      speakerName?: string;
      speakerIsPlaceholder?: boolean;
      suggestedName?: string;
      suggestedProfileId?: number;
      speakerStatus?: TranscriptSegment["speakerStatus"];
      speakerLocked?: TranscriptSegment["speakerLocked"];
      speakerLockSource?: TranscriptSegment["speakerLockSource"];
    }>;
    return normalizeTranscriptSegments(
      parsed.map((s, i) => ({
        id: `stored-${i}`,
        text: s.text,
        source: s.source,
        timestamp: s.timestamp,
        endTimestamp: s.endTimestamp,
        // Older uploads saved the provider label as speakerName only.
        speaker: s.speaker || s.speakerName,
        speakerName: s.speakerName,
        speakerIsPlaceholder: s.speakerIsPlaceholder ?? (!s.speaker && !!s.speakerName),
        suggestedName: s.suggestedName,
        suggestedProfileId: s.suggestedProfileId,
        speakerStatus: s.speakerStatus ?? (!s.speaker && s.speakerName ? "provisional" : undefined),
        speakerLocked: s.speakerLocked,
        speakerLockSource: s.speakerLockSource,
      }))
    );
  } catch (e) {
    logger.warn("Failed to parse transcript segments", e);
    return [];
  }
}
