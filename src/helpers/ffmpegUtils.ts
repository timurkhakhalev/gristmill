import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import debugLogger from "./debugLogger.js";
import { createAbortError } from "./abortError.js";

let cachedFFmpegPath: string | null = null;

export function getFFmpegPath(): string | null {
  if (cachedFFmpegPath) return cachedFFmpegPath;

  try {
    const ffmpegStaticPath = require("ffmpeg-static") as string;
    let ffmpegPath: string = path.normalize(ffmpegStaticPath as string);

    if (process.platform === "win32" && !ffmpegPath.endsWith(".exe")) {
      ffmpegPath += ".exe";
    }

    // Try unpacked ASAR path first (production builds unpack ffmpeg-static)
    const unpackedPath: string | null = ffmpegPath.includes("app.asar")
      ? ffmpegPath.replace(/app\.asar([/\\])/, "app.asar.unpacked$1")
      : null;

    if (unpackedPath && fs.existsSync(unpackedPath)) {
      if (process.platform !== "win32") {
        try {
          fs.accessSync(unpackedPath, fs.constants.X_OK);
        } catch {
          try {
            fs.chmodSync(unpackedPath, 0o755);
          } catch (chmodErr) {
            debugLogger.warn("Failed to chmod FFmpeg", { error: (chmodErr as Error).message });
          }
        }
      }
      cachedFFmpegPath = unpackedPath;
      return unpackedPath;
    }

    // Try original path (development or if not in ASAR). An in-asar path passes
    // existsSync but can never be spawned, so fall through to system FFmpeg instead.
    if (!unpackedPath && fs.existsSync(ffmpegPath)) {
      if (process.platform !== "win32") {
        try {
          fs.accessSync(ffmpegPath, fs.constants.X_OK);
        } catch {
          debugLogger.debug("FFmpeg exists but not executable", { ffmpegPath });
          throw new Error("Not executable");
        }
      }
      cachedFFmpegPath = ffmpegPath;
      return ffmpegPath;
    }
  } catch (err) {
    debugLogger.debug("Bundled FFmpeg not available", { error: (err as Error).message });
  }

  const systemCandidates: string[] =
    process.platform === "darwin"
      ? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
      : process.platform === "win32"
        ? ["C:\\ffmpeg\\bin\\ffmpeg.exe"]
        : ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"];

  for (const candidate of systemCandidates) {
    if (fs.existsSync(candidate)) {
      cachedFFmpegPath = candidate;
      return candidate;
    }
  }

  const pathEnv = process.env.PATH || "";
  const pathSep = process.platform === "win32" ? ";" : ":";
  const pathDirs = pathEnv.split(pathSep).map((entry) => entry.replace(/^"|"$/g, ""));
  const pathBinary = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = path.join(dir, pathBinary);
    if (!fs.existsSync(candidate)) continue;
    if (process.platform !== "win32") {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
      } catch {
        continue;
      }
    }
    cachedFFmpegPath = candidate;
    return candidate;
  }

  debugLogger.debug("FFmpeg not found");
  return null;
}

export function isWavFormat(buffer: Buffer | null | undefined): boolean {
  if (!buffer || buffer.length < 12) return false;

  return (
    buffer[0] === 0x52 && // R
    buffer[1] === 0x49 && // I
    buffer[2] === 0x46 && // F
    buffer[3] === 0x46 && // F
    buffer[8] === 0x57 && // W
    buffer[9] === 0x41 && // A
    buffer[10] === 0x56 && // V
    buffer[11] === 0x45 // E
  );
}

export interface ConvertToWavOptions {
  sampleRate?: number;
  channels?: number;
  signal?: AbortSignal;
}

export function convertToWav(
  inputPath: string,
  outputPath: string,
  options: ConvertToWavOptions = {}
): Promise<void> {
  const { sampleRate = 16000, channels = 1, signal } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const ffmpegPath = getFFmpegPath();
    if (!ffmpegPath) {
      reject(
        new Error(
          "FFmpeg not found - the bundled FFmpeg is missing from this install and no system FFmpeg was found on PATH; reinstalling Gristmill should fix this"
        )
      );
      return;
    }

    const args = [
      "-i",
      inputPath,
      "-ar",
      String(sampleRate),
      "-ac",
      String(channels),
      "-c:a",
      "pcm_s16le",
      "-y", // Overwrite output file
      outputPath,
    ];

    debugLogger.debug("Converting audio with FFmpeg", {
      input: inputPath,
      output: outputPath,
      sampleRate,
      channels,
    });

    const proc = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stderr = "";
    let settled = false;

    // A cancelled upload kills the child, but the caller only unlinks the
    // temp WAV after this promise settles — so wait for the child to close
    // before rejecting with the abort error.
    const onAbort = () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // an uncaught throw here would escape the abort dispatch
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", (error) => {
      if (settled) return;
      signal?.removeEventListener("abort", onAbort);
      // After an abort the error belongs to the kill; close still fires and
      // must stay the settler, so don't consume the settlement here.
      if (signal?.aborted) return;
      settled = true;
      reject(new Error(`FFmpeg process error: ${error.message}`));
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(createAbortError());
        return;
      }
      if (code !== 0) {
        const stderrPreview = stderr.slice(-500).trim();
        debugLogger.debug("FFmpeg conversion failed", { code, stderr: stderrPreview });
        reject(
          new Error(`FFmpeg exited with code ${code}${stderrPreview ? `: ${stderrPreview}` : ""}`)
        );
        return;
      }

      if (!fs.existsSync(outputPath)) {
        reject(new Error("FFmpeg conversion produced no output file"));
        return;
      }

      const stats = fs.statSync(outputPath);
      if (stats.size === 0) {
        reject(new Error("FFmpeg conversion produced empty output file"));
        return;
      }

      debugLogger.debug("FFmpeg conversion complete", { outputSize: stats.size });
      resolve();
    });
  });
}

export interface WavFormat {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

export function parseWavFormat(wavBuffer: Buffer): WavFormat | null {
  if (!isWavFormat(wavBuffer)) return null;

  let offset = 12; // Skip RIFF header (4) + size (4) + WAVE (4)
  while (offset < wavBuffer.length - 8) {
    const chunkId = wavBuffer.toString("ascii", offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);

    if (chunkId === "fmt ") {
      return {
        audioFormat: wavBuffer.readUInt16LE(offset + 8),
        channels: wavBuffer.readUInt16LE(offset + 10),
        sampleRate: wavBuffer.readUInt32LE(offset + 12),
        bitsPerSample: wavBuffer.readUInt16LE(offset + 22),
      };
    }

    offset += 8 + chunkSize;
  }

  return null;
}

export function wavToFloat32Samples(wavBuffer: Buffer): Buffer {
  if (!isWavFormat(wavBuffer)) {
    throw new Error("Buffer is not a valid WAV file");
  }

  // Parse WAV header to find data chunk
  let offset = 12; // Skip RIFF header (4) + size (4) + WAVE (4)
  let dataOffset = -1;
  let dataSize = 0;
  let bitsPerSample = 16;

  while (offset < wavBuffer.length - 8) {
    const chunkId = wavBuffer.toString("ascii", offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);

    if (chunkId === "fmt ") {
      bitsPerSample = wavBuffer.readUInt16LE(offset + 22);
    } else if (chunkId === "data") {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }

    offset += 8 + chunkSize;
  }

  if (dataOffset < 0) {
    throw new Error("WAV data chunk not found");
  }

  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor(dataSize / bytesPerSample);
  const float32: Buffer = Buffer.alloc(numSamples * 4);

  for (let i = 0; i < numSamples; i++) {
    const sampleOffset = dataOffset + i * bytesPerSample;
    const intVal =
      bitsPerSample === 16 ? wavBuffer.readInt16LE(sampleOffset) : wavBuffer.readInt8(sampleOffset);
    const maxVal = bitsPerSample === 16 ? 32768 : 128;
    float32.writeFloatLE(intVal / maxVal, i * 4);
  }

  return float32;
}

export function computeFloat32RMS(float32Buffer: Buffer): number {
  const numSamples = float32Buffer.length / 4;
  if (numSamples === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < numSamples; i++) {
    const val = float32Buffer.readFloatLE(i * 4);
    sumSquares += val * val;
  }

  return Math.sqrt(sumSquares / numSamples);
}

export function parseFfmpegDuration(stderr: string | null | undefined): number | null {
  const match = stderr?.match(/Duration:\s*(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export interface SplitAudioOptions {
  segmentDuration?: number;
  audioBitrate?: string;
  signal?: AbortSignal;
}

export interface SplitAudioResult {
  chunkPaths: string[];
  durationSeconds: number | null;
}

export function splitAudioFile(
  inputPath: string,
  outputDir: string,
  options: SplitAudioOptions = {}
): Promise<SplitAudioResult> {
  const { segmentDuration = 600, audioBitrate = "128k", signal } = options;

  return new Promise<SplitAudioResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const ffmpegPath = getFFmpegPath();
    if (!ffmpegPath) {
      reject(new Error("FFmpeg not found - required for audio splitting"));
      return;
    }

    const outputPattern = path.join(outputDir, "chunk-%03d.mp3");

    const args = [
      "-i",
      inputPath,
      "-f",
      "segment",
      "-segment_time",
      String(segmentDuration),
      "-c:a",
      "libmp3lame",
      "-b:a",
      audioBitrate,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-y",
      outputPattern,
    ];

    debugLogger.debug("Splitting audio with FFmpeg", {
      input: inputPath,
      outputDir,
      segmentDuration,
      audioBitrate,
    });

    const proc = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stderr = "";

    const onAbort = () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // an uncaught throw here would escape the abort dispatch
      }
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return;
      reject(new Error(`FFmpeg split error: ${error.message}`));
    });

    // The kill lands here as a non-zero exit; returning early keeps a cancel
    // from being logged and reported as an ffmpeg failure.
    proc.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return;
      if (code !== 0) {
        const stderrPreview = stderr.slice(-500).trim();
        debugLogger.debug("FFmpeg split failed", { code, stderr: stderrPreview });
        reject(
          new Error(
            `FFmpeg split exited with code ${code}${stderrPreview ? `: ${stderrPreview}` : ""}`
          )
        );
        return;
      }

      const chunks: string[] = fs
        .readdirSync(outputDir)
        .filter((f) => f.startsWith("chunk-") && f.endsWith(".mp3"))
        .sort()
        .map((f) => path.join(outputDir, f));

      if (chunks.length === 0) {
        reject(new Error("FFmpeg split produced no output files"));
        return;
      }

      const durationSeconds = parseFfmpegDuration(stderr);
      debugLogger.debug("FFmpeg split complete", { chunkCount: chunks.length, durationSeconds });
      resolve({ chunkPaths: chunks, durationSeconds });
    });
  });
}

export interface AudioSegmentBuffer {
  buffer: ArrayBuffer | Uint8Array | Buffer;
  mimeType?: string;
}

function toBuffer(data: AudioSegmentBuffer["buffer"]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data);
}

export async function mergeAudioSegments(segments: AudioSegmentBuffer[]): Promise<Buffer> {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("At least one audio segment is required");
  }
  if (segments.length === 1) return toBuffer(segments[0].buffer);

  const ffmpegPath = getFFmpegPath();
  if (!ffmpegPath) throw new Error("FFmpeg not found - required for audio segment recovery");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-audio-merge-"));
  const outputPath = path.join(tempDir, "merged.webm");
  try {
    const inputPaths: string[] = segments.map((segment, index) => {
      const mimeType = segment.mimeType || "audio/webm";
      const extension = mimeType.includes("ogg")
        ? "ogg"
        : mimeType.includes("mp4")
          ? "m4a"
          : "webm";
      const inputPath = path.join(tempDir, `segment-${index}.${extension}`);
      fs.writeFileSync(inputPath, toBuffer(segment.buffer));
      return inputPath;
    });

    const filters: string[] = inputPaths.map(
      (_, index) =>
        `[${index}:a]aresample=16000,aformat=sample_fmts=fltp:channel_layouts=mono[s${index}]`
    );
    filters.push(
      `${inputPaths.map((_, index) => `[s${index}]`).join("")}concat=n=${inputPaths.length}:v=0:a=1[out]`
    );

    await new Promise<void>((resolve, reject) => {
      const args: string[] = inputPaths.flatMap((inputPath: string) => ["-i", inputPath]);
      args.push(
        "-filter_complex",
        filters.join(";"),
        "-map",
        "[out]",
        "-c:a",
        "libopus",
        "-b:a",
        "64k",
        "-y",
        outputPath
      );
      const proc = spawn(ffmpegPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      proc.on("error", (error) => reject(new Error(`FFmpeg process error: ${error.message}`)));
      proc.on("close", (code) => {
        if (code !== 0) {
          const preview = stderr.slice(-500).trim();
          reject(
            new Error(`FFmpeg audio merge exited with code ${code}${preview ? `: ${preview}` : ""}`)
          );
          return;
        }
        resolve();
      });
    });

    return fs.readFileSync(outputPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function clearCache(): void {
  cachedFFmpegPath = null;
}

