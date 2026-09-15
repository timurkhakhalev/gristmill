const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const debugLogger = require("./debugLogger.js");
const os = require("os");
const {
  findAvailablePort,
  resolveBinaryPath,
  gracefulStopProcess,
} = require("../utils/serverUtils.js");
import { getSafeTempDir } from "./safeTempDir.js";
import { createAbortError } from "./abortError.js";
import * as sidecarPidFile from "./sidecarPidFile.js";
import { parseOfflineMessage, createOnlineAccumulator } from "./parakeetWsResult.js";
import { getModelType, getSherpaModelType } from "./parakeetModelInfo.js";
const { pcm16ToFloat32 } = require("../utils/audioUtils.js");
import {
  computeTranscriptionTimeoutMs,
  TRANSCRIPTION_TIMEOUT_FLOOR_MS,
} from "./transcriptionTimeout.js";

const PORT_RANGE_START = 6006;
const PORT_RANGE_END = 6029;
const STARTUP_TIMEOUT_MS = 60000;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const FLOAT32_BYTES_PER_SAMPLE = 4;
const ONLINE_CHUNK_BYTES = 8000 * FLOAT32_BYTES_PER_SAMPLE;
const FLOAT32_BYTES_PER_SECOND = 16000 * FLOAT32_BYTES_PER_SAMPLE;
// Streaming decodes as the audio drains, so its hard cap is tighter than the offline budget.
const ONLINE_TIMEOUT_PER_AUDIO_SECOND_MS = 2000;
// After "Done" is sent, give up only after this long without any result message.
const ONLINE_FINISH_IDLE_TIMEOUT_MS = 10000;
// Must cover the model's 560ms chunk so the flush decodes the final words.
const ONLINE_END_TAIL_PADDING_S = 0.6;

export class ParakeetWsServer {
  process: import("child_process").ChildProcess | null = null;
  port: number | null = null;
  ready = false;
  modelName: string | null = null;
  modelDir: string | null = null;
  modelRuntime: "offline" | "online" = "offline";
  // Only set for models started for a single language (Cohere Transcribe);
  // part of the server identity, so a language change restarts the server.
  language: string | null = null;
  startupPromise: Promise<void> | null = null;
  startingModelName: string | null = null;
  startingLanguage: string | null = null;
  healthCheckInterval: NodeJS.Timeout | null = null;
  cachedBinaryPaths: Record<string, string> = {};

  getWsBinaryPath(runtime: "offline" | "online" = "offline"): string | null {
    if (this.cachedBinaryPaths[runtime]) return this.cachedBinaryPaths[runtime];

    const platformArch = `${process.platform}-${process.arch}`;
    const prefix = runtime === "online" ? "sherpa-onnx-online-ws" : "sherpa-onnx-ws";
    const binaryName =
      process.platform === "win32" ? `${prefix}-${platformArch}.exe` : `${prefix}-${platformArch}`;

    const resolved = resolveBinaryPath(binaryName);
    if (resolved) this.cachedBinaryPaths[runtime] = resolved;
    return resolved;
  }

  isAvailable(runtime: "offline" | "online" = "offline"): boolean {
    return this.getWsBinaryPath(runtime) !== null;
  }

  hasAnyWsBinary(): boolean {
    return this.isAvailable("offline") || this.isAvailable("online");
  }

  async start(
    modelName: string,
    modelDir: string,
    runtime: "offline" | "online" = "offline",
    language: string | null = null
  ): Promise<void> {
    // Serialize with any in-flight startup; join it only when it's for the same model.
    while (this.startupPromise) {
      if (this.startingModelName === modelName && this.startingLanguage === language) {
        return this.startupPromise;
      }
      await this.startupPromise.catch(() => {});
    }
    if (this.ready && this.modelName === modelName && this.language === language) return;

    this.startingModelName = modelName;
    this.startingLanguage = language;
    // Assigned before any await so concurrent callers can never double-spawn.
    this.startupPromise = (async () => {
      try {
        if (this.process) await this.stop();
        await this._doStart(modelName, modelDir, runtime, language);
      } finally {
        this.startupPromise = null;
        this.startingModelName = null;
        this.startingLanguage = null;
      }
    })();
    return this.startupPromise;
  }

  async _doStart(modelName: string, modelDir: string, runtime: "offline" | "online", language: string | null): Promise<void> {
    const wsBinary = this.getWsBinaryPath(runtime);
    if (!wsBinary) throw new Error(`sherpa-onnx ${runtime} WS server binary not found`);
    if (!fs.existsSync(modelDir)) throw new Error(`Model directory not found: ${modelDir}`);

    this.port = await findAvailablePort(PORT_RANGE_START, PORT_RANGE_END);
    this.modelName = modelName;
    this.modelDir = modelDir;
    this.modelRuntime = runtime;
    this.language = language;

    const threads = Math.max(1, Math.min(4, Math.floor(os.cpus().length * 0.75)));
    const modelArgs =
      getModelType(modelName) === "cohere-transcribe"
        ? [
            `--cohere-transcribe-encoder=${path.join(modelDir, "encoder.int8.onnx")}`,
            `--cohere-transcribe-decoder=${path.join(modelDir, "decoder.int8.onnx")}`,
            `--cohere-transcribe-language=${language}`,
          ]
        : [
            `--encoder=${path.join(modelDir, "encoder.int8.onnx")}`,
            `--decoder=${path.join(modelDir, "decoder.int8.onnx")}`,
            `--joiner=${path.join(modelDir, "joiner.int8.onnx")}`,
          ];
    const sherpaModelType = getSherpaModelType(modelName);
    const args = [
      `--tokens=${path.join(modelDir, "tokens.txt")}`,
      ...modelArgs,
      ...(runtime === "offline" && sherpaModelType ? [`--model-type=${sherpaModelType}`] : []),
      `--port=${this.port}`,
      ...(runtime === "online"
        ? [
            // --num-threads is ONNX intra-op parallelism for the single dictation
            // stream; --num-work-threads only spreads across concurrent streams.
            `--num-threads=${threads}`,
            "--num-work-threads=2",
            // Default 10ms decode-loop tick adds idle time to faster-than-realtime decode.
            "--loop-interval-ms=2",
            `--end-tail-padding=${ONLINE_END_TAIL_PADDING_S}`,
            // Nonzero --warm-up aborts startup for non-zipformer2 models; _warmUp()
            // covers it app-side.
            "--warm-up=0",
          ]
        : [`--num-threads=${threads}`]),
    ];

    debugLogger.debug("Starting parakeet WS server", { port: this.port, modelName, runtime, args });

    const child = spawn(wsBinary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      cwd: getSafeTempDir(),
      detached: process.platform !== "win32",
    });
    this.process = child;
    sidecarPidFile.write("parakeet", child.pid);

    let stderrBuffer = "";
    let exitCode: number | null = null;
    let readyResolve: (value: boolean) => void = () => {};
    const readyFromStderr = new Promise<boolean>((resolve) => {
      readyResolve = resolve;
    });

    child.stdout?.on("data", (data: Buffer) => {
      debugLogger.debug("parakeet-ws stdout", { data: data.toString().trim() });
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderrBuffer += data.toString();
      debugLogger.debug("parakeet-ws stderr", { data: data.toString().trim() });
      if (data.toString().includes("Listening on:")) {
        readyResolve(true);
      }
    });

    child.on("error", (error: Error) => {
      debugLogger.error("parakeet-ws process error", { error: error.message });
      if (this.process === child) this.ready = false;
      readyResolve(false);
    });

    child.on("close", (code: number | null) => {
      exitCode = code;
      debugLogger.debug("parakeet-ws process exited", { code });
      // A superseded child must not clobber the state of its replacement.
      if (this.process === child) {
        this.ready = false;
        this.process = null;
        this.stopHealthCheck();
        sidecarPidFile.clear("parakeet");
      }
      readyResolve(false);
    });

    await this._waitForReady(readyFromStderr, () => ({ stderr: stderrBuffer, exitCode }));
    this._startHealthCheck();

    debugLogger.info("parakeet-ws server started successfully", {
      port: this.port,
      model: modelName,
      runtime,
    });

    await this._warmUp();
  }

  async _warmUp(): Promise<void> {
    try {
      const sampleRate = 16000;
      const numSamples = sampleRate;
      const silentSamples = Buffer.alloc(numSamples * 4);
      await this.transcribe(silentSamples, sampleRate);
      debugLogger.debug("parakeet-ws warm-up inference complete");
    } catch (err) {
      debugLogger.warn("parakeet-ws warm-up failed (non-fatal)", {
        error: (err as Error).message,
      });
    }
  }

  async _waitForReady(
    readySignal: Promise<boolean>,
    getProcessInfo: () => { stderr?: string | null; exitCode: number | null }
  ): Promise<void> {
    const startTime = Date.now();

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`parakeet-ws failed to start within ${STARTUP_TIMEOUT_MS}ms`)),
        STARTUP_TIMEOUT_MS
      );
    });

    const ready = await Promise.race([readySignal, timeoutPromise]);

    if (!ready) {
      const info = getProcessInfo ? getProcessInfo() : { stderr: null, exitCode: null };
      const stderr = info.stderr ? info.stderr.trim().slice(0, 200) : "";
      const details = stderr || (info.exitCode !== null ? `exit code: ${info.exitCode}` : "");
      throw new Error(`parakeet-ws process died during startup${details ? `: ${details}` : ""}`);
    }

    this.ready = true;
    debugLogger.debug("parakeet-ws ready", { startupTimeMs: Date.now() - startTime });
  }

  _isProcessAlive(): boolean {
    if (!this.process || this.process.killed) return false;
    try {
      process.kill(this.process.pid as number, 0);
      return true;
    } catch {
      return false;
    }
  }

  _startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthCheckInterval = setInterval(() => {
      if (!this.process) {
        this.stopHealthCheck();
        return;
      }

      if (!this._isProcessAlive()) {
        debugLogger.warn("parakeet-ws health check failed: process not alive");
        this.ready = false;
        this.stopHealthCheck();
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  // signal is optional; dictation and warm-up flows never pass one.
  transcribe(samplesBuffer: Buffer, sampleRate: number, { signal }: { signal?: AbortSignal } = {}): Promise<{ text: string; elapsed: number; truncated?: boolean }> {
    if (!this.ready || !this.process) {
      throw new Error("parakeet-ws server is not running");
    }

    if (this.modelRuntime === "online") {
      return this._transcribeOnline(samplesBuffer, signal);
    }

    return this._transcribeOffline(samplesBuffer, sampleRate, signal);
  }

  _transcribeOffline(samplesBuffer: Buffer, sampleRate: number, signal?: AbortSignal): Promise<{ text: string; elapsed: number; truncated?: boolean }> {
    const timeoutMs = computeTranscriptionTimeoutMs(
      samplesBuffer.length / FLOAT32_BYTES_PER_SAMPLE / sampleRate
    );

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError("parakeet-ws transcription cancelled"));
        return;
      }

      const startTime = Date.now();
      let result = "";

      const timeout = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error("parakeet-ws transcription timed out"));
      }, timeoutMs);

      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);

      // Closing the socket drops this request; the server finishes its
      // in-flight decode of the segment on its own (bounded by the 15s cap).
      const onAbort = () => {
        clearTimeout(timeout);
        try {
          ws.close();
        } catch {}
        reject(createAbortError("parakeet-ws transcription cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      ws.on("open", () => {
        // sherpa-onnx offline WS binary protocol:
        // [int32LE sample_rate][int32LE num_audio_bytes][float32 samples...]
        const message = Buffer.alloc(8 + samplesBuffer.length);
        message.writeInt32LE(sampleRate, 0);
        message.writeInt32LE(samplesBuffer.length, 4);
        samplesBuffer.copy(message, 8);

        debugLogger.debug("parakeet-ws sending audio", {
          samplesBytes: samplesBuffer.length,
          sampleRate,
        });

        ws.send(message, (err: Error | undefined) => {
          if (err) {
            debugLogger.error("parakeet-ws send error", { error: err.message });
          }
        });
      });

      ws.on("message", (data: Buffer) => {
        result += data.toString();
        ws.send("Done");
      });

      ws.on("close", (code: number) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        const elapsed = Date.now() - startTime;

        // The offline server always sends one result message (even for silence),
        // so closing without one means the server died or was stopped mid-request.
        if (!result) {
          reject(new Error("parakeet-ws connection closed before transcription completed"));
          return;
        }

        debugLogger.debug("parakeet-ws transcription completed", {
          elapsed,
          code,
          resultLength: result.length,
          resultPreview: result.slice(0, 200),
        });

        resolve({ text: parseOfflineMessage(result), elapsed });
      });

      ws.on("error", (error: Error) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`parakeet-ws transcription failed: ${error.message}`));
      });
    });
  }

  // samplesBuffer must already be 16kHz float32.
  async _transcribeOnline(samplesBuffer: Buffer, signal?: AbortSignal): Promise<{ text: string; elapsed: number; truncated?: boolean }> {
    if (signal?.aborted) throw createAbortError("parakeet-ws transcription cancelled");

    const startTime = Date.now();
    let streamError: Error | null = null;
    let timedOut = false;

    const stream = this.createOnlineStream({
      onError: (error: Error) => {
        streamError = error;
      },
    });

    debugLogger.debug("parakeet-ws sending streaming audio", {
      samplesBytes: samplesBuffer.length,
    });
    for (let offset = 0; offset < samplesBuffer.length; offset += ONLINE_CHUNK_BYTES) {
      stream.sendFloat32(samplesBuffer.subarray(offset, offset + ONLINE_CHUNK_BYTES));
    }

    // Blasted audio drains faster than real time but not instantly; scale both
    // the hard cap and the quiet-period allowance with the audio length.
    const audioSeconds = samplesBuffer.length / FLOAT32_BYTES_PER_SECOND;
    const timeout = setTimeout(
      () => {
        timedOut = true;
        stream.abort();
      },
      Math.max(TRANSCRIPTION_TIMEOUT_FLOOR_MS, audioSeconds * ONLINE_TIMEOUT_PER_AUDIO_SECOND_MS)
    );
    const onAbort = () => stream.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const idleTimeoutMs = Math.max(ONLINE_FINISH_IDLE_TIMEOUT_MS, audioSeconds * 500);
      const { text, truncated } = await stream.finish({ idleTimeoutMs });
      if (signal?.aborted) throw createAbortError("parakeet-ws transcription cancelled");
      if (timedOut) throw new Error("parakeet-ws transcription timed out");
      if (streamError) {
        throw new Error(`parakeet-ws transcription failed: ${(streamError as Error).message}`);
      }

      const elapsed = Date.now() - startTime;
      debugLogger.debug("parakeet-ws streaming transcription completed", {
        elapsed,
        truncated,
        resultLength: text.length,
        resultPreview: text.slice(0, 200),
      });
      return truncated ? { text, elapsed, truncated } : { text, elapsed };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  createOnlineStream({ onUpdate, onError }: { onUpdate?: (text: string) => void; onError?: (error: Error) => void } = {}): { sendFloat32(b: Buffer): void; sendPcm16(b: Buffer): void; finish(o?: { idleTimeoutMs?: number }): Promise<{ text: string; truncated: boolean }>; abort(): void } {
    if (!this.ready || !this.process) {
      throw new Error("parakeet-ws server is not running");
    }
    if (this.modelRuntime !== "online") {
      throw new Error("createOnlineStream requires an online-runtime model");
    }

    const results = createOnlineAccumulator();
    const pendingChunks: Buffer[] = [];
    let finishResolve: ((value: { text: string; truncated: boolean }) => void) | null = null;
    let finishPromise: Promise<{ text: string; truncated: boolean }> | null = null;
    let idleTimeoutMs = ONLINE_FINISH_IDLE_TIMEOUT_MS;
    let idleTimer: NodeJS.Timeout | null = null;
    let closed = false;
    let aborted = false;
    let serverDone = false;
    let truncated = false;
    let lastEmitted = "";

    const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);

    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const settle = () => {
      if (closed) return;
      closed = true;
      clearIdleTimer();
      if (finishResolve) finishResolve({ text: results.text(), truncated });
    };

    // Backstop for a server that goes quiet after "Done": while results keep
    // arriving the deadline keeps extending; only true silence is a truncation.
    const armIdleTimer = () => {
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        if (closed) return;
        truncated = true;
        debugLogger.warn("parakeet-ws online finish timed out; result may be truncated");
        try {
          ws.close();
        } catch {}
        settle();
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };

    const sendFloat32 = (float32Samples: Buffer) => {
      if (closed) return;
      // A chunk after finish() means the renderer flushed late (contract broke) so the
      // tail is lost; when only closed is set, settle already happened and a plain drop is fine.
      if (finishResolve) {
        truncated = true;
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(float32Samples, (err: Error | undefined) => {
          if (err) {
            truncated = true;
            debugLogger.error("parakeet-ws online stream send error", { error: (err as Error).message });
          }
        });
      } else {
        pendingChunks.push(float32Samples);
      }
    };

    ws.on("open", () => {
      for (const chunk of pendingChunks) {
        ws.send(chunk, (err: Error | undefined) => {
          if (err) {
            truncated = true;
            debugLogger.error("parakeet-ws online stream send error", { error: (err as Error).message });
          }
        });
      }
      pendingChunks.length = 0;
      if (finishResolve) ws.send("Done");
    });

    ws.on("message", (data: Buffer) => {
      const message = data.toString();
      if (finishResolve) armIdleTimer();
      if (message === "Done!") {
        serverDone = true;
        ws.close();
        return;
      }
      const text = results.push(message);
      if (!closed && text && text !== lastEmitted) {
        lastEmitted = text;
        onUpdate?.(text);
      }
    });

    ws.on("close", () => {
      if (!serverDone && !aborted && !closed) {
        truncated = true;
        onError?.(new Error("connection closed before transcription completed"));
      }
      settle();
    });

    ws.on("error", (error: Error) => {
      debugLogger.warn("parakeet-ws online stream error", { error: error.message });
      if (!serverDone && !aborted) truncated = true;
      onError?.(error);
      settle();
    });

    return {
      sendFloat32,
      sendPcm16: (pcmBuffer: Buffer) => sendFloat32(pcm16ToFloat32(pcmBuffer)),
      finish: (options: { idleTimeoutMs?: number } = {}) => {
        if (finishPromise) return finishPromise;
        if (options.idleTimeoutMs) idleTimeoutMs = options.idleTimeoutMs;
        finishPromise = new Promise<{ text: string; truncated: boolean }>((resolve) => {
          if (closed) {
            resolve({ text: results.text(), truncated });
            return;
          }
          finishResolve = resolve;
          if (ws.readyState === WebSocket.OPEN) ws.send("Done");
          armIdleTimer();
        });
        return finishPromise;
      },
      abort: () => {
        aborted = true;
        try {
          ws.close();
        } catch {}
        settle();
      },
    };
  }

  async stop(): Promise<void> {
    this.stopHealthCheck();

    if (!this.process) {
      this.ready = false;
      return;
    }

    debugLogger.debug("Stopping parakeet-ws server");

    try {
      await gracefulStopProcess(this.process);
    } catch (error) {
      debugLogger.error("Error stopping parakeet-ws server", { error: (error as Error).message });
    }

    this.process = null;
    this.ready = false;
    this.port = null;
    this.modelName = null;
    this.modelDir = null;
    this.modelRuntime = "offline";
    this.language = null;
  }

  getStatus(): { available: boolean; running: boolean; starting: boolean; port: number | null; modelName: string | null } {
    return {
      available: this.hasAnyWsBinary(),
      running: this.ready && this.process !== null,
      starting: this.startupPromise !== null,
      port: this.port,
      modelName: this.modelName || this.startingModelName,
    };
  }
}



// Dual export: legacy tests require this module as the class itself, while
// the TS graph imports the named export.
module.exports = ParakeetWsServer;
module.exports.ParakeetWsServer = ParakeetWsServer;
