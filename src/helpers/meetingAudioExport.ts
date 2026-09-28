import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import type { MeetingRecordingEpochDto, MeetingSource } from "../contracts/meetingRecording.js";
import { meetingTimelineFrameCount } from "./meetingAudioMixer.js";
import type { MeetingRecordingDto, MeetingProcessingRunDto } from "../contracts/meetingRecording.js";
import type { MeetingRecordingStorage } from "./meetingRecordingStorage.js";
import { createAbortError } from "./abortError.js";
import { getFFmpegPath } from "./ffmpegUtils.js";

const SAMPLE_RATE = 24_000;
const BYTES_PER_FRAME = 2;
const HEADER_BYTES = 44;
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
  return {
    run<T>(recordingId: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const controller = new AbortController();
      let operations = active.get(recordingId);
      if (!operations) {
        operations = new Set();
        active.set(recordingId, operations);
      }
      const operation = Promise.resolve().then(() => task(controller.signal));
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
  const frameCount = meetingTimelineFrameCount(recording, epochs);
  const dataBytes = frameCount * BYTES_PER_FRAME;
  if (frameCount < 1 || dataBytes + 36 > 0xffff_ffff) {
    throw new Error("Meeting recording timeline cannot be exported as WAV");
  }
  const sourceEpochs = epochs.filter((epoch) => epoch.source === source && epoch.frameCount > 0);
  if (!sourceEpochs.length) throw new Error("Selected meeting audio track is unavailable");

  const tempPath = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  let output: fs.promises.FileHandle | null = null;
  try {
    throwIfAborted(signal);
    output = await fs.promises.open(tempPath, "wx", 0o600);
    await writeAll(output, makeWavHeader(dataBytes), 0, signal);
    await output.truncate(HEADER_BYTES + dataBytes);
    for (const epoch of sourceEpochs) {
      throwIfAborted(signal);
      if (epoch.state === "open") throw new Error("Meeting recording has an unfinalized audio epoch");
      const expectedBytes = epoch.frameCount * BYTES_PER_FRAME;
      const reader = await storage.openEpochReader(recording.id, source, epoch.epochIndex);
      try {
        const stats = await reader.stat();
        if (stats.size !== expectedBytes && stats.size !== expectedBytes + 1) {
          throw new Error("Meeting recording audio epoch size does not match its saved timeline");
        }
        for (let epochOffset = 0; epochOffset < expectedBytes;) {
          throwIfAborted(signal);
          const length = Math.min(EXPORT_CHUNK_BYTES, expectedBytes - epochOffset);
          const chunk = Buffer.allocUnsafe(length);
          await readAll(reader, chunk, epochOffset, signal);
          await writeAll(
            output,
            chunk,
            HEADER_BYTES + epoch.startFrame * BYTES_PER_FRAME + epochOffset,
            signal
          );
          epochOffset += length;
        }
      } finally {
        await reader.close();
      }
    }
    throwIfAborted(signal);
    await output.sync();
    await output.close();
    output = null;
    throwIfAborted(signal);
    fs.renameSync(tempPath, destination);
  } catch (error) {
    if (output) {
      try { await output.close(); } catch {}
    }
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    throw error;
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

function makeWavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(dataBytes + 36, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_FRAME, 28);
  header.writeUInt16LE(BYTES_PER_FRAME, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
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
