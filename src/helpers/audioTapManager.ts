import { z } from "zod";

import { execFile, spawn, type ChildProcessByStdio } from "child_process";
import { app } from "electron";
import fs from "fs";
import {
  meetingAudioClockMessageSchema,
  meetingRecordingIdSchema,
  type MeetingAudioClockMessage,
} from "../contracts/meetingRecording.js";
import path from "path";
import type { Readable, Writable } from "stream";

import debugLogger from "./debugLogger.js";

import { compareVersions } from "./parakeetCapability.js";

const ARCH_CPU_TYPE = {
  arm64: 0x0100000c,
  x64: 0x01000007,
} as const;

const DEFAULT_SAMPLE_RATE = 24000;

const DEFAULT_CHUNK_MS = 100;

const START_TIMEOUT_MS = 3000;

const PERMISSION_CHECK_TIMEOUT_MS = 3000;

const REQUEST_TIMEOUT_MS = 60000;

const STOP_TIMEOUT_MS = 5000;

type AudioTapChild = ChildProcessByStdio<Writable, Readable, Readable>;

export type AudioTapPermissionStatus = "granted" | "denied" | "unknown";

export type AudioTapAccessStatus = AudioTapPermissionStatus | "unsupported";

export interface AudioTapAccessResult {
  granted: boolean;
  status: AudioTapAccessStatus;
  error?: string;
}

export interface AudioTapStartMessage {
  type: "start";
  generation?: string;
  sampleRate?: number;
  channels?: number;
  bitsPerChannel?: number;
  monotonicOriginNs?: string;
  originFrame?: number;
}

export interface AudioTapPcmMessage {
  type: "pcm";
  frameStart: number;
  frameCount: number;
}

export interface AudioTapProbeMessage {
  type: "probe";
  nonce: string;
  helperReceiveNs: string;
  helperSendNs: string;
  helperGeneration: string;
  helperFrame: number;
}

export interface AudioTapWarningMessage {
  type: "warning";
  code?: string;
  reason?: string;
  message?: string;
}

export interface AudioTapErrorMessage {
  type: "error";
  code?: string;
  message?: string;
  status?: number;
  operation?: string;
}

export type AudioTapMessage =
  | MeetingAudioClockMessage
  | AudioTapStartMessage
  | AudioTapPcmMessage
  | AudioTapProbeMessage
  | AudioTapWarningMessage
  | AudioTapErrorMessage;

export interface AudioTapProcessError extends Error {
  code?: string;
  status?: number;
  operation?: string;
}

export interface AudioTapStartOptions {
  onStart?: (message: AudioTapStartMessage) => void;
  onClock?: (message: MeetingAudioClockMessage) => void;
  onChunk?: (chunk: Buffer, frameStart: number) => void;
  onError?: (error: Error) => void;
  onWarning?: (warning: AudioTapWarningMessage) => void;
}

// Wire schemas for the native helper's stdio messages. `undefined` optional
// fields and null-return keep the original tolerate-or-drop contract.
const startMessageSchema = z.object({
  type: z.literal("start"),
  generation: meetingRecordingIdSchema.optional(),
  sampleRate: z.number().optional(),
  channels: z.number().optional(),
  bitsPerChannel: z.number().optional(),
  monotonicOriginNs: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional(),
  originFrame: z.number().int().nonnegative().optional(),
});

const pcmMessageSchema = z.object({
  type: z.literal("pcm"),
  frameStart: z.number().int().nonnegative(),
  frameCount: z.number().int().min(1),
});

const probeMessageSchema = z.object({
  type: z.literal("probe"),
  nonce: z.string().max(64),
  helperReceiveNs: z.string().regex(/^\d{1,20}$/),
  helperSendNs: z.string().regex(/^\d{1,20}$/),
  helperGeneration: meetingRecordingIdSchema,
  helperFrame: z.number().int().nonnegative(),
});

const warningMessageSchema = z.object({
  type: z.literal("warning"),
  code: z.string().optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
});

const errorMessageSchema = z.object({
  type: z.literal("error"),
  code: z.string().optional(),
  message: z.string().optional(),
  status: z.number().optional(),
  operation: z.string().optional(),
});

const audioTapMessageSchema = z.discriminatedUnion("type", [
  meetingAudioClockMessageSchema,
  startMessageSchema,
  pcmMessageSchema,
  probeMessageSchema,
  warningMessageSchema,
  errorMessageSchema,
]);

// The native helper's stdio line is the wire boundary: the only honest input
// type is unknown, and the zod discriminated union inside is the parse
// (exact-file no-unknown-parameters override documented at .oxlintrc.json).
export function parseAudioTapMessage(value: unknown): AudioTapMessage | null {
  const parsed = audioTapMessageSchema.safeParse(value);

  if (!parsed.success) return null;

  // SAFETY: the discriminated union output is exactly the AudioTapMessage
  // family declared above.
  return parsed.data;
}

export class AudioTapManager {
  process: AudioTapChild | null;
  stderrBuffer: string;
  onChunk: ((chunk: Buffer, frameStart: number) => void) | null;
  onError: ((error: Error) => void) | null;
  onWarning: ((warning: AudioTapWarningMessage) => void) | null;
  onStart: ((message: AudioTapStartMessage) => void) | null;
  private onClock: ((message: MeetingAudioClockMessage) => void) | null = null;
  private stdoutPCM = Buffer.alloc(0);
  private readonly pendingPcmMetadata: AudioTapPcmMessage[] = [];
  private readonly pendingProbes = new Map<
    string,
    {
      resolve(reply: AudioTapProbeMessage): void;
      reject(error: Error): void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private helperGeneration: string | null = null;
  private monotonicOriginNs: string | null = null;
  isStopping: boolean;
  permissionStatus: AudioTapPermissionStatus;
  private _requestPromise: Promise<AudioTapAccessResult> | null;

  constructor() {
    this.process = null;
    this.stderrBuffer = "";
    this.onChunk = null;
    this.onError = null;
    this.onWarning = null;
    this.onStart = null;
    this.onClock = null;
    this.isStopping = false;
    this.permissionStatus = "unknown";
    this._requestPromise = null;
  }

  isSupported(): boolean {
    return (
      process.platform === "darwin" && compareVersions(process.getSystemVersion(), "14.2") >= 0
    );
  }

  isAvailable(): boolean {
    if (!this.isSupported()) {
      return false;
    }

    const binaryPath = this.resolveBinary();

    if (!binaryPath) {
      return false;
    }

    return !this._checkArchMismatch(binaryPath);
  }

  getPermissionStatus(): AudioTapPermissionStatus {
    if (this.process) {
      return "granted";
    }

    return this.permissionStatus;
  }

  getClockOrigin(): { helperGeneration: string; monotonicOriginNs: string } | null {
    return this.helperGeneration && this.monotonicOriginNs
      ? { helperGeneration: this.helperGeneration, monotonicOriginNs: this.monotonicOriginNs }
      : null;
  }

  probeClock(nonce: string): Promise<AudioTapProbeMessage> {
    const child = this.process;

    if (!child || !this.helperGeneration || !meetingRecordingIdSchema.safeParse(nonce).success) {
      return Promise.reject(new Error("Native audio clock is unavailable"));
    }

    if (this.pendingProbes.size >= 8 || this.pendingProbes.has(nonce)) {
      return Promise.reject(new Error("Native audio clock probe queue is full"));
    }

    return new Promise<AudioTapProbeMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingProbes.delete(nonce);
        reject(new Error("Native audio clock probe timed out"));
      }, 2000);

      this.pendingProbes.set(nonce, { resolve, reject, timeout });
      child.stdin.write(`${JSON.stringify({ type: "probe", nonce })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pendingProbes.delete(nonce);
        reject(error);
      });
    });
  }

  async checkAccess(): Promise<AudioTapAccessResult> {
    if (!this.isSupported()) {
      return { granted: false, status: "unsupported" };
    }

    if (this.process) {
      return { granted: true, status: "granted" };
    }

    const status = await this._preflightPermission();
    this.permissionStatus = status;

    return { granted: status === "granted", status };
  }

  private _preflightPermission(): Promise<AudioTapPermissionStatus> {
    let binaryPath: string;

    try {
      binaryPath = this._prepareBinary();
    } catch {
      return Promise.resolve("unknown");
    }

    return new Promise((resolve) => {
      execFile(
        binaryPath,
        ["--check-permission"],
        { timeout: PERMISSION_CHECK_TIMEOUT_MS },
        (_error, _stdout, stderr) => {
          for (const line of String(stderr).split("\n")) {
            try {
              // SAFETY: the helper's permission line is a JSON object whose
              // two fields are probed defensively right below.
              const message = JSON.parse(line) as { type?: unknown; status?: unknown };

              if (
                message.type === "permission" &&
                (message.status === "granted" || message.status === "denied")
              ) {
                resolve(message.status);

                return;
              }
            } catch {
              // Ignore non-JSON output.
            }
          }

          resolve("unknown");
        }
      );
    });
  }

  private _setPermissionStatus(status: AudioTapPermissionStatus): void {
    if (status === "granted" || status === "denied") this.permissionStatus = status;
  }

  async requestAccess(): Promise<AudioTapAccessResult> {
    if (!this.isSupported()) {
      return { granted: false, status: "unsupported" };
    }

    if (this.process) {
      this._setPermissionStatus("granted");

      return { granted: true, status: "granted" };
    }

    if (this._requestPromise) {
      return this._requestPromise;
    }

    const requestPromise = this._probeForAccess()
      .catch((error: Error) => {
        const processError = error;

        const status: "denied" | "unknown" =
          "code" in processError && processError.code === "permission_denied"
            ? "denied"
            : "unknown";

        this._setPermissionStatus(status);

        return { granted: false, status, error: processError.message };
      })
      .finally(() => {
        this._requestPromise = null;
      });

    this._requestPromise = requestPromise;

    return requestPromise;
  }

  async start({
    onStart,
    onChunk,
    onError,
    onWarning,
    onClock,
  }: AudioTapStartOptions = {}): Promise<void> {
    if (!this.isSupported()) {
      throw new Error("macOS 14.2 or later is required for native system audio capture.");
    }

    if (this.process) {
      this.onChunk = onChunk || null;
      this.onError = onError || null;
      this.onWarning = onWarning || null;
      this.onStart = onStart || null;
      this.onClock = onClock || null;

      return;
    }

    if (this._requestPromise) {
      await this._requestPromise.catch(() => {});
    }

    const binaryPath = this._prepareBinary();
    this.onChunk = onChunk || null;
    this.onError = onError || null;
    this.onWarning = onWarning || null;
    this.onStart = onStart || null;
    this.onClock = onClock || null;
    this.isStopping = false;
    this.stderrBuffer = "";

    const child = spawn(
      binaryPath,
      ["--sample-rate", String(DEFAULT_SAMPLE_RATE), "--chunk-ms", String(DEFAULT_CHUNK_MS)],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    this.process = child;

    await new Promise<void>((resolve, reject) => {
      let started = false;
      const startupPCM: Buffer[] = [];
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settle()) return;
        // stop() failures are already routed through the manager's error path.
        this.stop().catch(() => undefined);
        reject(new Error("Timed out starting macOS audio tap. Check System Audio permissions."));
      }, START_TIMEOUT_MS);

      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timeout);

        return true;
      };

      child.stdout.on("data", (chunk: Buffer) => {
        if (this.process !== child) {
          return;
        }

        startupPCM.push(chunk);
        const bytes = startupPCM.reduce((sum, part) => sum + part.length, 0);

        if (bytes > (DEFAULT_SAMPLE_RATE * 2 * START_TIMEOUT_MS) / 1000) {
          if (settle())
            reject(new Error("Audio tap did not provide its start contract before PCM"));
          // stop() failures are already routed through the manager's error path.
          this.stop().catch(() => undefined);

          return;
        }

        if (started) {
          this.stdoutPCM = Buffer.concat([this.stdoutPCM, ...startupPCM]);
          startupPCM.length = 0;
          this.flushPcmQueue();
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        if (this.process !== child) {
          return;
        }

        this._consumeStderr(chunk, (message) => {
          if (message.type === "clock") {
            this.onClock?.(message);

            return;
          }

          if (message.type === "probe") {
            if (message.helperGeneration !== this.helperGeneration) return;
            const pending = this.pendingProbes.get(message.nonce);
            this.pendingProbes.delete(message.nonce);

            if (pending) {
              clearTimeout(pending.timeout);
              pending.resolve(message);
            }

            return;
          }

          if (message.type === "pcm") {
            if (this.pendingPcmMetadata.length >= 64) {
              this.onError?.(new Error("Native audio frame metadata queue overflowed"));
              // stop() failures are already routed through the manager's error path.
              this.stop().catch(() => undefined);

              return;
            }

            this.pendingPcmMetadata.push(message);
            this.flushPcmQueue();

            return;
          }

          if (message.type === "start") {
            this._setPermissionStatus("granted");

            try {
              this.helperGeneration = message.generation ?? null;
              this.monotonicOriginNs = message.monotonicOriginNs ?? null;
              this.onStart?.(message);
              started = true;
              this.stdoutPCM = Buffer.concat(startupPCM);
              startupPCM.length = 0;
              this.flushPcmQueue();
            } catch (error) {
              if (settle()) reject(error);
              // stop() failures are already routed through the manager's error path.
              this.stop().catch(() => undefined);

              return;
            }

            if (settle()) resolve();

            return;
          }

          if (message.type === "warning") {
            this.onWarning?.(message);

            return;
          }

          if (message.type === "error") {
            const error = this._buildProcessError(message);

            if (error.code === "permission_denied") {
              this._setPermissionStatus("denied");
            }

            if (!settled) {
              if (!settle()) return;
              // stop() failures are already routed through the manager's error path.
              this.stop().catch(() => undefined);
              reject(error);
            } else {
              this.onError?.(error);
            }
          }
        });
      });

      child.on("error", (error) => {
        if (settle()) reject(error);
      });

      child.on("exit", (code, signal) => {
        const wasStopping = this.isStopping;

        if (!settled) {
          if (settle()) {
            reject(
              new Error(
                `macOS audio tap exited before start (code ${code ?? "null"}, signal ${signal ?? "null"}).`
              )
            );
          }

          return;
        }

        if (!wasStopping) {
          this.onError?.(
            new Error(
              `macOS audio tap exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}).`
            )
          );
        }
      });

      child.once("close", () => {
        if (this.process !== child) return;
        this.process = null;
        this.onChunk = null;
        this.onError = null;
        this.onWarning = null;
        this.onStart = null;
        this.stdoutPCM = Buffer.alloc(0);
        this.pendingPcmMetadata.length = 0;

        for (const pending of this.pendingProbes.values()) {
          clearTimeout(pending.timeout);
          pending.reject(new Error("Native audio clock stopped"));
        }

        this.pendingProbes.clear();
        this.helperGeneration = null;
        this.monotonicOriginNs = null;
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    const child = this.process;
    this.isStopping = true;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          resolve();
        }
      }, STOP_TIMEOUT_MS);

      child.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });

    if (this.process === child) {
      this.process = null;
    }

    this.stderrBuffer = "";

    for (const pending of this.pendingProbes.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Native audio clock stopped"));
    }

    this.pendingProbes.clear();
    this.pendingPcmMetadata.length = 0;
    this.stdoutPCM = Buffer.alloc(0);
    this.helperGeneration = null;
    this.monotonicOriginNs = null;
    this.onChunk = null;
    this.onError = null;
    this.onWarning = null;
    this.onStart = null;
    this.onClock = null;
    this.isStopping = false;
  }

  private flushPcmQueue(): void {
    if (this.stdoutPCM.length > 2 * 1024 * 1024) {
      this.onError?.(new Error("Native audio PCM queue overflowed"));
      // stop() failures are already routed through the manager's error path.
      this.stop().catch(() => undefined);

      return;
    }

    while (this.pendingPcmMetadata.length > 0) {
      const metadata = this.pendingPcmMetadata[0];
      const byteLength = metadata.frameCount * 2;

      if (!Number.isSafeInteger(byteLength) || byteLength > this.stdoutPCM.length) return;
      const chunk = Buffer.from(this.stdoutPCM.subarray(0, byteLength));
      this.stdoutPCM = this.stdoutPCM.subarray(byteLength);
      this.pendingPcmMetadata.shift();

      try {
        this.onChunk?.(chunk, metadata.frameStart);
      } catch (error) {
        this.onError?.(error instanceof Error ? error : new Error(String(error)));
        // stop() failures are already routed through the manager's error path.
        this.stop().catch(() => undefined);

        return;
      }
    }
  }

  private async _probeForAccess(): Promise<AudioTapAccessResult> {
    const binaryPath = this._prepareBinary();

    const child = spawn(
      binaryPath,
      ["--sample-rate", String(DEFAULT_SAMPLE_RATE), "--chunk-ms", String(DEFAULT_CHUNK_MS)],
      { stdio: ["ignore", "ignore", "pipe"] }
    );

    let stderrBuffer = "";

    return new Promise<AudioTapAccessResult>((resolve, reject) => {
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settle()) return;
        stopChild();
        resolve({ granted: false, status: "unknown" });
      }, REQUEST_TIMEOUT_MS);

      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timeout);

        return true;
      };

      const stopChild = (): void => {
        // kill on an already-exited child throws ESRCH; stopping is done.
        try {
          child.kill("SIGTERM");
        } catch {
          /* child already exited */
        }
      };

      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuffer += chunk.toString();
        let newlineIndex = stderrBuffer.indexOf("\n");

        while (newlineIndex !== -1) {
          const line = stderrBuffer.slice(0, newlineIndex).trim();
          stderrBuffer = stderrBuffer.slice(newlineIndex + 1);

          if (line) {
            try {
              const message = parseAudioTapMessage(JSON.parse(line));

              if (!message) {
                debugLogger.warn("[AudioTapManager] Invalid stderr message", { line }, "meeting");
                newlineIndex = stderrBuffer.indexOf("\n");
                continue;
              }

              if (message.type === "start") {
                this._setPermissionStatus("granted");

                if (settle()) {
                  stopChild();
                  resolve({ granted: true, status: "granted" });
                }

                return;
              }

              if (message.type === "error") {
                const error = this._buildProcessError(message);

                if (error.code === "permission_denied") {
                  this._setPermissionStatus("denied");
                }

                if (settle()) {
                  stopChild();
                  reject(error);
                }

                return;
              }
            } catch {
              debugLogger.warn("[AudioTapManager] Non-JSON stderr output", { line }, "meeting");
            }
          }

          newlineIndex = stderrBuffer.indexOf("\n");
        }
      });

      child.on("error", (error) => {
        if (settle()) reject(error);
      });

      child.on("exit", (code, signal) => {
        if (settled) {
          return;
        }

        if (!settle()) return;
        resolve({
          granted: false,
          status: this.permissionStatus === "denied" ? "denied" : "unknown",
          error:
            code && code !== 0
              ? `macOS audio tap exited (code ${code}, signal ${signal ?? "null"})`
              : undefined,
        });
      });
    });
  }

  private _prepareBinary(): string {
    const binaryPath = this.resolveBinary();

    if (!binaryPath) {
      throw new Error(
        "macOS audio tap binary not found. Run `npm run compile:audio-tap` before packaging."
      );
    }

    const archMismatch = this._checkArchMismatch(binaryPath);

    if (archMismatch) {
      throw new Error(archMismatch);
    }

    try {
      fs.accessSync(binaryPath, fs.constants.X_OK);
    } catch {
      fs.chmodSync(binaryPath, 0o755);
    }

    return binaryPath;
  }

  resolveBinary(): string | null {
    const candidates = new Set([
      path.join(app.getAppPath(), "resources", "bin", "macos-audio-tap"),
      path.join(app.getAppPath(), "resources", "macos-audio-tap"),
    ]);

    if (process.resourcesPath) {
      candidates.add(path.join(process.resourcesPath, "macos-audio-tap"));
      candidates.add(path.join(process.resourcesPath, "bin", "macos-audio-tap"));
      candidates.add(path.join(process.resourcesPath, "resources", "bin", "macos-audio-tap"));
      candidates.add(
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", "macos-audio-tap")
      );
    }

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private _consumeStderr(
    chunk: Buffer | string | Uint8Array,
    onMessage: (message: AudioTapMessage) => void
  ): void {
    this.stderrBuffer += chunk.toString();

    if (this.stderrBuffer.length > 64 * 1024) {
      this.stderrBuffer = "";
      onMessage({ type: "warning", code: "clock_invalid_message" });

      return;
    }

    let newlineIndex = this.stderrBuffer.indexOf("\n");

    while (newlineIndex !== -1) {
      const line = this.stderrBuffer.slice(0, newlineIndex).trim();
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);

      if (line) {
        try {
          const value: unknown = JSON.parse(line);
          const message = parseAudioTapMessage(value);

          if (message) onMessage(message);
          // A dropped clock message warns so clock-loss stays observable.
          else if (
            z
              .looseObject({ type: z.literal("clock") })
              .nullish()
              .catch(null)
              .parse(value) !== null
          )
            onMessage({ type: "warning", code: "clock_invalid_message" });
          else debugLogger.warn("[AudioTapManager] Invalid stderr message", { line }, "meeting");
        } catch {
          debugLogger.warn("[AudioTapManager] Non-JSON stderr output", { line }, "meeting");
        }
      }

      newlineIndex = this.stderrBuffer.indexOf("\n");
    }
  }

  private _buildProcessError(message: AudioTapErrorMessage): AudioTapProcessError {
    return Object.assign(new Error(message.message || "macOS audio tap failed"), {
      code: message.code,
      status: message.status,
      operation: message.operation,
    });
  }

  private _checkArchMismatch(binaryPath: string): string | null {
    try {
      const fd = fs.openSync(binaryPath, "r");
      const header = Buffer.alloc(8);
      fs.readSync(fd, header, 0, 8, 0);
      fs.closeSync(fd);

      if (header.readUInt32LE(0) !== 0xfeedfacf) {
        return "macOS audio tap binary is not a valid 64-bit Mach-O file.";
      }

      const cpuType = header.readInt32LE(4);

      const expectedCpu =
        process.arch === "arm64"
          ? ARCH_CPU_TYPE.arm64
          : process.arch === "x64"
            ? ARCH_CPU_TYPE.x64
            : undefined;

      if (expectedCpu && cpuType !== expectedCpu) {
        return (
          `macOS audio tap binary architecture mismatch: binary does not match ${process.arch}. ` +
          `Try reinstalling or run \`TARGET_ARCH=${process.arch} npm run compile:audio-tap\`.`
        );
      }

      return null;
    } catch (error: unknown) {
      debugLogger.warn(
        "[AudioTapManager] Could not verify binary architecture",
        { error: error instanceof Error ? error.message : String(error) },
        "meeting"
      );

      return null;
    }
  }
}

module.exports = AudioTapManager;

// CommonJS contract for legacy destructuring requires.
Object.assign(module.exports, { AudioTapManager, parseAudioTapMessage });
