import { spawn as spawnChild, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import type { MeetingRecordingDto, MeetingRecordingEpochDto } from "../contracts/meetingRecording.js";
import type { MeetingRecordingStorage } from "./meetingRecordingStorage.js";
import { createAbortError } from "./abortError.js";
import { getFFmpegPath } from "./ffmpegUtils.js";

const SAMPLE_RATE = 24_000;
const BYTES_PER_FRAME = 2;
const GAIN_PER_TRACK = 0.5;
const WAV_HEADER_LIMIT = 4096;

export interface MeetingAudioMixerDeps {
  ffmpegPath?: () => string | null;
  spawn?: (command: string, args: string[], options: { stdio: ["ignore", "ignore", "pipe"] }) => ChildProcess;
  availableBytes?: (path: string) => number;
  stat?: (path: string) => fs.Stats;
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
  startFrame: number;
  frameCount: number;
}

export function meetingTimelineFrameCount(
  recording: Pick<MeetingRecordingDto, "startedAt" | "endedAt">,
  epochs: MeetingRecordingEpochDto[]
): number {
  const latestEpochEnd = epochs.reduce(
    (latest, epoch) => Math.max(latest, epoch.startFrame + epoch.frameCount),
    0
  );
  const startedAt = Date.parse(recording.startedAt);
  const endedAt = recording.endedAt ? Date.parse(recording.endedAt) : NaN;
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) {
    throw new Error("Meeting recording timeline is invalid");
  }
  const captureEnd = Math.max(0, Math.round((endedAt - startedAt) * SAMPLE_RATE / 1000));
  return Math.max(latestEpochEnd, captureEnd);
}

export async function prepareMeetingAudio(
  storage: MeetingRecordingStorage,
  recording: MeetingRecordingDto,
  runId: string,
  epochs: MeetingRecordingEpochDto[],
  options: { signal?: AbortSignal; deps?: MeetingAudioMixerDeps } = {}
): Promise<PreparedMeetingAudio> {
  const deps = options.deps ?? {};
  const ffmpegPath = (deps.ffmpegPath ?? getFFmpegPath)();
  if (!ffmpegPath) throw new Error("FFmpeg is unavailable");
  const frameCount = meetingTimelineFrameCount(recording, epochs);
  if (frameCount <= 0) throw new Error("Meeting recording has no audio frames");

  const inputs: EpochInput[] = epochs
    .filter((epoch) => epoch.frameCount > 0)
    .map((epoch) => ({
      path: storage.getEpochFilePath(epoch.recordingId, epoch.source, epoch.epochIndex),
      startFrame: epoch.startFrame,
      frameCount: epoch.frameCount,
    }));
  if (!inputs.length) throw new Error("Meeting recording has no usable audio epochs");
  for (const epoch of epochs) {
    if (epoch.state === "open") throw new Error("Meeting recording has an unfinalized audio epoch");
  }
  for (const input of inputs) {
    if ((deps.stat ?? fs.statSync)(input.path).size !== input.frameCount * BYTES_PER_FRAME) {
      throw new Error("Meeting recording audio epoch size does not match its saved timeline");
    }
  }

  const finalPath = storage.getDerivedAudioPath(recording.id, runId);
  if ((deps.exists ?? fs.existsSync)(finalPath)) {
    const existing = inspectPcmWav(finalPath, frameCount, deps);
    return { path: finalPath, frameCount, durationSeconds: frameCount / SAMPLE_RATE, sizeBytes: existing.sizeBytes };
  }

  const tempPath = storage.getDerivedAudioTempPath(recording.id, runId);
  const estimatedBytes = frameCount * BYTES_PER_FRAME + 44;
  const availableBytes = (deps.availableBytes ?? getAvailableBytes)(path.dirname(finalPath));
  if (availableBytes < estimatedBytes) throw new Error("Insufficient disk space for meeting audio preparation");

  try {
    await runMixer(ffmpegPath, inputs, frameCount, tempPath, options.signal, deps);
    const inspected = inspectPcmWav(tempPath, frameCount, deps);
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
  deps: MeetingAudioMixerDeps
): Promise<void> {
  if (signal?.aborted) return Promise.reject(createAbortError());
  const filters = inputs.map((input, index) =>
    `[${index}:a]adelay=${input.startFrame}S:all=1,volume=${GAIN_PER_TRACK}[a${index}]`
  );
  const labels = inputs.map((_, index) => `[a${index}]`).join("");
  filters.push(`${labels}amix=inputs=${inputs.length}:duration=longest:dropout_transition=0:normalize=0,apad=whole_len=${frameCount},atrim=end_sample=${frameCount}[out]`);
  const args: string[] = ["-hide_banner", "-loglevel", "error"];
  for (const input of inputs) {
    args.push("-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-i", input.path);
  }
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[out]",
    "-ar", String(SAMPLE_RATE),
    "-ac", "1",
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
  deps: MeetingAudioMixerDeps
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
    !format || format.encoding !== 1 || format.channels !== 1 || format.sampleRate !== SAMPLE_RATE ||
    format.bits !== 16 || dataBytes !== expectedFrames * BYTES_PER_FRAME ||
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
