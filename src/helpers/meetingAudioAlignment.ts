import type { MeetingRecordingEpochDto } from "../contracts/meetingRecording.js";

export interface AlignedAudioRange {
  fileStartFrame: number;
  frameCount: number;
  timelineStartFrame: number;
  rate: number;
}

/** Only proven coverage may enter a derived mix; source-local zero is never a timeline offset. */
export function alignedAudioRanges(epoch: MeetingRecordingEpochDto): AlignedAudioRange[] {
  if (!epoch.frameCount) return [];

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
      },
    ];
  }

  if (epoch.sourceStartFrame === null || epoch.sourceGeneration === null)
    throw Object.assign(new Error("audio-alignment-unavailable"), {
      code: "audio-alignment-unavailable",
    });

  const segments = epoch.alignmentSegments.filter(
    (segment) =>
      segment.sourceGeneration === epoch.sourceGeneration &&
      segment.uncertaintyStartFrames <= 600 &&
      segment.uncertaintyEndFrames <= 600 &&
      BigInt(segment.freshnessSourceNs) >= BigInt(segment.sampledSourceEndNs) &&
      BigInt(segment.freshnessSourceNs) - BigInt(segment.sampledSourceEndNs) <= 5_000_000_000n &&
      BigInt(segment.sourceStartNs) >= BigInt(segment.sampledSourceStartNs) - 5_000_000_000n &&
      BigInt(segment.sourceEndNs) <= BigInt(segment.sampledSourceEndNs) + 5_000_000_000n
  );

  const result: AlignedAudioRange[] = [];
  const end = epoch.sourceStartFrame + epoch.frameCount;
  let cursor = epoch.sourceStartFrame;
  let helperGeneration: string | undefined;

  while (cursor < end) {
    const segment = segments
      .filter(
        (item) =>
          item.sourceStartFrame <= cursor &&
          item.sourceEndFrame > cursor &&
          (!helperGeneration || helperGeneration === item.helperGeneration)
      )
      .sort((a, b) => b.sourceEndFrame - a.sourceEndFrame)[0];

    if (!segment)
      throw Object.assign(new Error("audio-alignment-unavailable"), {
        code: "audio-alignment-unavailable",
      });
    helperGeneration = segment.helperGeneration;
    const next = Math.min(end, segment.sourceEndFrame);
    result.push({
      fileStartFrame: cursor - epoch.sourceStartFrame,
      frameCount: next - cursor,
      timelineStartFrame:
        segment.timelineStartFrame + Math.round((cursor - segment.sourceStartFrame) * segment.rate),
      rate: segment.rate,
    });
    cursor = next;
  }

  return result;
}
