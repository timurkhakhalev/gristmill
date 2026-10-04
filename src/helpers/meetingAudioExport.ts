import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import type { MeetingRecordingEpochDto, MeetingSource } from "../contracts/meetingRecording.js";
import { prepareMeetingAudio } from "./meetingAudioMixer.js";
import type { MeetingRecordingDto, MeetingProcessingRunDto } from "../contracts/meetingRecording.js";
import type { MeetingRecordingStorage } from "./meetingRecordingStorage.js";
import { createAbortError } from "./abortError.js";
import { getFFmpegPath } from "./ffmpegUtils.js";

const EXPORT_CHUNK_BYTES = 256 * 1024;
const execFileAsync = promisify(execFile);

export async function exportMeetingMixedMp3(sourcePath: string, destination: string, signal?: AbortSignal): Promise<void> {
  const ffmpeg = getFFmpegPath();
  if (!ffmpeg) throw new Error("FFmpeg is unavailable");
  const tempPath = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  try {
    if (signal?.aborted) throw createAbortError();
    await execFileAsync(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", sourcePath,
      "-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3", "-y", tempPath], { signal });
    if (signal?.aborted) throw createAbortError();
    await fs.promises.rename(tempPath, destination);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true });
    throw error;
  }
}

interface MeetingAudioOperation {
  settled: Promise<void>;
  abort: () => void;
}

export function createMeetingAudioOperationRegistry() {
  const active = new Map<string, Set<MeetingAudioOperation>>();
  let stopped = false;
  return {
    run<T>(recordingId: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (stopped) return Promise.reject(new Error("Meeting audio operations are stopped"));
      const controller = new AbortController();
      let operations = active.get(recordingId);
      if (!operations) {
        operations = new Set();
        active.set(recordingId, operations);
      }
      const operation = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return task(controller.signal);
      });
      const entry: MeetingAudioOperation = {
        abort: () => controller.abort(),
        settled: operation.then(() => undefined, () => undefined).finally(() => {
          operations?.delete(entry);
          if (operations?.size === 0) active.delete(recordingId);
        }),
      };
      operations.add(entry);
      return operation;
    },
    async stop(): Promise<void> {
      stopped = true;
      const operations = [...active.values()].flatMap((entries) => [...entries]);
      for (const operation of operations) operation.abort();
      await Promise.all(operations.map(({ settled }) => settled));
    },
    async cancelAndWait(recordingId: string): Promise<void> {
      const operations = [...(active.get(recordingId) ?? [])];
      for (const operation of operations) operation.abort();
      await Promise.all(operations.map(({ settled }) => settled));
    },
  };
}

export function canPlayMeetingRun(
  recording: Pick<MeetingRecordingDto, "id" | "audioState">,
  run: Pick<MeetingProcessingRunDto, "recordingId" | "hasTranscript">
): boolean {
  return recording.audioState === "available" && run.recordingId === recording.id && run.hasTranscript;
}

export async function exportMeetingSourceTrack(
  storage: MeetingRecordingStorage,
  recording: MeetingRecordingDto,
  source: MeetingSource,
  epochs: MeetingRecordingEpochDto[],
  destination: string,
  signal?: AbortSignal
): Promise<void> {
  const id = randomUUID();
  try {
    const audio = await prepareMeetingAudio(storage, recording, id, epochs, { signal, layout: source });
    await copyMeetingAudioExport(audio.path, destination, signal);
  } finally {
    storage.removeDerivedAudio(recording.id, id);
  }
}

export async function copyMeetingAudioExport(
  sourcePath: string,
  destination: string,
  signal?: AbortSignal
): Promise<void> {
  const tempPath = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  let source: fs.promises.FileHandle | null = null;
  let output: fs.promises.FileHandle | null = null;
  try {
    throwIfAborted(signal);
    source = await fs.promises.open(sourcePath, fs.constants.O_RDONLY | noFollowFlag());
    const stats = await source.stat();
    if (!stats.isFile()) throw new Error("Meeting audio export source is not a file");
    output = await fs.promises.open(tempPath, "wx", 0o600);
    for (let position = 0; position < stats.size;) {
      throwIfAborted(signal);
      const length = Math.min(EXPORT_CHUNK_BYTES, stats.size - position);
      const chunk = Buffer.allocUnsafe(length);
      await readAll(source, chunk, position, signal);
      await writeAll(output, chunk, position, signal);
      position += length;
    }
    await source.close();
    source = null;
    throwIfAborted(signal);
    await output.sync();
    await output.close();
    output = null;
    throwIfAborted(signal);
    fs.renameSync(tempPath, destination);
  } catch (error) {
    if (source) {
      try { await source.close(); } catch {}
    }
    if (output) {
      try { await output.close(); } catch {}
    }
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function readAll(
  handle: fs.promises.FileHandle,
  buffer: Buffer,
  position: number,
  signal?: AbortSignal
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    throwIfAborted(signal);
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead <= 0) throw new Error("Meeting audio export read failed");
    offset += bytesRead;
  }
}

async function writeAll(
  handle: fs.promises.FileHandle,
  buffer: Buffer,
  position: number,
  signal?: AbortSignal
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    throwIfAborted(signal);
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, position + offset);
    if (bytesWritten <= 0) throw new Error("Meeting audio export write failed");
    offset += bytesWritten;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError();
}

function noFollowFlag(): number {
  return fs.constants.O_NOFOLLOW ?? 0;
}
