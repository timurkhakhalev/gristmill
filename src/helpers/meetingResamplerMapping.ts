import type { MeetingRecordingEpochDto, MeetingSource } from "../contracts/meetingRecording.js";
import { alignedAudioRanges } from "./meetingAudioAlignment.js";

export interface MeetingResamplerRow {
  inputStart: number;
  inputEnd: number;
  timelineStart: number;
  timelineEnd: number;
  reset: boolean;
}

export interface MeetingResamplerManifest {
  extent: number;
  source: MeetingSource;
  intentionalSilence: boolean;
  epochs: Array<{
    recordingId: string;
    epochIndex: number;
    inputPath: string;
    inputFrames: number;
    sourceGeneration: number | null;
    rows: MeetingResamplerRow[];
  }>;
  decisions: Array<{
    epochPosition: number;
    rangeIndex: number;
    precedingEnd: number;
    anchor: number;
    correction: number;
    reason: "accepted" | "uncertainty" | "effective-rate";
  }>;
  boundaryResets: number;
}

function integer(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Meeting audio preparation has invalid integer coordinates");
}

/** Consumes authoritative coverage; this mapper cannot make unknown alignment usable. */
export function meetingResamplerManifest(
  source: MeetingSource,
  epochs: MeetingRecordingEpochDto[],
  inputPath: (epoch: MeetingRecordingEpochDto) => string,
  extent: number,
  intentionalSilence = false
): MeetingResamplerManifest {
  integer(extent);

  if (!extent) throw new Error("Meeting audio preparation has no extent");

  const manifest: MeetingResamplerManifest = {
    extent,
    source,
    intentionalSilence,
    epochs: [],
    decisions: [],
    boundaryResets: 0,
  };

  for (const epoch of epochs) {
    if (epoch.source !== source) throw new Error("Meeting audio preparation source mismatch");

    if (!epoch.frameCount) continue;
    integer(epoch.frameCount);
    const ranges = alignedAudioRanges(epoch);
    const rows: MeetingResamplerRow[] = [];

    for (const [index, range] of ranges.entries()) {
      integer(range.fileStartFrame);
      integer(range.frameCount);
      integer(range.timelineStartFrame);

      if (
        !range.frameCount ||
        !Number.isFinite(range.rate) ||
        range.rate < 0.999 ||
        range.rate > 1.001
      )
        throw new Error("Meeting audio preparation has unsupported alignment");

      const row: MeetingResamplerRow = {
        inputStart: range.fileStartFrame,
        inputEnd: range.fileStartFrame + range.frameCount,
        timelineStart: range.timelineStartFrame,
        timelineEnd: range.timelineStartFrame + Math.round(range.frameCount * range.rate),
        reset: true,
      };

      integer(row.inputEnd);
      integer(row.timelineEnd);

      if (
        row.inputStart !== (rows.at(-1)?.inputEnd ?? 0) ||
        row.timelineEnd > extent ||
        row.timelineEnd <= row.timelineStart
      )
        throw new Error("Meeting audio preparation has inconsistent coverage");
      const previous = rows.at(-1);
      const before = ranges[index - 1]?.provenance;
      const current = range.provenance;

      if (previous && before?.kind === "calibrated" && current.kind === "calibrated") {
        if (
          before.sourceGeneration === current.sourceGeneration &&
          before.helperGeneration === current.helperGeneration
        ) {
          const correction = Math.abs(row.timelineStart - previous.timelineEnd);

          const effectiveRate =
            (row.timelineStart - previous.timelineStart) /
            (previous.inputEnd - previous.inputStart);

          const reason =
            correction > before.uncertaintyFrames
              ? "uncertainty"
              : effectiveRate < 0.999 || effectiveRate > 1.001
                ? "effective-rate"
                : "accepted";

          manifest.decisions.push({
            epochPosition: manifest.epochs.length,
            rangeIndex: index,
            precedingEnd: previous.timelineEnd,
            anchor: row.timelineStart,
            correction,
            reason,
          });

          if (reason === "accepted") {
            previous.timelineEnd = row.timelineStart;
            row.reset = false;
          }
        } else manifest.boundaryResets++;
      }

      rows.push(row);
    }

    if (rows.at(-1)?.inputEnd !== epoch.frameCount)
      throw new Error("Meeting audio preparation has incomplete input coverage");

    if (manifest.epochs.length) manifest.boundaryResets++;
    manifest.epochs.push({
      recordingId: epoch.recordingId,
      epochIndex: epoch.epochIndex,
      inputPath: inputPath(epoch),
      inputFrames: epoch.frameCount,
      sourceGeneration: epoch.sourceGeneration,
      rows,
    });
  }

  if (!manifest.epochs.length && !intentionalSilence)
    throw new Error("Meeting audio preparation has no proven input");

  return manifest;
}

export function meetingResamplerMappingText(rows: MeetingResamplerRow[]): string {
  return rows
    .map(
      (row) =>
        `${row.inputStart} ${row.inputEnd} ${row.timelineStart} ${row.timelineEnd} ${Number(row.reset)}\n`
    )
    .join("");
}

export function meetingResamplerDecisionSummary(manifest: MeetingResamplerManifest) {
  const candidates = manifest.decisions.length;
  const accepted = manifest.decisions.filter((value) => value.reason === "accepted").length;

  return {
    candidates,
    accepted,
    rejected: candidates - accepted,
    uncertainty: manifest.decisions.filter((value) => value.reason === "uncertainty").length,
    effectiveRate: manifest.decisions.filter((value) => value.reason === "effective-rate").length,
    acceptedShare: candidates ? accepted / candidates : null,
    corrections: manifest.decisions.map((value) => value.correction),
    boundaryResets: manifest.boundaryResets,
  };
}
