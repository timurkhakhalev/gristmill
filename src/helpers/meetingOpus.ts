import fs from "fs";
import path from "path";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "child_process";
import { getFFmpegPath } from "./ffmpegUtils.js";

export const MEETING_OPUS_ARGS = [
  "-c:a",
  "libopus",
  "-b:a",
  "32k",
  "-vbr",
  "on",
  "-application",
  "voip",
  "-compression_level",
  "0",
  "-page_duration",
  "250000",
];

const MAX_PENDING_FRAMES = 24_000 * 5;

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index << 24;

  for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);

  return crc >>> 0;
});

/** Ogg granules count 48 kHz samples, including the Opus encoder pre-skip. */
export class OpusPages {
  private buffer = Buffer.alloc(0);
  private serial: number | null = null;
  private sequence = 0;
  private preSkip: number | null = null;
  frameCount = 0;
  completeBytes = 0;
  ended = false;

  push(chunk: Buffer, accept: (page: Buffer) => void = () => {}): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 27) {
      const header = this.buffer;

      if (header.toString("ascii", 0, 4) !== "OggS" || header[4] !== 0 || this.ended)
        throw new Error("Invalid Opus page");
      const segments = header[26];

      if (header.length < 27 + segments) return;

      const bodyBytes = header
        .subarray(27, 27 + segments)
        .reduce((total, value) => total + value, 0);

      const pageBytes = 27 + segments + bodyBytes;

      if (header.length < pageBytes) return;
      const page = header.subarray(0, pageBytes);
      let crc = 0;

      for (let i = 0; i < page.length; i++) {
        const byte = i >= 22 && i < 26 ? 0 : page[i];
        crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ byte) & 255]) >>> 0;
      }

      if (crc !== page.readUInt32LE(22) || page.readUInt32LE(18) !== this.sequence)
        throw new Error("Corrupt Opus page");
      const serial = page.readUInt32LE(14);

      if (this.serial !== null && serial !== this.serial) throw new Error("Unexpected Opus stream");

      if (this.sequence === 0) {
        const head = page.subarray(27 + segments);

        if (
          !(page[5] & 2) ||
          head.length < 19 ||
          head.toString("ascii", 0, 8) !== "OpusHead" ||
          head[9] !== 1 ||
          head[18] !== 0
        )
          throw new Error("Invalid mono Opus header");
        this.preSkip = head.readUInt16LE(10);
      }

      const granule = page.readBigInt64LE(6);

      if (granule >= 0 && this.preSkip !== null) {
        const frames = Number(
          granule > BigInt(this.preSkip) ? (granule - BigInt(this.preSkip)) / 2n : 0n
        );

        if (!Number.isSafeInteger(frames) || frames < this.frameCount)
          throw new Error("Invalid Opus duration");
        this.frameCount = frames;
      }

      accept(page);
      this.serial = serial;
      this.sequence++;
      this.completeBytes += pageBytes;
      this.ended = Boolean(page[5] & 4);
      this.buffer = header.subarray(pageBytes);
    }
  }
}

export interface MeetingOpusInspection {
  frameCount: number;
  ignoredTrailingBytes: number;
  errorCode: string | null;
}

export function inspectMeetingOpus(filePath: string): MeetingOpusInspection {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const pages = new OpusPages();
  let errorCode: string | null = null;

  try {
    const stats = fs.fstatSync(fd);

    if (!stats.isFile()) throw new Error("Invalid Opus file");
    const chunk = Buffer.alloc(64 * 1024);

    for (let position = 0; position < stats.size;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, position);

      if (!count) break;
      position += count;

      try {
        pages.push(chunk.subarray(0, count));
      } catch {
        errorCode = "opus-corrupt";
        break;
      }
    }

    if (!pages.frameCount) errorCode = "empty-epoch";
    else if (!errorCode && !pages.ended) errorCode = "opus-interrupted";
    else if (!errorCode && stats.size !== pages.completeBytes) errorCode = "opus-trailing-data";

    return {
      frameCount: pages.frameCount,
      ignoredTrailingBytes: stats.size - pages.completeBytes,
      errorCode,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export class MeetingOpusWriter {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pages = new OpusPages();
  private readonly settled: Promise<void>;
  private readonly syncTimer: ReturnType<typeof setInterval>;
  private failure: Error | null = null;
  private receivedFrames = 0;
  private closing: Promise<void> | null = null;

  constructor(
    private readonly fd: number,
    private readonly write: (fd: number, page: Buffer) => void
  ) {
    const ffmpeg = getFFmpegPath();

    if (!ffmpeg) throw new Error("FFmpeg is unavailable for meeting capture");
    this.child = spawn(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "s16le",
        "-ar",
        "24000",
        "-ac",
        "1",
        "-probesize",
        "32",
        "-analyzeduration",
        "0",
        "-i",
        "pipe:0",
        ...MEETING_OPUS_ARGS,
        "-flush_packets",
        "1",
        "-f",
        "ogg",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    const fail = () => {
      this.failure ??= new Error("Meeting Opus encoder failed");
      this.child.kill("SIGKILL");
    };

    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        this.pages.push(chunk, (page) => this.write(fd, page));
      } catch {
        fail();
      }
    });
    this.child.stdin.on("error", fail);
    // Drain bounded diagnostics without retaining recording content or paths.
    this.child.stderr.resume();
    this.settled = new Promise((resolve) => {
      this.child.once("error", () => {
        fail();
      });
      this.child.once("close", (code) => {
        if (code !== 0) this.failure ??= new Error("Meeting Opus encoder failed");
        clearInterval(this.syncTimer);
        resolve();
      });
    });
    this.syncTimer = setInterval(() => {
      try {
        fs.fsyncSync(fd);
      } catch {
        fail();
      }
    }, 1000);
    this.syncTimer.unref();
  }

  append(samples: Buffer): void {
    if (this.failure) throw this.failure;

    if (this.closing) throw new Error("Meeting Opus writer is closing");

    if (this.receivedFrames + samples.length / 2 - this.pages.frameCount > MAX_PENDING_FRAMES) {
      this.failure = new Error("Meeting Opus encoder exceeded the 5 second backlog");
      this.child.kill("SIGKILL");
      throw this.failure;
    }

    this.receivedFrames += samples.length / 2;
    this.child.stdin.write(samples);
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.child.stdin.end();

      const timeout = setTimeout(() => {
        this.failure ??= new Error("Meeting Opus encoder did not finish");
        this.child.kill("SIGKILL");
      }, 10_000);

      try {
        await this.settled;

        if (this.failure) throw this.failure;

        if (!this.pages.ended || this.pages.frameCount !== this.receivedFrames)
          throw new Error("Meeting Opus encoder lost audio frames");
      } finally {
        clearTimeout(timeout);
        clearInterval(this.syncTimer);

        try {
          fs.fsyncSync(this.fd);
        } finally {
          fs.closeSync(this.fd);
        }
      }
    })());
  }
}

/** One-time migration only. The runtime never reads PCM source files. */
export function convertMeetingPcm(source: string, destination: string): number {
  const ffmpeg = getFFmpegPath();

  if (!ffmpeg) throw new Error("FFmpeg is unavailable for meeting audio migration");
  const frames = Math.floor(fs.statSync(source).size / 2);

  if (!frames) throw new Error("Cannot migrate an empty PCM epoch");
  const temporary = `${destination}.tmp`;

  try {
    fs.rmSync(temporary, { force: true });
    fs.closeSync(fs.openSync(temporary, "wx", 0o600));
    execFileSync(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "s16le",
        "-ar",
        "24000",
        "-ac",
        "1",
        "-i",
        source,
        "-af",
        `atrim=end_sample=${frames}`,
        ...MEETING_OPUS_ARGS,
        "-f",
        "ogg",
        "-y",
        temporary,
      ],
      { stdio: "ignore", timeout: 600_000 }
    );
    execFileSync(ffmpeg, ["-v", "error", "-xerror", "-i", temporary, "-f", "null", "-"], {
      stdio: "ignore",
      timeout: 600_000,
    });
    const inspected = inspectMeetingOpus(temporary);

    if (inspected.errorCode || inspected.ignoredTrailingBytes || inspected.frameCount !== frames)
      throw new Error("Migrated Opus duration does not match PCM");
    const fd = fs.openSync(temporary, "r");

    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, destination);
    const directory = fs.openSync(path.dirname(destination), "r");

    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }

    return frames;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
