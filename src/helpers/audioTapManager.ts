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

const debugLogger = require("./debugLogger");

import { compareVersions } from "./parakeetCapability.js";

const ARCH_CPU_TYPE: Readonly<Record<string, number>> = {
  arm64: 0x0100000c,
  x64: 0x01000007,
};

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function parseAudioTapMessage(value: unknown): AudioTapMessage | null {
  if (!isRecord(value)) return null;

  if (value.type === "clock") {
    const parsed = meetingAudioClockMessageSchema.safeParse(value);

    return parsed.success ? parsed.data : null;
  }

  if (value.type === "start") {
    if (
      ("generation" in value && !meetingRecordingIdSchema.safeParse(value.generation).success) ||
      ("sampleRate" in value && typeof value.sampleRate !== "number") ||
      ("channels" in value && typeof value.channels !== "number") ||
      ("bitsPerChannel" in value && typeof value.bitsPerChannel !== "number") ||
      ("monotonicOriginNs" in value &&
        (typeof value.monotonicOriginNs !== "string" ||
          !/^\d{1,20}$/.test(value.monotonicOriginNs))) ||
      ("originFrame" in value &&
        (!Number.isSafeInteger(value.originFrame) || (value.originFrame as number) < 0))
    ) {
      return null;
    }

    return {
      type: "start",
      generation: typeof value.generation === "string" ? value.generation : undefined,
      sampleRate: typeof value.sampleRate === "number" ? value.sampleRate : undefined,
      channels: typeof value.channels === "number" ? value.channels : undefined,
      bitsPerChannel: typeof value.bitsPerChannel === "number" ? value.bitsPerChannel : undefined,
      monotonicOriginNs:
        typeof value.monotonicOriginNs === "string" && /^\d{1,20}$/.test(value.monotonicOriginNs)
          ? value.monotonicOriginNs
          : undefined,
      originFrame:
        typeof value.originFrame === "number" &&
        Number.isSafeInteger(value.originFrame) &&
        value.originFrame >= 0
          ? value.originFrame
          : undefined,
    };
  }

  if (value.type === "pcm") {
    if (
      !Number.isSafeInteger(value.frameStart) ||
      (value.frameStart as number) < 0 ||
      !Number.isSafeInteger(value.frameCount) ||
      (value.frameCount as number) < 1
    )
      return null;

    return {
      type: "pcm",
      frameStart: value.frameStart as number,
      frameCount: value.frameCount as number,
    };
  }

  if (value.type === "probe") {
    if (
      typeof value.nonce !== "string" ||
      value.nonce.length > 64 ||
      typeof value.helperReceiveNs !== "string" ||
      !/^\d{1,20}$/.test(value.helperReceiveNs) ||
      typeof value.helperSendNs !== "string" ||
      !/^\d{1,20}$/.test(value.helperSendNs) ||
      typeof value.helperGeneration !== "string" ||
      !meetingRecordingIdSchema.safeParse(value.helperGeneration).success ||
      !Number.isSafeInteger(value.helperFrame) ||
      (value.helperFrame as number) < 0
    )
      return null;

    return {
      type: "probe",
      nonce: value.nonce,
      helperReceiveNs: value.helperReceiveNs,
      helperSendNs: value.helperSendNs,
      helperGeneration: value.helperGeneration,
      helperFrame: value.helperFrame as number,
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
      .catch((error: unknown) => {
        const processError = error instanceof Error ? error : new Error(String(error));

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
        void this.stop();
        reject(new Error("Timed out starting macOS audio tap. Check System Audio permissions."));
      }, START_TIMEOUT_MS);

      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timeout);

        return true;
      };

      child.stdout.on("data", (chunk) => {
        if (this.process !== child) {
          return;
        }

        startupPCM.push(chunk);
        const bytes = startupPCM.reduce((sum, part) => sum + part.length, 0);

        if (bytes > (DEFAULT_SAMPLE_RATE * 2 * START_TIMEOUT_MS) / 1000) {
          if (settle())
            reject(new Error("Audio tap did not provide its start contract before PCM"));
          void this.stop();

          return;
        }

        if (started) {
          this.stdoutPCM = Buffer.concat([this.stdoutPCM, ...startupPCM]);
          startupPCM.length = 0;
          this.flushPcmQueue();
        }
      });

      child.stderr.on("data", (chunk) => {
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
              void this.stop();

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
              void this.stop();

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
              void this.stop();
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
      void this.stop();

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
        void this.stop();

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
        try {
          child.kill("SIGTERM");
        } catch {}
      };

      child.stderr.on("data", (chunk) => {
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
          else if (isRecord(value) && value.type === "clock")
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
      const expectedCpu = ARCH_CPU_TYPE[process.arch];

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

module.exports.AudioTapManager = AudioTapManager;

module.exports.parseAudioTapMessage = parseAudioTapMessage;
