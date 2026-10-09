import { z } from "zod";

import { spawn as spawnChild, type ChildProcess } from "child_process";
import fs from "fs";
import { inspectMeetingOpus } from "./meetingOpus.js";
import path from "path";
import type {
  MeetingRecordingDto,
  MeetingRecordingEpochDto,
  MeetingIntentionalInterval,
  MeetingSource,
} from "../contracts/meetingRecording.js";
import type { MeetingRecordingStorage } from "./meetingRecordingStorage.js";
import { createAbortError } from "./abortError.js";
import { getFFmpegPath } from "./ffmpegUtils.js";

import { resolveBundledBinary } from "./binaryResolver.js";
import {
  meetingResamplerManifest,
  meetingResamplerMappingText,
  type MeetingResamplerManifest,
} from "./meetingResamplerMapping.js";

import { alignedAudioRanges } from "./meetingAudioAlignment.js";

const SAMPLE_RATE = 24_000;

const BYTES_PER_FRAME = 2;

export type MeetingAudioLayout = "mono" | "stereo" | "mic" | "system";

const WAV_HEADER_LIMIT = 4096;

export interface MeetingAudioMixerDeps {
  ffmpegPath?: () => string | null;
  spawn?: (
    command: string,
    args: string[],
    options: { stdio: ["ignore", "ignore", "pipe"]; detached: true }
  ) => ChildProcess;
  resamplerPath?: () => string | null;
  availableBytes?: (path: string) => number;
  stat?: (path: string) => fs.Stats;
  inspectEpoch?: typeof inspectMeetingOpus;
  readHeader?: (path: string) => Buffer;
  exists?: (path: string) => boolean;
  remove?: (path: string, options?: { force: boolean }) => void;
  rename?: (oldPath: string, newPath: string) => void;
}

export interface PreparedMeetingAudio {
  path: string;
  frameCount: number;
  durationSeconds: number;
  sizeBytes: number;
}

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

export function meetingSourceIntentionallyEmpty(
  recording: MeetingRecordingDto,
  epochs: MeetingRecordingEpochDto[],
  intervals: MeetingIntentionalInterval[],
  source: MeetingSource
): boolean {
  if (epochs.some((epoch) => epoch.source === source && epoch.frameCount > 0)) return false;

  // An intent held for the entire capture proves silence without a clock mapping.
  // Partial mute intervals still require aligned coverage below.
  // sourceMetadata is this pipeline's free-form JSON; the schema is its parse.
  const metadata = z
    .object({ intentionallyEmpty: z.boolean() })
    .partial()
    .nullish()
    .catch(null)
    .parse(recording.sourceMetadata[source]);

  if (metadata && "intentionallyEmpty" in metadata && metadata.intentionallyEmpty !== undefined)
    return metadata.intentionallyEmpty;
  const frameCount = meetingTimelineFrameCount(recording, epochs);

  if (frameCount <= 0) return false;
  let coveredThrough = 0;

  for (const interval of intervals
    .filter((value) => value.source === source)
    .sort((a, b) => (a.timelineStartFrame ?? Infinity) - (b.timelineStartFrame ?? Infinity))) {
    if (
      interval.timelineEndFrame === null ||
      interval.timelineStartFrame === null ||
      interval.timelineStartFrame > coveredThrough
    )
      return false;
    coveredThrough = Math.max(coveredThrough, interval.timelineEndFrame);

    if (coveredThrough >= frameCount) return true;
  }

  return false;
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

export async function prepareMeetingAudio(
  storage: MeetingRecordingStorage,
  recording: MeetingRecordingDto,
  runId: string,
  epochs: MeetingRecordingEpochDto[],
  options: {
    signal?: AbortSignal;
    deps?: MeetingAudioMixerDeps;
    layout?: MeetingAudioLayout;
    intentionalEmptySources?: MeetingSource[];
  } = {}
): Promise<PreparedMeetingAudio> {
  return prepareMeetingAudioWithTimeline(
    storage,
    recording,
    runId,
    epochs,
    meetingTimelineFrameCount(recording, epochs),
    options
  );
}

/** Source export requires full alignment of the selected track, not its peer. */
export async function prepareMeetingSourceExportAudio(
  storage: MeetingRecordingStorage,
  recording: MeetingRecordingDto,
  runId: string,
  source: MeetingSource,
  epochs: MeetingRecordingEpochDto[],
  options: { signal?: AbortSignal; deps?: MeetingAudioMixerDeps } = {}
): Promise<PreparedMeetingAudio> {
  // Validate chosen coverage before the duration reader skips unknown peers.
  for (const epoch of epochs.filter((item) => item.source === source)) alignedAudioRanges(epoch);
  // Keep common saved extent and fully proven peer ends, including trailing
  // silence. An unresolved peer supplies neither an offset nor an endpoint.
  const frameCount = meetingTimelineFrameCount(recording, epochs, true);

  return prepareMeetingAudioWithTimeline(storage, recording, runId, epochs, frameCount, {
    ...options,
    layout: source,
  });
}

async function prepareMeetingAudioWithTimeline(
  storage: MeetingRecordingStorage,
  recording: MeetingRecordingDto,
  runId: string,
  epochs: MeetingRecordingEpochDto[],
  frameCount: number,
  options: {
    signal?: AbortSignal;
    deps?: MeetingAudioMixerDeps;
    layout?: MeetingAudioLayout;
    intentionalEmptySources?: MeetingSource[];
  }
): Promise<PreparedMeetingAudio> {
  if (options.signal?.aborted) throw createAbortError();

  const deps = options.deps ?? {};
  const layout = options.layout ?? "mono";
  const channels = layout === "stereo" ? 2 : 1;
  const ffmpegPath = (deps.ffmpegPath ?? getFFmpegPath)();

  if (!ffmpegPath) throw new Error("FFmpeg is unavailable");

  if (frameCount <= 0) throw new Error("Meeting recording has no audio frames");

  const selectedEpochs = epochs.filter(
    (epoch) =>
      epoch.frameCount > 0 && ((layout !== "mic" && layout !== "system") || epoch.source === layout)
  );

  for (const epoch of selectedEpochs) alignedAudioRanges(epoch);

  const intentionalEmptySources = new Set(options.intentionalEmptySources ?? []);

  if (
    !selectedEpochs.length &&
    !(
      (layout === "mic" && intentionalEmptySources.has("mic")) ||
      (layout === "system" && intentionalEmptySources.has("system"))
    )
  ) {
    throw new Error("Meeting recording has no usable audio epochs");
  }

  for (const epoch of epochs) {
    if (epoch.state === "open") throw new Error("Meeting recording has an unfinalized audio epoch");
  }

  const inspectedPaths = new Set<string>();

  for (const epoch of selectedEpochs) {
    const inputPath = storage.getEpochFilePath(epoch.recordingId, epoch.source, epoch.epochIndex);

    if (inspectedPaths.has(inputPath)) continue;
    inspectedPaths.add(inputPath);

    if ((deps.inspectEpoch ?? inspectMeetingOpus)(inputPath).frameCount !== epoch.frameCount) {
      throw new Error("Meeting recording audio epoch duration does not match its saved timeline");
    }
  }

  const finalPath = storage.getDerivedAudioPath(recording.id, runId, layout);

  if ((deps.exists ?? fs.existsSync)(finalPath)) {
    const existing = inspectPcmWav(finalPath, frameCount, deps, channels);

    if (options.signal?.aborted) throw createAbortError();

    return {
      path: finalPath,
      frameCount,
      durationSeconds: frameCount / SAMPLE_RATE,
      sizeBytes: existing.sizeBytes,
    };
  }

  const sources: MeetingSource[] =
    layout === "mic" || layout === "system"
      ? [layout]
      : ["mic", "system"].filter(
          (source): source is MeetingSource =>
            layout === "stereo" || selectedEpochs.some((epoch) => epoch.source === source)
        );

  const manifests = sources.map((source) => {
    const own = selectedEpochs.filter((epoch) => epoch.source === source);

    if (!own.length && !intentionalEmptySources.has(source))
      throw new Error("Meeting recording is missing an audio source");

    return meetingResamplerManifest(
      source,
      own,
      () => "",
      frameCount,
      intentionalEmptySources.has(source)
    );
  });

  // Each source retains one decoded epoch and mapping while its full timeline exists.
  // Both timelines coexist with final WAV assembly after decoded epochs are removed.
  const timelineBytes =
    manifests.filter((manifest) => manifest.epochs.length).length * frameCount * 4;

  const decodedPeak = manifests.reduce(
    (total, manifest) =>
      total +
      manifest.epochs.reduce(
        (largest, epoch) =>
          Math.max(
            largest,
            epoch.inputFrames * 4 + Buffer.byteLength(meetingResamplerMappingText(epoch.rows))
          ),
        0
      ),
    0
  );

  const estimatedBytes =
    timelineBytes +
    Math.max(decodedPeak, frameCount * BYTES_PER_FRAME * channels + WAV_HEADER_LIMIT);

  const tempPath = storage.getDerivedAudioTempPath(recording.id, runId, layout);

  try {
    const availableBytes = (deps.availableBytes ?? getAvailableBytes)(path.dirname(finalPath));

    if (availableBytes < estimatedBytes) throw preparationError(true);

    if (options.signal?.aborted) throw createAbortError();

    const resamplerPath = (
      deps.resamplerPath ?? (() => resolveBundledBinary("meeting-resampler"))
    )();

    if (!resamplerPath)
      throw preparationError(
        false,
        "Local audio preparation is unavailable. Reinstall or rebuild Gristmill."
      );

    const workingDirectory = storage.createDerivedAudioWorkingDirectory(
      recording.id,
      runId,
      layout
    );

    try {
      for (const manifest of manifests) {
        for (const [index, epoch] of manifest.epochs.entries())
          epoch.inputPath = path.join(workingDirectory, `${manifest.source}-${index}.f32`);
      }

      await runMixer(
        storage,
        ffmpegPath,
        resamplerPath,
        manifests,
        frameCount,
        tempPath,
        workingDirectory,
        options.signal,
        deps,
        layout
      );
    } finally {
      storage.removeDerivedAudioWorkingDirectory(recording.id, runId, workingDirectory);
    }

    const inspected = inspectPcmWav(tempPath, frameCount, deps, channels);

    if (options.signal?.aborted) throw createAbortError();
    (deps.rename ?? fs.renameSync)(tempPath, finalPath);

    return {
      path: finalPath,
      frameCount,
      durationSeconds: frameCount / SAMPLE_RATE,
      sizeBytes: inspected.sizeBytes,
    };
  } catch (error) {
    try {
      (deps.remove ?? fs.rmSync)(tempPath, { force: true });
    } catch {
      // A partial temporary file is never used as input.
    }

    if (options.signal?.aborted) throw createAbortError();
    const code = z.object({ code: z.string() }).partial().nullish().catch(null).parse(error)?.code;

    if (code === "ENOSPC") throw preparationError(true);

    if (code === "audio-preparation-failed" || code === "audio-preparation-disk-full") throw error;
    throw preparationError(
      false,
      "Could not prepare the saved audio. Check local storage and retry.",
      error instanceof Error ? error : undefined
    );
  }
}

function preparationError(
  diskFull: boolean,
  message = "Could not prepare the saved audio. Retry or reinstall Gristmill.",
  cause?: Error
): Error {
  return Object.assign(
    new Error(
      diskFull
        ? "Insufficient disk space for meeting audio preparation. Free disk space and retry."
        : message,
      { cause }
    ),
    {
      code: diskFull ? "audio-preparation-disk-full" : "audio-preparation-failed",
    }
  );
}

async function runMixer(
  storage: MeetingRecordingStorage,
  ffmpegPath: string,
  resamplerPath: string,
  manifests: MeetingResamplerManifest[],
  frameCount: number,
  outputPath: string,
  workingDirectory: string,
  signal: AbortSignal | undefined,
  deps: MeetingAudioMixerDeps,
  layout: MeetingAudioLayout
): Promise<void> {
  const children = new Set<ChildProcess>();
  const stoppedChildren = new WeakSet<ChildProcess>();
  let firstError: Error | undefined;

  const stop = (error: Error) => {
    firstError ??= error;

    for (const child of children) {
      if (stoppedChildren.has(child)) continue;
      stoppedChildren.add(child);

      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // A child can have exited before its close event; settlement still waits below.
      }
    }
  };

  const abort = () => stop(createAbortError());
  signal?.addEventListener("abort", abort, { once: true });

  if (signal?.aborted) abort();

  const run = (
    command: string,
    args: string[],
    phase: "decode" | "correct" | "assemble"
  ): Promise<void> => {
    if (firstError) return Promise.reject(firstError);

    return new Promise((resolve, reject) => {
      let child: ChildProcess;

      try {
        child = (deps.spawn ?? spawnChild)(command, args, {
          stdio: ["ignore", "ignore", "pipe"],
          detached: true,
        });
      } catch (error) {
        stop(
          preparationError(
            false,
            "Could not start local audio preparation. Reinstall or rebuild Gristmill.",
            error instanceof Error ? error : undefined
          )
        );
        reject(firstError);

        return;
      }

      children.add(child);
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-2000);
      });
      child.on("error", (error: Error) =>
        stop(
          preparationError(
            false,
            "Could not run local audio preparation. Reinstall or rebuild Gristmill.",
            error
          )
        )
      );
      child.on("close", (code) => {
        children.delete(child);

        if (!firstError && code !== 0) {
          const diskFull = /(?:errno=28\b|No space left on device)/i.test(stderr);

          const message =
            phase === "correct" && code === 3
              ? "Decoded audio does not match the saved recording. Retry preparation."
              : "Could not prepare the saved audio. Check local storage and retry.";

          stop(preparationError(diskFull, message, stderr ? new Error(stderr.trim()) : undefined));
        }

        if (firstError) reject(firstError);
        else resolve();
      });

      if (signal?.aborted) abort();
    });
  };

  const timelines = new Map<MeetingSource, string>();

  try {
    const results = await Promise.allSettled(
      manifests.map(async (manifest) => {
        try {
          if (!manifest.epochs.length) return;
          const timeline = path.join(workingDirectory, `${manifest.source}-timeline.f32`);
          timelines.set(manifest.source, timeline);

          for (const [index, epoch] of manifest.epochs.entries()) {
            if (firstError) throw firstError;
            const decoded = epoch.inputPath;
            const mapping = path.join(workingDirectory, `${manifest.source}-${index}.mapping`);

            const input = storage.getEpochFilePath(
              epoch.recordingId,
              manifest.source,
              epoch.epochIndex
            );

            try {
              await run(
                ffmpegPath,
                [
                  "-nostdin",
                  "-hide_banner",
                  "-loglevel",
                  "error",
                  "-i",
                  input,
                  "-ar",
                  String(SAMPLE_RATE),
                  "-ac",
                  "1",
                  "-c:a",
                  "pcm_f32le",
                  "-f",
                  "f32le",
                  "-y",
                  decoded,
                ],
                "decode"
              );
              fs.writeFileSync(mapping, meetingResamplerMappingText(epoch.rows), {
                flag: "wx",
                mode: 0o600,
              });
              await run(
                resamplerPath,
                [
                  decoded,
                  mapping,
                  timeline,
                  String(frameCount),
                  String(epoch.inputFrames),
                  index ? "add" : "create",
                ],
                "correct"
              );
            } finally {
              fs.rmSync(decoded, { force: true });
              fs.rmSync(mapping, { force: true });
            }
          }
        } catch (error) {
          stop(error instanceof Error ? error : preparationError(false));
          throw error;
        }
      })
    );

    const rejected = results.find((result) => result.status === "rejected");

    if (rejected?.status === "rejected") throw firstError ?? rejected.reason;
    const args = ["-nostdin", "-hide_banner", "-loglevel", "error"];
    const filters: string[] = [];
    const labels = new Map<MeetingSource, string>();

    for (const manifest of manifests) {
      const timeline = timelines.get(manifest.source);

      if (timeline) {
        const inputIndex = labels.size;
        args.push("-f", "f32le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-i", timeline);
        labels.set(manifest.source, `${inputIndex}:a`);
      }
    }

    const sourceLabel = (source: MeetingSource) => {
      const label = labels.get(source);

      if (label) return `[${label}]`;
      filters.push(
        `anullsrc=r=${SAMPLE_RATE}:cl=mono,atrim=end_sample=${frameCount},asetpts=PTS-STARTPTS[${source}]`
      );

      return `[${source}]`;
    };

    if (layout === "stereo") {
      filters.push(
        `${sourceLabel("mic")}${sourceLabel("system")}join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR[out]`
      );
    } else if (layout === "mic" || layout === "system") {
      filters.push(`${sourceLabel(layout)}anull[out]`);
    } else {
      filters.push(
        `${[...labels.values()].map((label) => `[${label}]`).join("")}amix=inputs=${labels.size}:duration=longest:dropout_transition=0:normalize=0,volume=0.5[out]`
      );
    }

    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[out]",
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      layout === "stereo" ? "2" : "1",
      "-c:a",
      "pcm_s16le",
      "-y",
      outputPath
    );
    await run(ffmpegPath, args, "assemble");
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

interface PcmWavInspection {
  sizeBytes: number;
}

function inspectPcmWav(
  filePath: string,
  expectedFrames: number,
  deps: MeetingAudioMixerDeps,
  channels = 1
): PcmWavInspection {
  const stats = (deps.stat ?? fs.statSync)(filePath);

  if (!stats.isFile() || stats.size < 44)
    throw new Error("Meeting audio mixer produced an invalid WAV");
  const header = (deps.readHeader ?? readHeader)(filePath);

  if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Meeting audio mixer produced an invalid WAV");
  }

  let offset = 12;

  let format: { encoding: number; channels: number; sampleRate: number; bits: number } | null =
    null;

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
    !format ||
    format.encoding !== 1 ||
    format.channels !== channels ||
    format.sampleRate !== SAMPLE_RATE ||
    format.bits !== 16 ||
    dataBytes !== expectedFrames * BYTES_PER_FRAME * channels ||
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
