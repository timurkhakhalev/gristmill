import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { MeetingRecordingEpochDto, MeetingSource } from "../contracts/meetingRecording.js";
import { meetingTimelineFrameCount } from "./meetingAudioMixer.js";
import type { MeetingRecordingDto } from "../contracts/meetingRecording.js";
import type { MeetingRecordingStorage } from "./meetingRecordingStorage.js";

const SAMPLE_RATE = 24_000;
const BYTES_PER_FRAME = 2;
const HEADER_BYTES = 44;

export function exportMeetingSourceTrack(
  storage: MeetingRecordingStorage,
  recording: MeetingRecordingDto,
  source: MeetingSource,
  epochs: MeetingRecordingEpochDto[],
  destination: string
): void {
  const frameCount = meetingTimelineFrameCount(recording, epochs);
  const dataBytes = frameCount * BYTES_PER_FRAME;
  if (frameCount < 1 || dataBytes + 36 > 0xffff_ffff) {
    throw new Error("Meeting recording timeline cannot be exported as WAV");
  }
  const sourceEpochs = epochs.filter((epoch) => epoch.source === source && epoch.frameCount > 0);
  if (!sourceEpochs.length) throw new Error("Selected meeting audio track is unavailable");

  const tempPath = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    writeAllSync(fd, makeWavHeader(dataBytes), 0);
    fs.ftruncateSync(fd, HEADER_BYTES + dataBytes);
    for (const epoch of sourceEpochs) {
      if (epoch.state === "open") throw new Error("Meeting recording has an unfinalized audio epoch");
      const samples = storage.readEpochSamples(recording.id, source, epoch.epochIndex);
      if (samples.length !== epoch.frameCount * BYTES_PER_FRAME) {
        throw new Error("Meeting recording audio epoch size does not match its saved timeline");
      }
      writeAllSync(fd, samples, HEADER_BYTES + epoch.startFrame * BYTES_PER_FRAME);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, destination);
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw error;
  }
}

export function copyMeetingAudioExport(sourcePath: string, destination: string): void {
  const tempPath = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fs.copyFileSync(sourcePath, tempPath, fs.constants.COPYFILE_EXCL);
    fd = fs.openSync(tempPath, fs.constants.O_WRONLY);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, destination);
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(tempPath, { force: true }); } catch {}
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

function writeAllSync(fd: number, buffer: Buffer, startPosition: number): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, startPosition + offset);
    if (written <= 0) throw new Error("Meeting audio export write failed");
    offset += written;
  }
}
