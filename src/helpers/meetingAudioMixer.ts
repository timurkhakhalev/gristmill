import { spawn as spawnChild, type ChildProcess } from "child_process";
import fs from "fs";
import { inspectMeetingOpus } from "./meetingOpus.js";
import path from "path";
import type { MeetingRecordingDto, MeetingRecordingEpochDto, MeetingIntentionalInterval, MeetingSource } from "../contracts/meetingRecording.js";
import type { MeetingRecordingStorage } from "./meetingRecordingStorage.js";
import { createAbortError } from "./abortError.js";
import { getFFmpegPath } from "./ffmpegUtils.js";

import { alignedAudioRanges } from "./meetingAudioAlignment.js";

const SAMPLE_RATE = 24_000;
const BYTES_PER_FRAME = 2;
export type MeetingAudioLayout = "mono" | "stereo" | "mic" | "system";
const WAV_HEADER_LIMIT = 4096;

export interface MeetingAudioMixerDeps {
  ffmpegPath?: () => string | null;
  spawn?: (command: string, args: string[], options: { stdio: ["ignore", "ignore", "pipe"] }) => ChildProcess;
  availableBytes?: (path: string) => number;
  stat?: (path: string) => fs.Stats;
  inspectEpoch?: typeof inspectMeetingOpus;
  readHeader?: (path: string) => Buffer;
  exists?: (path: string) => boolean;
  remove?: (path: string, options?: { force: boolean }) => void;
  rename?: (oldPath: string, newPath: string) => void;
};

export interface PreparedMeetingAudio {
  path: string;
  frameCount: number;
  durationSeconds: number;
  sizeBytes: number;
}

interface EpochInput {
  path: string;
  source: "mic" | "system";
  startFrame: number;
  frameCount: number;
  fileStartFrame: number;
  epochFrameCount: number;
  rate: number;
}

export function meetingTimelineFrameCount(
  recording: Pick<MeetingRecordingDto, "startedAt" | "endedAt" | "sourceMetadata">,
  epochs: MeetingRecordingEpochDto[],
  /** Display callers skip epochs whose alignment is not proven yet instead of failing; processing stays strict. */
  lenient = false
): number {
  const ranges = lenient ? epochs.flatMap((epoch) => {
    try { return alignedAudioRanges(epoch); }
    catch (error) {
      if ((error as { code?: string }).code === "audio-alignment-unavailable") return [];
      throw error;
    }
  }) : epochs.flatMap(alignedAudioRanges);
  const latestEpochEnd = ranges.reduce(
    (latest, range) => Math.max(latest, range.timelineStartFrame + Math.round(range.frameCount * range.rate)), 0);
  const anchoredEnd = recording.sourceMetadata.captureEndFrame;
  if (Number.isSafeInteger(anchoredEnd) && (anchoredEnd as number) >= 0) {
    return Math.max(latestEpochEnd, anchoredEnd as number);
  }
  // Historical recordings retain the duration saved in their UTC timestamps.
  const startedAt = Date.parse(recording.startedAt);
  const endedAt = recording.endedAt ? Date.parse(recording.endedAt) : NaN;
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) throw new Error("Meeting recording timeline is invalid");
  const captureEnd = Math.max(0, Math.round((endedAt - startedAt) * SAMPLE_RATE / 1000));
  return Math.max(latestEpochEnd, captureEnd);
}

export function meetingSourceIntentionallyEmpty(
  recording: MeetingRecordingDto,
  epochs: MeetingRecordingEpochDto[],
  intervals: MeetingIntentionalInterval[],
  source: MeetingSource
): boolean {
  if (epochs.some((epoch) => epoch.source === source && epoch.frameCount > 0)) return false;
  // An intent held for the entire capture proves silence without a clock mapping.
  // Partial mute intervals still require aligned coverage below.
  const metadata = recording.sourceMetadata[source];
  if (metadata && typeof metadata === "object" && "intentionallyEmpty" in metadata && metadata.intentionallyEmpty === true) return true;
  const frameCount = meetingTimelineFrameCount(recording, epochs);
  if (frameCount <= 0) return false;
  let coveredThrough = 0;
  for (const interval of intervals.filter((value) => value.source === source).sort((a, b) => (a.timelineStartFrame ?? Infinity) - (b.timelineStartFrame ?? Infinity))) {
    if (interval.timelineEndFrame === null || interval.timelineStartFrame === null || interval.timelineStartFrame > coveredThrough) return false;
    coveredThrough = Math.max(coveredThrough, interval.timelineEndFrame);
    if (coveredThrough >= frameCount) return true;
  }
  return false;
}

/** Concatenate saved parts for one ASR pass. Gaps inside each part stay in its timeline; intentional pauses do not become silence. */
export function composeMeetingAudioParts(
  parts: MeetingRecordingDto[],
  listEpochs: (recordingId: string) => MeetingRecordingEpochDto[]
): { recording: MeetingRecordingDto; epochs: MeetingRecordingEpochDto[]; partOffsets: Array<{ recordingId: string; startFrame: number; frameCount: number }> } {
  if (!parts.length) throw new Error("Meeting has no audio parts");
  let offset = 0;
  const ordered = [...parts].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  const partOffsets: Array<{ recordingId: string; startFrame: number; frameCount: number }> = [];
  const epochs = ordered.flatMap((part) => {
    const own = listEpochs(part.id);
    const shifted = own.map((epoch) => ({ ...epoch,
      timelineStartFrame: epoch.timelineStartFrame === null ? null : epoch.timelineStartFrame + offset,
      alignmentSegments: epoch.alignmentSegments.map((segment) => ({ ...segment, timelineStartFrame: segment.timelineStartFrame + offset })),
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
      sourceMetadata: { ...first.sourceMetadata, captureEndFrame: offset,
        mic: { intentionallyEmpty: ordered.every((part) => {
          const mic = part.sourceMetadata.mic;
          return mic && typeof mic === "object" && "intentionallyEmpty" in mic && mic.intentionallyEmpty === true;
        }) },
      },
    },
    epochs,
    partOffsets,
  };
}

export async function prepareMeetingAudio(
  storage: MeetingRecordingStorage,
  recording: MeetingRecordingDto,
  runId: string,
  epochs: MeetingRecordingEpochDto[],
  options: { signal?: AbortSignal; deps?: MeetingAudioMixerDeps; layout?: MeetingAudioLayout; intentionalEmptySources?: MeetingSource[] } = {}
): Promise<PreparedMeetingAudio> {
  const deps = options.deps ?? {};
  const layout = options.layout ?? "mono";
  const channels = layout === "stereo" ? 2 : 1;
  const ffmpegPath = (deps.ffmpegPath ?? getFFmpegPath)();
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable");
  const frameCount = meetingTimelineFrameCount(recording, epochs);
  if (frameCount <= 0) throw new Error("Meeting recording has no audio frames");

  const inputs: EpochInput[] = epochs
    .filter((epoch) => epoch.frameCount > 0 && (layout !== "mic" && layout !== "system" || epoch.source === layout))
    .flatMap((epoch) => alignedAudioRanges(epoch).map((range) => ({
      source: epoch.source,
      path: storage.getEpochFilePath(epoch.recordingId, epoch.source, epoch.epochIndex),
      startFrame: range.timelineStartFrame, frameCount: range.frameCount,
      fileStartFrame: range.fileStartFrame, epochFrameCount: epoch.frameCount, rate: range.rate,
    })));
  const intentionalEmptySources = new Set(options.intentionalEmptySources ?? []);
  if (!inputs.length && !((layout === "mic" && intentionalEmptySources.has("mic")) || (layout === "system" && intentionalEmptySources.has("system")))) {
    throw new Error("Meeting recording has no usable audio epochs");
  }
  for (const epoch of epochs) {
    if (epoch.state === "open") throw new Error("Meeting recording has an unfinalized audio epoch");
  }
  const inspectedPaths = new Set<string>();
  for (const input of inputs) {
    if (inspectedPaths.has(input.path)) continue;
    inspectedPaths.add(input.path);
    if ((deps.inspectEpoch ?? inspectMeetingOpus)(input.path).frameCount !== input.epochFrameCount) {
      throw new Error("Meeting recording audio epoch duration does not match its saved timeline");
    }
  }

  const finalPath = storage.getDerivedAudioPath(recording.id, runId, layout);
  if ((deps.exists ?? fs.existsSync)(finalPath)) {
    const existing = inspectPcmWav(finalPath, frameCount, deps, channels);
    return { path: finalPath, frameCount, durationSeconds: frameCount / SAMPLE_RATE, sizeBytes: existing.sizeBytes };
  }

  const tempPath = storage.getDerivedAudioTempPath(recording.id, runId, layout);
  const estimatedBytes = frameCount * BYTES_PER_FRAME * channels + 4096;
  const availableBytes = (deps.availableBytes ?? getAvailableBytes)(path.dirname(finalPath));
  if (availableBytes < estimatedBytes) throw new Error("Insufficient disk space for meeting audio preparation");

  try {
    await runMixer(ffmpegPath, inputs, frameCount, tempPath, options.signal, deps, layout, intentionalEmptySources);
    const inspected = inspectPcmWav(tempPath, frameCount, deps, channels);
    (deps.rename ?? fs.renameSync)(tempPath, finalPath);
    return { path: finalPath, frameCount, durationSeconds: frameCount / SAMPLE_RATE, sizeBytes: inspected.sizeBytes };
  } catch (error) {
    try {
      (deps.remove ?? fs.rmSync)(tempPath, { force: true });
    } catch {
      // A partial temporary file is never used as input.
    }
    throw error;
  }
}

function runMixer(
  ffmpegPath: string,
  inputs: EpochInput[],
  frameCount: number,
  outputPath: string,
  signal: AbortSignal | undefined,
  deps: MeetingAudioMixerDeps,
  layout: MeetingAudioLayout,
  intentionalEmptySources: Set<MeetingSource>
): Promise<void> {
  if (signal?.aborted) return Promise.reject(createAbortError());
  const paths = [...new Set(inputs.map((input) => input.path))];
  const filters: string[] = [];
  const labels = new Map<number, string>();
  paths.forEach((file, fileIndex) => {
    const indexes = inputs.flatMap((input, index) => input.path === file ? [index] : []);
    if (indexes.length === 1) labels.set(indexes[0], `${fileIndex}:a`);
    else {
      const names = indexes.map((index) => `src${index}`);
      filters.push(`[${fileIndex}:a]asplit=${names.length}${names.map((name) => `[${name}]`).join("")}`);
      indexes.forEach((index, i) => labels.set(index, names[i]));
    }
  });
  inputs.forEach((input, index) => {
    const outputFrames = Math.round(input.frameCount * input.rate);
    filters.push(`[${labels.get(index)}]aresample=${SAMPLE_RATE},atrim=start_sample=${input.fileStartFrame}:end_sample=${input.fileStartFrame + input.frameCount},asetpts=PTS-STARTPTS${input.rate === 1 ? "" : `,atempo=${1 / input.rate}`},apad=whole_len=${outputFrames},atrim=end_sample=${outputFrames},adelay=${input.startFrame}S:all=1${layout === "mono" ? ",volume=0.5" : ""}[a${index}]`);
  });
  const mix = (indexes: number[], label: string) => {
    if (!indexes.length) {
      const source: MeetingSource | null = label === "mic" || layout === "mic" ? "mic" : label === "system" || layout === "system" ? "system" : null;
      if (!source || !intentionalEmptySources.has(source)) throw new Error("Meeting recording is missing an audio source");
      filters.push(`anullsrc=r=${SAMPLE_RATE}:cl=mono,atrim=end_sample=${frameCount},asetpts=PTS-STARTPTS[${label}]`);
      return;
    }
    filters.push(`${indexes.map((i) => `[a${i}]`).join("")}amix=inputs=${indexes.length}:duration=longest:dropout_transition=0:normalize=0,apad=whole_len=${frameCount},atrim=end_sample=${frameCount}[${label}]`);
  };
  if (layout === "stereo") {
    mix(inputs.flatMap((input, i) => input.source === "mic" ? [i] : []), "mic");
    mix(inputs.flatMap((input, i) => input.source === "system" ? [i] : []), "system");
    filters.push("[mic][system]join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR[out]");
  } else {
    mix(inputs.map((_, i) => i), "out");
  }
  const args: string[] = ["-hide_banner", "-loglevel", "error"];
  for (const file of paths) {
    args.push("-i", file);
  }
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[out]",
    "-ar", String(SAMPLE_RATE),
    "-ac", layout === "stereo" ? "2" : "1",
    "-c:a", "pcm_s16le",
    "-y", outputPath
  );

  return new Promise((resolve, reject) => {
    let process: ChildProcess;
    try {
      process = (deps.spawn ?? spawnChild)(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      process.kill("SIGKILL");
    };
    signal?.addEventListener("abort", abort, { once: true });
    process.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    process.on("error", (error) => finish(error));
    process.on("close", (code) => {
      if (signal?.aborted) finish(createAbortError());
      else if (code !== 0) finish(new Error(`Meeting audio mixer failed${stderr ? `: ${stderr.trim()}` : ""}`));
      else finish();
    });
  });
}

function inspectPcmWav(
  filePath: string,
  expectedFrames: number,
  deps: MeetingAudioMixerDeps,
  channels = 1
): { sizeBytes: number } {
  const stats = (deps.stat ?? fs.statSync)(filePath);
  if (!stats.isFile() || stats.size < 44) throw new Error("Meeting audio mixer produced an invalid WAV");
  const header = (deps.readHeader ?? readHeader)(filePath);
  if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Meeting audio mixer produced an invalid WAV");
  }
  let offset = 12;
  let format: { encoding: number; channels: number; sampleRate: number; bits: number } | null = null;
  let dataBytes: number | null = null;
  while (offset + 8 <= header.length) {
    const id = header.toString("ascii", offset, offset + 4);
    const chunkSize = header.readUInt32LE(offset + 4);
    if (id === "fmt " && chunkSize >= 16 && offset + 24 <= header.length) {
      format = {
        encoding: header.readUInt16LE(offset + 8),
        channels: header.readUInt16LE(offset + 10),
        sampleRate: header.readUInt32LE(offset + 12),
        bits: header.readUInt16LE(offset + 22),
      };
    }
    if (id === "data") {
      dataBytes = chunkSize;
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (
    !format || format.encoding !== 1 || format.channels !== channels || format.sampleRate !== SAMPLE_RATE ||
    format.bits !== 16 || dataBytes !== expectedFrames * BYTES_PER_FRAME * channels ||
    stats.size < dataBytes + 44
  ) {
    throw new Error("Meeting audio mixer produced a WAV with unexpected PCM format or duration");
  }
  return { sizeBytes: stats.size };
}

function readHeader(filePath: string): Buffer {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(WAV_HEADER_LIMIT);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function getAvailableBytes(directory: string): number {
  const stat = fs.statfsSync(directory);
  return stat.bavail * stat.bsize;
}
