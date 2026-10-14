import type { MeetingRecordingEpochDto } from "../contracts/meetingRecording.js";

export interface AlignedAudioRange {
  fileStartFrame: number;
  frameCount: number;
  timelineStartFrame: number;
  rate: number;
  provenance:
    | { kind: "historical-anchored" }
    | {
        kind: "calibrated";
        segmentIndex: number;
        sourceGeneration: number;
        helperGeneration: string;
        sourceStartFrame: number;
        sourceEndFrame: number;
        uncertaintyFrames: number;
      };
}

/** The clock solver needs a probe span of 250 ms at 24 kHz. */
const MIN_CALIBRATION_FRAMES = 6_000;

/**
 * A new-capture epoch shorter than one calibration span, with no segment and no
 * anchor, can never get proven alignment (ADR-0010). It is left out of every mix.
 */
export function isUncalibratableEpochFragment(epoch: MeetingRecordingEpochDto): boolean {
  return (
    epoch.frameCount > 0 &&
    epoch.frameCount < MIN_CALIBRATION_FRAMES &&
    epoch.timelineStartFrame === null &&
    epoch.sourceGeneration !== null &&
    epoch.alignmentSegments.length === 0
  );
}

/** Only proven coverage may enter a derived mix; source-local zero is never a timeline offset. */
export function alignedAudioRanges(epoch: MeetingRecordingEpochDto): AlignedAudioRange[] {
  if (!epoch.frameCount || isUncalibratableEpochFragment(epoch)) return [];

  if (
    epoch.timelineStartFrame !== null &&
    (epoch.sourceGeneration === null || epoch.alignmentSegments.length === 0)
  ) {
    return [
      {
        fileStartFrame: 0,
        frameCount: epoch.frameCount,
        timelineStartFrame: epoch.timelineStartFrame,
        rate: 1,
        provenance: { kind: "historical-anchored" },
      },
    ];
  }

  if (epoch.sourceStartFrame === null || epoch.sourceGeneration === null)
    throw Object.assign(new Error("audio-alignment-unavailable"), {
      code: "audio-alignment-unavailable",
    });

  const segments = epoch.alignmentSegments
    .map((segment, order) => ({ segment, order }))
    .filter(
      ({ segment }) =>
        segment.sourceGeneration === epoch.sourceGeneration &&
        segment.uncertaintyStartFrames <= 600 &&
        segment.uncertaintyEndFrames <= 600 &&
        BigInt(segment.freshnessSourceNs) >= BigInt(segment.sampledSourceEndNs) &&
        BigInt(segment.freshnessSourceNs) - BigInt(segment.sampledSourceEndNs) <= 5_000_000_000n &&
        BigInt(segment.sourceStartNs) >= BigInt(segment.sampledSourceStartNs) - 5_000_000_000n &&
        BigInt(segment.sourceEndNs) <= BigInt(segment.sampledSourceEndNs) + 5_000_000_000n
    );

  // Keep input order for equal endpoints, as the previous selection did.
  const ordered = segments.sort(
    (a, b) => a.segment.sourceStartFrame - b.segment.sourceStartFrame || a.order - b.order
  );

  let nextSegment = 0;
  const result: AlignedAudioRange[] = [];
  const end = epoch.sourceStartFrame + epoch.frameCount;
  let cursor = epoch.sourceStartFrame;
  let helperGeneration: string | undefined;

  while (cursor < end) {
    let best: (typeof ordered)[number] | undefined;

    // Once the furthest endpoint is reached, no earlier candidate can extend
    // coverage. Each segment therefore needs to be visited only once.
    while (nextSegment < ordered.length) {
      const candidate = ordered[nextSegment];

      if (candidate.segment.sourceStartFrame > cursor) break;
      nextSegment++;
      const item = candidate.segment;

      if (
        item.sourceEndFrame > cursor &&
        (!helperGeneration || helperGeneration === item.helperGeneration) &&
        (!best ||
          item.sourceEndFrame > best.segment.sourceEndFrame ||
          (item.sourceEndFrame === best.segment.sourceEndFrame && candidate.order < best.order))
      )
        best = candidate;
    }

    if (!best)
      throw Object.assign(new Error("audio-alignment-unavailable"), {
        code: "audio-alignment-unavailable",
      });
    const segment = best.segment;

    helperGeneration = segment.helperGeneration;
    const next = Math.min(end, segment.sourceEndFrame);
    result.push({
      fileStartFrame: cursor - epoch.sourceStartFrame,
      frameCount: next - cursor,
      timelineStartFrame:
        segment.timelineStartFrame + Math.round((cursor - segment.sourceStartFrame) * segment.rate),
      rate: segment.rate,
      provenance: {
        kind: "calibrated",
        segmentIndex: best.order,
        sourceGeneration: segment.sourceGeneration,
        helperGeneration: segment.helperGeneration,
        sourceStartFrame: segment.sourceStartFrame,
        sourceEndFrame: segment.sourceEndFrame,
        uncertaintyFrames:
          Math.max(segment.uncertaintyStartFrames, segment.uncertaintyEndFrames) + 1,
      },
    });
    cursor = next;
  }

  return result;
}
