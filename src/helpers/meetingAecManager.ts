import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { app } from "electron";
import fs from "fs";
import path from "path";
const debugLogger = require("./debugLogger");

const START_TIMEOUT_MS = 3000;
const STOP_TIMEOUT_MS = 2000;
const SYSTEM_STREAM = 1;
const MIC_STREAM = 2;
const SAMPLE_RATE = 24000;
const MAX_OUTPUT_FRAME_BYTES = SAMPLE_RATE * 2 * 10;

type AecChild = ChildProcessWithoutNullStreams;

export interface MeetingAecWarningMessage {
  type: "warning";
  code?: string;
  reason?: string;
  message?: string;
}

export interface MeetingAecErrorMessage {
  type: "error";
  code?: string;
  message?: string;
  status?: number;
  operation?: string;
}

export interface MeetingAecStartMessage {
  type: "start";
  sampleRate?: number;
}

export type MeetingAecMessage =
  | MeetingAecStartMessage
  | MeetingAecWarningMessage
  | MeetingAecErrorMessage;

export interface MeetingAecStartOptions {
  onMicChunk?: (chunk: Buffer) => void;
  onError?: (error: Error) => void;
  onWarning?: (warning: MeetingAecWarningMessage) => void;
}

export interface MeetingAecManagerOptions {
  spawnImpl?: typeof spawn;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function parseMeetingAecMessage(value: unknown): MeetingAecMessage | null {
  if (!isRecord(value)) return null;
  if (value.type === "start") {
    if ("sampleRate" in value && typeof value.sampleRate !== "number") return null;
    return {
      type: "start",
      sampleRate: typeof value.sampleRate === "number" ? value.sampleRate : undefined,
    };
  }
  if (value.type === "warning") {
    if (
      ("code" in value && typeof value.code !== "string") ||
      ("reason" in value && typeof value.reason !== "string") ||
      ("message" in value && typeof value.message !== "string")
    ) {
      return null;
    }
    return {
      type: "warning",
      code: typeof value.code === "string" ? value.code : undefined,
      reason: typeof value.reason === "string" ? value.reason : undefined,
      message: typeof value.message === "string" ? value.message : undefined,
    };
  }
  if (value.type === "error") {
    if (
      ("code" in value && typeof value.code !== "string") ||
      ("message" in value && typeof value.message !== "string") ||
      ("status" in value && typeof value.status !== "number") ||
      ("operation" in value && typeof value.operation !== "string")
    ) {
      return null;
    }
    return {
      type: "error",
      code: typeof value.code === "string" ? value.code : undefined,
      message: typeof value.message === "string" ? value.message : undefined,
      status: typeof value.status === "number" ? value.status : undefined,
      operation: typeof value.operation === "string" ? value.operation : undefined,
    };
  }
  return null;
}

export class MeetingAecManager {
  spawnImpl: typeof spawn;
  process: AecChild | null;
  stdoutBuffer: Buffer;
  stderrBuffer: string;
  onMicChunk: ((chunk: Buffer) => void) | null;
  onError: ((error: Error) => void) | null;
  onWarning: ((warning: MeetingAecWarningMessage) => void) | null;
  isStopping: boolean;

  constructor({ spawnImpl = spawn }: MeetingAecManagerOptions = {}) {
    this.spawnImpl = spawnImpl;
    this.process = null;
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrBuffer = "";
    this.onMicChunk = null;
    this.onError = null;
    this.onWarning = null;
    this.isStopping = false;
  }

  isSupported(): boolean {
    return (
      process.platform === "darwin" || process.platform === "linux" || process.platform === "win32"
    );
  }

  isAvailable(): boolean {
    return !!this.resolveBinary();
  }

  resolveBinary(): string | null {
    if (!this.isSupported()) {
      return null;
    }

    const binaryName = `meeting-aec-helper-${process.platform}-${process.arch}${
      process.platform === "win32" ? ".exe" : ""
    }`;
    const candidates = new Set([path.join(app.getAppPath(), "resources", "bin", binaryName)]);

    if (process.resourcesPath) {
      candidates.add(path.join(process.resourcesPath, "bin", binaryName));
      candidates.add(path.join(process.resourcesPath, "resources", "bin", binaryName));
      candidates.add(path.join(process.resourcesPath, binaryName));
    }

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  async start({ onMicChunk, onError, onWarning }: MeetingAecStartOptions = {}): Promise<boolean> {
    if (this.process) {
      this.onMicChunk = onMicChunk || null;
      this.onError = onError || null;
      this.onWarning = onWarning || null;
      return true;
    }

    const binaryPath = this.resolveBinary();
    if (!binaryPath) {
      return false;
    }

    try {
      fs.accessSync(binaryPath, fs.constants.X_OK);
    } catch {
      if (process.platform !== "win32") {
        fs.chmodSync(binaryPath, 0o755);
      }
    }

    const child = this.spawnImpl(binaryPath, ["--sample-rate", String(SAMPLE_RATE)], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.process = child;
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrBuffer = "";
    this.onMicChunk = onMicChunk || null;
    this.onError = onError || null;
    this.onWarning = onWarning || null;
    this.isStopping = false;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let started = false;
      const timeout = setTimeout(() => {
        finish(false);
        void this.stop();
      }, START_TIMEOUT_MS);

      const finish = (result: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };

      child.stdout.on("data", (chunk) => {
        if (this.process !== child) {
          return;
        }
        this._consumeStdout(chunk);
      });

      child.stderr.on("data", (chunk) => {
        if (this.process !== child) {
          return;
        }
        this._consumeStderr(chunk, (message) => {
          if (message.type === "start") {
            started = true;
            finish(true);
            return;
          }
          if (message.type === "warning") {
            this.onWarning?.(message);
            return;
          }
          if (message.type === "error") {
            this.onError?.(new Error(message.message || "Meeting AEC helper failed"));
          }
        });
      });

      child.on("error", (error) => {
        if (!this.isStopping) {
          this.onError?.(error);
        }
        finish(false);
      });

      child.on("exit", (code, signal) => {
        const wasStopping = this.isStopping;
        if (this.process === child) {
          this.process = null;
        }
        this.isStopping = false;
        if (!wasStopping && (code || signal)) {
          this.onError?.(
            new Error(
              `Meeting AEC helper exited unexpectedly (code ${code ?? "null"}, signal ${
                signal ?? "null"
              })`
            )
          );
        }
        finish(started && (code === 0 || code === null));
      });
    });
  }

  processSystemBuffer(buffer: Buffer | Uint8Array): boolean {
    return this._writeFrame(SYSTEM_STREAM, buffer);
  }

  processMicBuffer(buffer: Buffer | Uint8Array): boolean {
    return this._writeFrame(MIC_STREAM, buffer);
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    const child = this.process;
    this.isStopping = true;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      const timeout = setTimeout(() => {
        if (child.exitCode == null) {
          child.kill();
        }
        finish();
      }, STOP_TIMEOUT_MS);

      child.once("exit", () => {
        clearTimeout(timeout);
        finish();
      });

      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.end();
      } else {
        clearTimeout(timeout);
        finish();
      }
    });

    if (this.process === child) {
      this.process = null;
    }
    this.isStopping = false;
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrBuffer = "";
  }

  private _writeFrame(type: 1 | 2, buffer: Buffer | Uint8Array): boolean {
    const stdin = this.process?.stdin;
    if (!stdin || stdin.destroyed) {
      return false;
    }

    const payload = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (!payload.length) {
      return true;
    }

    const header = Buffer.alloc(5);
    header.writeUInt8(type, 0);
    header.writeUInt32LE(payload.length, 1);
    stdin.write(Buffer.concat([header, payload]));
    return true;
  }

  private _consumeStdout(chunk: Buffer | Uint8Array): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);

    while (this.stdoutBuffer.length >= 4) {
      const frameLength = this.stdoutBuffer.readUInt32LE(0);
      if (frameLength === 0 || frameLength > MAX_OUTPUT_FRAME_BYTES || frameLength % 2 !== 0) {
        this.stdoutBuffer = Buffer.alloc(0);
        this.onError?.(new Error(`Meeting AEC helper emitted an invalid frame length: ${frameLength}`));
        return;
      }
      if (this.stdoutBuffer.length < 4 + frameLength) {
        return;
      }

      const payload = this.stdoutBuffer.subarray(4, 4 + frameLength);
      this.stdoutBuffer = this.stdoutBuffer.subarray(4 + frameLength);
      this.onMicChunk?.(Buffer.from(payload));
    }
  }

  private _consumeStderr(
    chunk: Buffer | string | Uint8Array,
    onMessage: (message: MeetingAecMessage) => void
  ): void {
    this.stderrBuffer += chunk.toString();
    let newlineIndex = this.stderrBuffer.indexOf("\n");

    while (newlineIndex !== -1) {
      const line = this.stderrBuffer.slice(0, newlineIndex).trim();
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);

      if (line) {
        try {
          const message = parseMeetingAecMessage(JSON.parse(line));
          if (message) onMessage(message);
          else debugLogger.warn("[MeetingAecManager] Invalid stderr message", { line }, "meeting");
        } catch {
          debugLogger.warn("[MeetingAecManager] Non-JSON stderr output", { line }, "meeting");
        }
      }

      newlineIndex = this.stderrBuffer.indexOf("\n");
    }
  }
}

module.exports = MeetingAecManager;
module.exports.MeetingAecManager = MeetingAecManager;
module.exports.parseMeetingAecMessage = parseMeetingAecMessage;
