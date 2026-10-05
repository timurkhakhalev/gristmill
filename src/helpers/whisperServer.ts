const { spawn } = require("child_process");

const EventEmitter = require("events");

const fs = require("fs");

const path = require("path");

import http from "http";

const os = require("os");

const debugLogger = require("./debugLogger.js");

const { ensureLocalEngine } = require("./localEngineInstaller.js");

const { killProcess } = require("../utils/process.js");

const { isPortAvailable, resolveBinaryPath } = require("../utils/serverUtils.js");

import { getSafeTempDir } from "./safeTempDir.js";

const { convertToWav } = require("./ffmpegUtils.js");

import { createAbortError } from "./abortError.js";
import * as sidecarPidFile from "./sidecarPidFile.js";
import { sanitizeWhisperVadConfig, DEFAULT_WHISPER_VAD_CONFIG } from "./whisperVadConfig.js";
import {
  computeTranscriptionTimeoutMs,
  PCM16_MONO_16K_BYTES_PER_SECOND,
} from "./transcriptionTimeout.js";

const PORT_RANGE_START = 8178;

const PORT_RANGE_END = 8199;

const STARTUP_TIMEOUT_MS = 30000;

const HEALTH_CHECK_INTERVAL_MS = 5000;

const HEALTH_CHECK_TIMEOUT_MS = 2000;

const DEFAULT_WHISPER_THREADS = 4;

const MAX_AUTO_WHISPER_THREADS = 12;

const MAX_MANUAL_WHISPER_THREADS = 64;

const AUTO_THREAD_RATIO = 0.75;

// Decoder anti-hallucination thresholds sent with /inference requests. whisper.cpp's
// defaults (entropy 2.4, logprob -1.0) let a mostly-silent 30s decode window pass the
// repetition check and emit training-data outro boilerplate ("Thank you for watching",
// "Продолжение следует..."). These values cut the hallucinated-tail rate from 2.25% to
// 0.06% over 4,814 real dictations. See #1458. The raised entropy also sends more
// windows into whisper.cpp's temperature-fallback loop (re-decoding a window up to
// ~6x), which a continuous load cannot afford: meeting chunks pass
// skipDecoderThresholds to keep the server defaults — they already have RMS-gate,
// VAD, and holdback/dedup hallucination protection.
export const INFERENCE_DECODER_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  entropy_thold: "2.8",
  logprob_thold: "-1.25",
});

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function parsePositiveInteger(value: unknown): number | null {
  const normalized = String(value ?? "").trim();

  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);

  return parsed > 0 ? parsed : null;
}

export function getAvailableParallelism(): number {
  try {
    if (typeof os.availableParallelism === "function") {
      return os.availableParallelism();
    }
  } catch {}

  const cpus = os.cpus();

  return Array.isArray(cpus) && cpus.length > 0 ? cpus.length : DEFAULT_WHISPER_THREADS;
}

export interface ThreadResolution {
  threads: number | null;
  source: string;
  availableParallelism: number;
}

export function createThreadResolution(
  threads: number | null,
  source: string,
  availableParallelism: number
): ThreadResolution {
  return { threads, source, availableParallelism };
}

export function resolveWhisperThreads(
  options: Record<string, unknown> = {},
  runtime: { availableParallelism?: unknown; env?: Record<string, string | undefined> } = {}
): ThreadResolution {
  const availableParallelism =
    parsePositiveInteger(runtime.availableParallelism) || getAvailableParallelism();

  const explicitThreads = parsePositiveInteger(options.threads);

  if (explicitThreads) {
    return createThreadResolution(
      clamp(explicitThreads, 1, MAX_MANUAL_WHISPER_THREADS),
      "options",
      availableParallelism
    );
  }

  const env = runtime.env || process.env;
  const envThreads = env.WHISPER_THREADS;
  const shouldAutoTune = !envThreads || String(envThreads).trim().toLowerCase() === "auto";

  if (!shouldAutoTune) {
    const parsedEnvThreads = parsePositiveInteger(envThreads);

    if (parsedEnvThreads) {
      return createThreadResolution(
        clamp(parsedEnvThreads, 1, MAX_MANUAL_WHISPER_THREADS),
        "env",
        availableParallelism
      );
    }
  }

  const autoThreads = clamp(
    Math.floor(availableParallelism * AUTO_THREAD_RATIO),
    DEFAULT_WHISPER_THREADS,
    MAX_AUTO_WHISPER_THREADS
  );

  if (autoThreads <= DEFAULT_WHISPER_THREADS) {
    return createThreadResolution(
      null,
      shouldAutoTune ? "default" : "invalid-env",
      availableParallelism
    );
  }

  return createThreadResolution(
    autoThreads,
    shouldAutoTune ? "auto" : "invalid-env-auto",
    availableParallelism
  );
}

export function shouldFallbackToDefaultThreads(resolution: ThreadResolution): boolean {
  return (
    resolution.threads !== null &&
    (resolution.source === "auto" || resolution.source === "invalid-env-auto")
  );
}

export function getThreadSignature(resolution: ThreadResolution): string {
  return `threads:${resolution.threads || "default"}`;
}

function isVadActive(options: { vadEnabled?: unknown; vadModelPath?: unknown } = {}): boolean {
  return options.vadEnabled === true && !!options.vadModelPath;
}

export function getVadSignature(
  options: { vadEnabled?: unknown; vadModelPath?: unknown; vadConfig?: unknown } = {}
): string {
  if (!isVadActive(options)) return "vad:off";

  const vadConfig = sanitizeWhisperVadConfig(
    (options.vadConfig as Record<string, unknown> | null) || DEFAULT_WHISPER_VAD_CONFIG
  );

  return `vad:on:${String(options.vadModelPath)}:${JSON.stringify(vadConfig)}`;
}

export interface WhisperServerArgsInput {
  modelPath: string;
  port: number;
  language?: string | null;
  threads?: number | null;
  vadEnabled?: boolean;
  vadModelPath?: string | null;
  vadConfig?: unknown;
}

export function buildWhisperServerArgs({
  modelPath,
  port,
  language,
  threads,
  vadEnabled = false,
  vadModelPath = null,
  vadConfig,
}: WhisperServerArgsInput): string[] {
  const args = ["--model", modelPath, "--host", "127.0.0.1", "--port", String(port)];

  if (threads) args.push("--threads", String(threads));

  // whisper.cpp defaults to English when --language is omitted;
  // explicitly pass "auto" to enable language auto-detection
  args.push("--language", language || "auto");

  // whisper.cpp v1.9.x turned token timestamps on for every request and forces max_len=60
  // when it is unset, so the server wraps segments at 60 characters. split_on_word is off,
  // so the wrap lands on a token boundary and breaks words mid-word ("abschalten" -> "abs" +
  // "chalten"); we join segments into one string, so the break surfaces as a stray space.
  // See #1348.
  //
  // Raise max_len to switch the wrap off rather than passing --no-timestamps, which took the
  // decoder's timestamp tokens with it: without them whisper.cpp advances `seek` a full 30s
  // window no matter where the decode actually stopped, silently discarding the audio in
  // between. See #2150. A segment covers at most one 30s window; the longest measured is
  // 186 characters.
  args.push("--max-len", "4096");

  if (isVadActive({ vadEnabled, vadModelPath })) {
    const cfg = sanitizeWhisperVadConfig(
      (vadConfig as Record<string, unknown> | null) || DEFAULT_WHISPER_VAD_CONFIG
    );

    args.push(
      "--vad",
      "--vad-model",
      vadModelPath as string,
      "--vad-threshold",
      String(cfg.threshold),
      "--vad-min-speech-duration-ms",
      String(cfg.minSpeechDurationMs),
      "--vad-min-silence-duration-ms",
      String(cfg.minSilenceDurationMs),
      "--vad-max-speech-duration-s",
      String(cfg.maxSpeechDurationS),
      "--vad-speech-pad-ms",
      String(cfg.speechPadMs),
      "--vad-samples-overlap",
      String(cfg.samplesOverlap)
    );
  }

  return args;
}

export class WhisperServerManager extends EventEmitter {
  private startupIdentity: string | null = null;
  private activeStartIdentity: string | null = null;
  private stopGeneration = 0;

  constructor() {
    super();
    this.process = null;
    this.hostname = "127.0.0.1";
    this.port = null;
    this.ready = false;
    this.isRemote = false;
    this.modelPath = null;
    this.startupPromise = null;
    this.healthCheckInterval = null;
    this.cachedServerBinaryPath = null;
    this.cachedFFmpegPath = null;
    this.canConvert = false;
    this.startGeneration = 0;
    this._stopRequested = false;
    this.vadSignature = "vad:off";
    this.threadSignature = "threads:default";
    this.lastStartOptions = {};
  }

  getFFmpegPath() {
    if (this.cachedFFmpegPath) return this.cachedFFmpegPath;

    try {
      let ffmpegPath: string = require("ffmpeg-static");
      ffmpegPath = path.normalize(ffmpegPath);

      // Try unpacked ASAR path first (production builds unpack ffmpeg-static)
      const unpackedPath = ffmpegPath.includes("app.asar")
        ? ffmpegPath.replace(/app\.asar([/\\])/, "app.asar.unpacked$1")
        : null;

      if (unpackedPath && fs.existsSync(unpackedPath)) {
        try {
          fs.accessSync(unpackedPath, fs.constants.X_OK);
        } catch {
          try {
            fs.chmodSync(unpackedPath, 0o755);
          } catch (chmodErr) {
            debugLogger.warn("Failed to chmod FFmpeg", { error: (chmodErr as Error).message });
          }
        }

        this.cachedFFmpegPath = unpackedPath;

        return unpackedPath;
      }

      // Try original path (development or if not in ASAR)
      if (fs.existsSync(ffmpegPath)) {
        try {
          fs.accessSync(ffmpegPath, fs.constants.X_OK);
        } catch {
          debugLogger.debug("FFmpeg exists but not executable", { ffmpegPath });
          throw new Error("Not executable");
        }

        this.cachedFFmpegPath = ffmpegPath;

        return ffmpegPath;
      }
    } catch (err) {
      debugLogger.debug("Bundled FFmpeg not available", { error: (err as Error).message });
    }

    // Try system FFmpeg locations
    const systemCandidates = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];

    for (const candidate of systemCandidates) {
      if (fs.existsSync(candidate)) {
        this.cachedFFmpegPath = candidate;

        return candidate;
      }
    }

    const pathEnv = process.env.PATH || "";
    const pathDirs = pathEnv.split(":").map((entry) => entry.replace(/^"|"$/g, ""));
    const pathBinary = "ffmpeg";

    for (const dir of pathDirs) {
      if (!dir) continue;
      const candidate = path.join(dir, pathBinary);

      if (!fs.existsSync(candidate)) continue;

      try {
        fs.accessSync(candidate, fs.constants.X_OK);
      } catch {
        continue;
      }

      this.cachedFFmpegPath = candidate;

      return candidate;
    }

    debugLogger.debug("FFmpeg not found");

    return null;
  }

  getServerBinaryPath(): string | null {
    if (this.cachedServerBinaryPath) return this.cachedServerBinaryPath;

    const resolved = resolveBinaryPath("whisper-server-darwin-arm64");

    if (resolved) this.cachedServerBinaryPath = resolved;

    return resolved;
  }

  isAvailable(): boolean {
    return this.getServerBinaryPath() !== null;
  }

  async connectRemote(url: string): Promise<void> {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    const port = parseInt(parsed.port, 10) || (parsed.protocol === "https:" ? 443 : 80);

    debugLogger.debug("Connecting to remote whisper-server", { hostname, port });

    const reachable = await new Promise((resolve) => {
      const req = http.request(
        { hostname, port, path: "/", method: "GET", timeout: HEALTH_CHECK_TIMEOUT_MS },
        (res: http.IncomingMessage) => {
          resolve(true);
          res.resume();
        }
      );

      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });

    if (!reachable) {
      throw new Error(`Remote whisper-server unreachable at ${hostname}:${port}`);
    }

    if (this.process) {
      await this.stop();
    }

    this.hostname = hostname;
    this.port = port;
    this.ready = true;
    this.isRemote = true;
    this.canConvert = !!this.getFFmpegPath();

    this.startHealthCheck();

    debugLogger.info("Connected to remote whisper-server", { hostname, port });
  }

  async findAvailablePort(): Promise<number> {
    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
      if (await isPortAvailable(port)) return port;
    }

    throw new Error(`No available ports in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
  }

  async start(modelPath: string, options: Record<string, unknown> = {}): Promise<void> {
    const requestedOptions: Record<string, unknown> = {
      ...options,
      ...(options.vadConfig
        ? { vadConfig: sanitizeWhisperVadConfig(options.vadConfig as Record<string, unknown>) }
        : {}),
    };

    const threadResolution = resolveWhisperThreads(requestedOptions);
    const nextThreadSignature = getThreadSignature(threadResolution);
    const nextVadSignature = getVadSignature(requestedOptions);

    const identity = JSON.stringify([
      modelPath,
      nextThreadSignature,
      threadResolution.source,
      nextVadSignature,
      requestedOptions.language || "auto",
    ]);

    if (this.startupPromise && this.startupIdentity === identity) return this.startupPromise;
    const generation = this.stopGeneration;
    const previous = this.startupPromise as Promise<void> | null;

    const operation = (previous ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (generation !== this.stopGeneration)
          throw new Error("whisper-server startup interrupted by stop");
        this.lastStartOptions = requestedOptions;

        if (this.ready && !this.isRemote && this.activeStartIdentity === identity) return;

        if (this.process || this.isRemote) await this.stopProcess();

        if (generation !== this.stopGeneration)
          throw new Error("whisper-server startup interrupted by stop");
        this.isRemote = false;
        this.hostname = "127.0.0.1";
        this.vadSignature = nextVadSignature;
        this.threadSignature = nextThreadSignature;
        await this._doStart(modelPath, { ...requestedOptions, threadResolution }, generation);

        if (generation !== this.stopGeneration)
          throw new Error("whisper-server startup interrupted by stop");
        this.activeStartIdentity = identity;
      });

    this.startupPromise = operation;
    this.startupIdentity = identity;

    try {
      await operation;
    } finally {
      if (this.startupPromise === operation) {
        this.startupPromise = null;
        this.startupIdentity = null;
      }
    }
  }

  async _doStart(
    modelPath: string,
    options: Record<string, unknown> & { threadResolution?: ThreadResolution } = {},
    generation = this.stopGeneration
  ): Promise<void> {
    if (!fs.existsSync(modelPath)) throw new Error(`Model file not found: ${modelPath}`);
    this.startGeneration += 1;
    this._stopRequested = false;

    const threadResolution: ThreadResolution =
      options.threadResolution || resolveWhisperThreads(options);

    const serverBinary = this.getServerBinaryPath();

    if (!serverBinary) {
      await ensureLocalEngine("whisper-cpp");
    }

    const resolvedBinary = serverBinary ?? this.getServerBinaryPath();

    if (!resolvedBinary) throw new Error("whisper-server binary not found");

    const port = await this.findAvailablePort();

    if (generation !== this.stopGeneration)
      throw new Error("whisper-server startup interrupted by stop");
    this.port = port;
    this.modelPath = modelPath;

    // Check for FFmpeg first - only use --convert flag if FFmpeg is available
    const ffmpegPath = this.getFFmpegPath();
    const spawnEnv = { ...process.env };
    const pathSep = ":";

    // Add the whisper-server directory to PATH so any companion DLLs are found
    const serverBinaryDir = path.dirname(resolvedBinary);
    spawnEnv.PATH = serverBinaryDir + pathSep + (process.env.PATH || "");

    const args = buildWhisperServerArgs({
      modelPath,
      port: this.port,
      language: options.language as string | null | undefined,
      threads: threadResolution.threads,
      vadEnabled: options.vadEnabled === true,
      vadModelPath: (options.vadModelPath as string | null) || null,
      vadConfig: options.vadConfig,
    });

    // FFmpeg is required for pre-converting audio to 16kHz mono WAV
    this.canConvert = !!ffmpegPath;

    if (ffmpegPath) {
      const ffmpegDir = path.dirname(ffmpegPath);
      spawnEnv.PATH = ffmpegDir + pathSep + spawnEnv.PATH;
    } else {
      debugLogger.warn("FFmpeg not found - whisper-server will only accept 16kHz mono WAV");
    }

    debugLogger.debug("Starting whisper-server", {
      port: this.port,
      modelPath,
      args,
      cwd: serverBinaryDir,
      threads: threadResolution,
    });

    this.process = spawn(resolvedBinary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: spawnEnv,
      cwd: serverBinaryDir,
      detached: true,
    });
    sidecarPidFile.write("whisper", this.process.pid);

    let stderrBuffer = "";
    let exitCode: number | null = null;

    this.process.stdout?.on("data", (data: Buffer) => {
      debugLogger.debug("whisper-server stdout", { data: data.toString().trim() });
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      stderrBuffer += data.toString();
      debugLogger.debug("whisper-server stderr", { data: data.toString().trim() });
    });

    this.process.on("error", (error: Error) => {
      debugLogger.error("whisper-server process error", { error: error.message });
      this.ready = false;
    });

    this.process.on("close", (code: number | null) => {
      exitCode = code;
      debugLogger.debug("whisper-server process exited", { code });
      this.ready = false;
      this.process = null;
      this.stopHealthCheck();
      sidecarPidFile.clear("whisper");
    });

    try {
      await this.waitForReady(() => ({ stderr: stderrBuffer, exitCode }), STARTUP_TIMEOUT_MS);
    } catch (err: unknown) {
      if ((err as { isStopped?: boolean }).isStopped) throw err;

      if (shouldFallbackToDefaultThreads(threadResolution)) {
        const defaultThreadResolution = createThreadResolution(
          null,
          "auto-fallback",
          threadResolution.availableParallelism
        );

        debugLogger.warn("Auto whisper thread count failed, falling back to default", {
          selectedThreads: threadResolution.threads,
          availableParallelism: threadResolution.availableParallelism,
          stderr: stderrBuffer.slice(0, 200),
        });
        await this.stopProcess();
        this.threadSignature = getThreadSignature(threadResolution);

        return this._doStart(
          modelPath,
          {
            ...options,
            threadResolution: defaultThreadResolution,
          },
          generation
        );
      }

      throw err;
    }

    if (generation !== this.stopGeneration)
      throw new Error("whisper-server startup interrupted by stop");
    this.startHealthCheck();

    debugLogger.info("whisper-server started successfully", {
      port: this.port,
      model: path.basename(modelPath),
      threads: threadResolution.threads || DEFAULT_WHISPER_THREADS,
      threadSource: threadResolution.source,
      availableParallelism: threadResolution.availableParallelism,
    });
  }

  async waitForReady(
    getProcessInfo: (() => { stderr?: string | null; exitCode: number | null }) | null,
    timeoutMs = STARTUP_TIMEOUT_MS
  ): Promise<void> {
    const startTime = Date.now();
    let pollCount = 0;

    // Poll every 100ms during startup (faster than ongoing health checks at 5000ms)
    // This saves 0-400ms average vs 500ms polling
    const STARTUP_POLL_INTERVAL_MS = 100;

    while (Date.now() - startTime < timeoutMs) {
      if (this._stopRequested) {
        throw Object.assign(new Error("whisper-server startup interrupted by stop"), {
          isStopped: true,
        });
      }

      if (!this.process || this.process.killed) {
        const info = getProcessInfo ? getProcessInfo() : { stderr: null, exitCode: null };

        const stderr = info.stderr ? info.stderr.trim().slice(0, 200) : "";
        const details = stderr || (info.exitCode !== null ? `exit code: ${info.exitCode}` : "");
        throw new Error(
          `whisper-server process died during startup${details ? `: ${details}` : ""}`
        );
      }

      pollCount++;

      if (await this.checkHealth()) {
        this.ready = true;
        debugLogger.debug("whisper-server ready", {
          startupTimeMs: Date.now() - startTime,
          pollCount,
        });

        return;
      }

      await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_INTERVAL_MS));
    }

    throw new Error(`whisper-server failed to start within ${timeoutMs}ms`);
  }

  checkHealth(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: this.hostname,
          port: this.port,
          path: "/",
          method: "GET",
          timeout: HEALTH_CHECK_TIMEOUT_MS,
        },
        (res) => {
          resolve(true);
          res.resume();
        }
      );

      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthCheckInterval = setInterval(async () => {
      if (!this.isRemote && !this.process) {
        this.stopHealthCheck();

        return;
      }

      if (!(await this.checkHealth())) {
        debugLogger.warn("whisper-server health check failed");
        this.ready = false;
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  async transcribe(
    audioBuffer: Buffer,
    options: {
      language?: string | null;
      initialPrompt?: string | null;
      signal?: AbortSignal;
      skipDecoderThresholds?: boolean;
    } = {}
  ): Promise<Record<string, unknown>> {
    if (!this.ready || (!this.process && !this.isRemote)) {
      throw new Error("whisper-server is not running");
    }

    // Debug: Log audio buffer info
    debugLogger.debug("whisper-server transcribe called", {
      bufferLength: audioBuffer?.length || 0,
      bufferType: audioBuffer?.constructor?.name,
      firstBytes:
        audioBuffer?.length >= 16
          ? Array.from(audioBuffer.slice(0, 16))
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(" ")
          : "too short",
    });

    // signal is optional; only cancellable uploads pass one.
    const { language, initialPrompt, signal, skipDecoderThresholds } = options;

    if (signal?.aborted) throw createAbortError("whisper-server transcription cancelled");

    // Always convert to 16kHz mono WAV - whisper.cpp requires this exact format
    let finalBuffer = audioBuffer;

    if (!this.canConvert) {
      throw new Error("FFmpeg not found - required for audio conversion");
    }

    finalBuffer = await this._convertToWav(audioBuffer, signal);

    const boundary = `----WhisperBoundary${Date.now()}`;
    const parts = [];
    const fileName = "audio.wav";
    const contentType = "audio/wav";

    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`
    );
    parts.push(finalBuffer);
    parts.push("\r\n");

    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="language"\r\n\r\n` +
        `${language || "auto"}\r\n`
    );

    if (!skipDecoderThresholds) {
      for (const [name, value] of Object.entries(INFERENCE_DECODER_FIELDS)) {
        parts.push(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
            `${value}\r\n`
        );
      }
    }

    // Add initial prompt for custom dictionary words
    if (initialPrompt) {
      parts.push(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="prompt"\r\n\r\n` +
          `${initialPrompt}\r\n`
      );
      debugLogger.info("Using custom dictionary prompt", { prompt: initialPrompt });
    }

    parts.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
        `json\r\n`
    );
    parts.push(`--${boundary}--\r\n`);

    const bodyParts = parts.map((part) => (typeof part === "string" ? Buffer.from(part) : part));
    const body = Buffer.concat(bodyParts);

    return await this._postInference(body, boundary, signal);
  }

  _postInference(
    body: Buffer,
    boundary: string,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    // Multipart boilerplate adds under a kilobyte, so body length tracks audio length.
    const timeoutMs = computeTranscriptionTimeoutMs(body.length / PCM16_MONO_16K_BYTES_PER_SECOND);

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError("whisper-server request cancelled"));

        return;
      }

      const startTime = Date.now();

      const req = http.request(
        {
          hostname: this.hostname,
          port: this.port,
          path: "/inference",
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": body.length,
          },
          timeout: timeoutMs,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            removeAbortListener();
            debugLogger.debug("whisper-server transcription completed", {
              statusCode: res.statusCode,
              elapsed: Date.now() - startTime,
              responseLength: data.length,
              responsePreview: data.slice(0, 500),
            });

            if (res.statusCode !== 200) {
              reject(new Error(`whisper-server returned status ${res.statusCode}: ${data}`));

              return;
            }

            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Failed to parse whisper-server response: ${(e as Error).message}`));
            }
          });
        }
      );

      // whisper-server has no mid-inference cancellation: destroying the
      // request frees this pipeline immediately, but the server finishes its
      // in-flight decode on its own.
      const onAbort = () => {
        req.destroy();
        reject(createAbortError("whisper-server request cancelled"));
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      const removeAbortListener = () => signal?.removeEventListener("abort", onAbort);

      req.on("error", (error: NodeJS.ErrnoException) => {
        removeAbortListener();

        const err = Object.assign(new Error(`whisper-server request failed: ${error.message}`), {
          isConnectionError: true,
          code: error.code,
        }) as Error & { isConnectionError: boolean; code?: string };

        reject(err);
      });
      req.on("timeout", () => {
        removeAbortListener();
        req.destroy();
        reject(new Error("whisper-server request timed out"));
      });

      req.write(body);
      req.end();
    });
  }

  async _convertToWav(audioBuffer: Buffer, signal?: AbortSignal): Promise<Buffer> {
    const tempDir = getSafeTempDir();
    const timestamp = Date.now();
    const tempInputPath = path.join(tempDir, `whisper-input-${timestamp}.webm`);
    const tempWavPath = path.join(tempDir, `whisper-output-${timestamp}.wav`);

    try {
      fs.writeFileSync(tempInputPath, audioBuffer);
      await convertToWav(tempInputPath, tempWavPath, { sampleRate: 16000, channels: 1, signal });

      return fs.readFileSync(tempWavPath);
    } finally {
      for (const f of [tempInputPath, tempWavPath]) {
        try {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.stopGeneration += 1;
    const pending = this.startupPromise as Promise<void> | null;

    const operation = Promise.all([this.stopProcess(), pending?.catch(() => {})]).then(() => {
      this.stopHealthCheck();
      this.ready = false;
      this.activeStartIdentity = null;
    });

    this.startupPromise = operation;
    this.startupIdentity = null;

    try {
      await operation;
    } finally {
      if (this.startupPromise === operation) this.startupPromise = null;
    }
  }

  private async stopProcess(): Promise<void> {
    this._stopRequested = true;
    this.stopHealthCheck();

    if (this.isRemote) {
      debugLogger.debug("Disconnecting from remote whisper-server");
      this.ready = false;
      this.isRemote = false;
      this.hostname = "127.0.0.1";
      this.port = null;

      return;
    }

    if (!this.process) {
      this.ready = false;

      return;
    }

    debugLogger.debug("Stopping whisper-server");

    try {
      killProcess(this.process, "SIGTERM");

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) {
            killProcess(this.process, "SIGKILL");
          }

          resolve();
        }, 5000);

        if (this.process) {
          this.process.once("close", () => {
            clearTimeout(timeout);
            resolve();
          });
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });
    } catch (error) {
      debugLogger.error("Error stopping whisper-server", { error: (error as Error).message });
    }

    this.process = null;
    this.ready = false;
    this.port = null;
    this.modelPath = null;
  }

  getStatus(): Record<string, unknown> {
    const running = this.ready && (this.process !== null || this.isRemote);

    return {
      available: this.isAvailable(),
      running,
      port: this.port,
      hostname: this.hostname,
      isRemote: this.isRemote,
      modelPath: this.modelPath,
      modelName: this.modelPath ? path.basename(this.modelPath, ".bin").replace("ggml-", "") : null,
    };
  }
}

// Dual export: legacy tests require this module as the class and read the
// argv/thread/VAD helpers as its statics, while the TS graph imports the
// named exports.
module.exports = WhisperServerManager;

module.exports.WhisperServerManager = WhisperServerManager;

module.exports.buildWhisperServerArgs = buildWhisperServerArgs;

module.exports.INFERENCE_DECODER_FIELDS = INFERENCE_DECODER_FIELDS;

module.exports.getVadSignature = getVadSignature;

module.exports.resolveWhisperThreads = resolveWhisperThreads;
