import { spawn, type ChildProcessByStdio } from "child_process";
import { app } from "electron";
import fs from "fs";
import path from "path";
import type { Readable } from "stream";
const debugLogger = require("./debugLogger");
import { compareVersions } from "./parakeetCapability.js";

const ARCH_CPU_TYPE: Readonly<Record<string, number>> = {
  arm64: 0x0100000c,
  x64: 0x01000007,
};

const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_CHUNK_MS = 100;
const START_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 60000;
const STOP_TIMEOUT_MS = 5000;

type AudioTapChild = ChildProcessByStdio<null, Readable, Readable>;

export type AudioTapPermissionStatus = "granted" | "denied" | "unknown";
export type AudioTapAccessStatus = AudioTapPermissionStatus | "unsupported";

export interface AudioTapAccessResult {
  granted: boolean;
  status: AudioTapAccessStatus;
  error?: string;
}

export interface AudioTapStartMessage {
  type: "start";
  sampleRate?: number;
  channels?: number;
  bitsPerChannel?: number;
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
  | AudioTapStartMessage
  | AudioTapWarningMessage
  | AudioTapErrorMessage;

export interface AudioTapProcessError extends Error {
  code?: string;
  status?: number;
  operation?: string;
}

export interface AudioTapStartOptions {
  onChunk?: (chunk: Buffer) => void;
  onError?: (error: Error) => void;
  onWarning?: (warning: AudioTapWarningMessage) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function parseAudioTapMessage(value: unknown): AudioTapMessage | null {
  if (!isRecord(value)) return null;
  if (value.type === "start") {
    if (
      ("sampleRate" in value && typeof value.sampleRate !== "number") ||
      ("channels" in value && typeof value.channels !== "number") ||
      ("bitsPerChannel" in value && typeof value.bitsPerChannel !== "number")
    ) {
      return null;
    }
    return {
      type: "start",
      sampleRate: typeof value.sampleRate === "number" ? value.sampleRate : undefined,
      channels: typeof value.channels === "number" ? value.channels : undefined,
      bitsPerChannel:
        typeof value.bitsPerChannel === "number" ? value.bitsPerChannel : undefined,
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
  onChunk: ((chunk: Buffer) => void) | null;
  onError: ((error: Error) => void) | null;
  onWarning: ((warning: AudioTapWarningMessage) => void) | null;
  isStopping: boolean;
  permissionStatus: AudioTapPermissionStatus;
  private _requestPromise: Promise<AudioTapAccessResult> | null;

  constructor() {
    this.process = null;
    this.stderrBuffer = "";
    this.onChunk = null;
    this.onError = null;
    this.onWarning = null;
    this.isStopping = false;
    this.permissionStatus = this._loadPermissionStatus();
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

  checkAccess(): AudioTapAccessResult {
    if (!this.isSupported()) {
      return { granted: false, status: "unsupported" };
    }
    const status = this.getPermissionStatus();
    return { granted: status === "granted", status };
  }

  private _statusFilePath(): string {
    return path.join(app.getPath("userData"), ".system-audio-permission");
  }

  private _loadPermissionStatus(): AudioTapPermissionStatus {
    try {
      const status = fs.readFileSync(this._statusFilePath(), "utf8").trim();
      if (status === "granted" || status === "denied") return status;
    } catch {
      // File doesn't exist yet — first launch or reset.
    }
    return "unknown";
  }

  private _persistPermissionStatus(status: AudioTapPermissionStatus): void {
    if (status !== "granted" && status !== "denied") return;
    this.permissionStatus = status;
    try {
      fs.writeFileSync(this._statusFilePath(), status);
    } catch {
      // Non-critical — status is still cached in memory for this session.
    }
  }

  async requestAccess(): Promise<AudioTapAccessResult> {
    if (!this.isSupported()) {
      return { granted: false, status: "unsupported" };
    }
    if (this.process) {
      this._persistPermissionStatus("granted");
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
        this._persistPermissionStatus(status);
        return { granted: false, status, error: processError.message };
      })
      .finally(() => {
        this._requestPromise = null;
      });
    this._requestPromise = requestPromise;

    return requestPromise;
  }

  async start({ onChunk, onError, onWarning }: AudioTapStartOptions = {}): Promise<void> {
    if (!this.isSupported()) {
      throw new Error("macOS 14.2 or later is required for native system audio capture.");
    }
    if (this.process) {
      this.onChunk = onChunk || null;
      this.onError = onError || null;
      this.onWarning = onWarning || null;
      return;
    }
    if (this._requestPromise) {
      await this._requestPromise.catch(() => {});
    }

    const binaryPath = this._prepareBinary();
    this.onChunk = onChunk || null;
    this.onError = onError || null;
    this.onWarning = onWarning || null;
    this.isStopping = false;
    this.stderrBuffer = "";

    const child = spawn(
      binaryPath,
      ["--sample-rate", String(DEFAULT_SAMPLE_RATE), "--chunk-ms", String(DEFAULT_CHUNK_MS)],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    this.process = child;

    await new Promise<void>((resolve, reject) => {
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
        this.onChunk?.(chunk);
      });

      child.stderr.on("data", (chunk) => {
        if (this.process !== child) {
          return;
        }
        this._consumeStderr(chunk, (message) => {
          if (message.type === "start") {
            this._persistPermissionStatus("granted");
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
              this._persistPermissionStatus("denied");
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
        if (this.process === child) {
          this.process = null;
        }
        if (settle()) reject(error);
      });

      child.on("exit", (code, signal) => {
        const wasStopping = this.isStopping;
        if (this.process === child) {
          this.process = null;
        }

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

      child.once("exit", () => {
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
    this.onChunk = null;
    this.onError = null;
    this.onWarning = null;
    this.isStopping = false;
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
                this._persistPermissionStatus("granted");
                if (settle()) {
                  stopChild();
                  resolve({ granted: true, status: "granted" });
                }
                return;
              }
              if (message.type === "error") {
                const error = this._buildProcessError(message);
                if (error.code === "permission_denied") {
                  this._persistPermissionStatus("denied");
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
    let newlineIndex = this.stderrBuffer.indexOf("\n");

    while (newlineIndex !== -1) {
      const line = this.stderrBuffer.slice(0, newlineIndex).trim();
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);

      if (line) {
        try {
          const message = parseAudioTapMessage(JSON.parse(line));
          if (message) onMessage(message);
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
