import { z } from "zod";

import type {
  MeetingRecordingDto,
  MeetingRecordingEpochDto,
} from "../contracts/meetingRecording.js";
import { alignedAudioRanges, isUncalibratableEpochFragment } from "./meetingAudioAlignment.js";

const SAMPLE_RATE = 24_000;

export function meetingTimelineFrameCount(
  recording: Pick<MeetingRecordingDto, "startedAt" | "endedAt" | "sourceMetadata">,
  epochs: MeetingRecordingEpochDto[],
  /** Display callers skip epochs whose alignment is not proven yet instead of failing; processing stays strict. */
  lenient = false
): number {
  const ranges = lenient
    ? epochs.flatMap((epoch) => {
        try {
          return alignedAudioRanges(epoch);
        } catch (error) {
          // SAFETY: alignment failures carry their errno-style kind on `code`.
          if ((error as { code?: string }).code === "audio-alignment-unavailable") return [];
          throw error;
        }
      })
    : epochs.flatMap(alignedAudioRanges);

  // A source with audio needs proven coverage. Fragments alone do not give it (ADR-0010).
  if (!lenient) {
    for (const source of ["mic", "system"] as const) {
      const own = epochs.filter((epoch) => epoch.source === source && epoch.frameCount > 0);

      if (own.length && own.every(isUncalibratableEpochFragment))
        throw Object.assign(new Error("audio-alignment-unavailable"), {
          code: "audio-alignment-unavailable",
        });
    }
  }

  const latestEpochEnd = ranges.reduce(
    (latest, range) =>
      Math.max(latest, range.timelineStartFrame + Math.round(range.frameCount * range.rate)),
    0
  );

  // SAFETY: captureEndFrame is this pipeline's integer frame count; the
  // schema is the parse for this free-form metadata field.
  const anchoredEnd = z
    .number()
    .int()
    .nonnegative()
    .nullish()
    .catch(null)
    .parse(recording.sourceMetadata.captureEndFrame);

  if (anchoredEnd !== null && anchoredEnd !== undefined) {
    return Math.max(latestEpochEnd, anchoredEnd);
  }

  // Historical recordings retain the duration saved in their UTC timestamps.
  const startedAt = Date.parse(recording.startedAt);
  const endedAt = recording.endedAt ? Date.parse(recording.endedAt) : NaN;

  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt)
    throw new Error("Meeting recording timeline is invalid");
  const captureEnd = Math.max(0, Math.round(((endedAt - startedAt) * SAMPLE_RATE) / 1000));

  return Math.max(latestEpochEnd, captureEnd);
}

/** Concatenate saved parts for one ASR pass. Gaps inside each part stay in its timeline; intentional pauses do not become silence. */
export interface ComposedMeetingAudioParts {
  recording: MeetingRecordingDto;
  epochs: MeetingRecordingEpochDto[];
  partOffsets: Array<{ recordingId: string; startFrame: number; frameCount: number }>;
}

export function composeMeetingAudioParts(
  parts: MeetingRecordingDto[],
  listEpochs: (recordingId: string) => MeetingRecordingEpochDto[]
): ComposedMeetingAudioParts {
  if (!parts.length) throw new Error("Meeting has no audio parts");
  let offset = 0;

  const ordered = [...parts].sort(
    (a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id)
  );

  const partOffsets: Array<{ recordingId: string; startFrame: number; frameCount: number }> = [];

  const epochs = ordered.flatMap((part) => {
    const own = listEpochs(part.id);

    const shifted = own.map((epoch) => ({
      ...epoch,
      timelineStartFrame:
        epoch.timelineStartFrame === null ? null : epoch.timelineStartFrame + offset,
      alignmentSegments: epoch.alignmentSegments.map((segment) => ({
        ...segment,
        timelineStartFrame: segment.timelineStartFrame + offset,
      })),
    }));

    const frameCount = meetingTimelineFrameCount(part, own);
    partOffsets.push({ recordingId: part.id, startFrame: offset, frameCount });
    offset += frameCount;

    return shifted;
  });

  const first = ordered[0];

  return {
    recording: {
      ...first,
      endedAt: new Date(Date.parse(first.startedAt) + offset / 24).toISOString(),
      sourceMetadata: {
        ...first.sourceMetadata,
        captureEndFrame: offset,
        mic: {
          intentionallyEmpty: ordered.every((part) => {
            const mic = part.sourceMetadata.mic;

            // sourceMetadata.mic is free-form JSON; safeParse is its contract.
            return z.object({ intentionallyEmpty: z.literal(true) }).safeParse(mic).success;
          }),
        },
      },
    },
    epochs,
    partOffsets,
  };
}
