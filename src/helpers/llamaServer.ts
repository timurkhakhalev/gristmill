import { spawn, type ChildProcessByStdio } from "child_process";
import type { Readable } from "stream";
const fs = require("fs");
const path = require("path");
const http = require("http");
const debugLogger = require("./debugLogger.js");
const { ensureLocalEngine } = require("./localEngineInstaller.js");
import { killProcess } from "../utils/process.js";
import { isPortAvailable, resolveBinaryPath } from "../utils/serverUtils.js";
import { getSafeTempDir } from "./safeTempDir.js";
import * as sidecarPidFile from "./sidecarPidFile.js";

// Range kept clear of cliBridge (8200-8219) to avoid port-bind collisions.
const PORT_RANGE_START = 8221;
const PORT_RANGE_END = 8240;
const STARTUP_TIMEOUT_MS = 120000;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 2000;
const STARTUP_POLL_INTERVAL_MS = 500;
const HEALTH_CHECK_FAILURE_THRESHOLD = 3;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CONTEXT_SIZE = 4096;
const PREFLIGHT_TIMEOUT_MS = 10000;

export interface LlamaServerOptions {
  contextSize?: number;
  threads?: number;
  gpuLayers?: number;
  draftModelPath?: string | null;
  cacheRamMiB?: number | null;
}

export interface ChatMessage {
  role: string;
  content: string;
}

export interface InferenceOptions {
  temperature?: number;
  max_tokens?: number;
  disableThinking?: boolean;
  requireCompleteOutput?: boolean;
  signal?: AbortSignal;
}

interface CountPromptTokensOptions {
  disableThinking?: boolean;
}

interface ServerBinaryPaths {
  default: string;
}

// A typed llama-server failure: CONTEXT_TOO_LARGE carries the two numbers the
// renderer translates; everything else stays a plain Error.
export interface LlamaResponseError extends Error {
  code?: string;
  neededTokens?: number | null;
  maxContextTokens?: number | null;
}

/**
 * llama-server reports a prompt that overflows the context as a 400 whose body
 * is a JSON blob. Surfacing that verbatim is how customers ended up reading
 * llama.cpp internals in a toast (#2142), so it becomes a typed error carrying
 * the two numbers callers actually need.
 */
function buildResponseError(statusCode: number, body: string): LlamaResponseError {
  if (statusCode === 400) {
    try {
      const parsed = JSON.parse(body)?.error as
        | { type?: string; message?: string; n_prompt_tokens?: number; n_ctx?: number }
        | undefined;
      const isOverflow =
        parsed?.type === "exceed_context_size_error" ||
        /exceeds the available context size/i.test(parsed?.message || "");

      if (isOverflow) {
        const neededTokens = Number(parsed?.n_prompt_tokens) || null;
        const maxContextTokens = Number(parsed?.n_ctx) || null;
        const error = new Error(
          neededTokens && maxContextTokens
            ? `The request needs ${neededTokens} tokens of context but the model is running with ${maxContextTokens}.`
            : "The request is longer than the context this model is running with."
        ) as LlamaResponseError;
        error.code = "CONTEXT_TOO_LARGE";
        error.neededTokens = neededTokens;
        error.maxContextTokens = maxContextTokens;
        return error;
      }
    } catch {
      // Not JSON, or not the shape we expect: fall through to the generic error.
    }
  }

  return new Error(`llama-server returned status ${statusCode}: ${body}`);
}

export class LlamaServerManager {
  process: ChildProcessByStdio<null, Readable, Readable> | null;
  port: number | null;
  ready: boolean;
  modelPath: string | null;
  // draftModelPath is the REQUESTED drafter (stable across identical requests, drives
  // the start() restart check); activeDraftModelPath is the one that actually loaded.
  draftModelPath: string | null;
  activeDraftModelPath: string | null;
  // The context that actually loaded.
  activeContextSize: number | null;
  // The context the running server was started with. Grows on demand and is
  // only reset by stop(), so a short request cannot shrink a window a long
  // one just paid to open. See #2142.
  contextSize: number | null;
  startupPromise: Promise<void> | null;
  healthCheckInterval: NodeJS.Timeout | null;
  healthCheckFailures: number;
  cachedServerBinaryPaths: ServerBinaryPaths | null;
  activeBackend: string | null;
  idleTimer: NodeJS.Timeout | null;

  constructor() {
    this.process = null;
    this.port = null;
    this.ready = false;
    this.modelPath = null;
    this.draftModelPath = null;
    this.activeDraftModelPath = null;
    this.activeContextSize = null;
    this.contextSize = null;
    this.startupPromise = null;
    this.healthCheckInterval = null;
    this.healthCheckFailures = 0;
    this.cachedServerBinaryPaths = null;
    this.activeBackend = null;
    this.idleTimer = null;
  }

  getServerBinaryPaths(): ServerBinaryPaths {
    if (this.cachedServerBinaryPaths) return this.cachedServerBinaryPaths;

    const defaultBin = resolveBinaryPath("llama-server-darwin-arm64");
    const paths: ServerBinaryPaths = defaultBin ? { default: defaultBin } : { default: "" };

    // Only cache hits: a miss may be transient (binary downloaded after
    // startup), and caching it would require an app restart to recover.
    if (paths.default) {
      this.cachedServerBinaryPaths = paths;
    }
    return paths;
  }

  isAvailable(): boolean {
    const paths = this.getServerBinaryPaths();
    return Boolean(paths.default);
  }

  async findAvailablePort(): Promise<number> {
    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
      if (await isPortAvailable(port)) return port;
    }
    throw new Error(`No available ports in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
  }

  async start(modelPath: string, options: LlamaServerOptions = {}): Promise<void> {
    if (this.startupPromise) return this.startupPromise;

    // A change in drafter presence for the same model must still restart the
    // server so the new speculative-decoding flags take effect.
    const requestedDraftPath = options.draftModelPath || null;
    const requestedContextSize = options.contextSize || DEFAULT_CONTEXT_SIZE;
    if (
      this.ready &&
      this.modelPath === modelPath &&
      this.draftModelPath === requestedDraftPath &&
      requestedContextSize <= (this.contextSize || 0)
    )
      return;

    if (this.process) {
      await this.stop();
    }

    this.startupPromise = this._doStart(modelPath, options);
    try {
      await this.startupPromise;
      // Record the context that loaded, not only what was requested.
      this.contextSize = this.activeContextSize ?? requestedContextSize;
    } finally {
      this.startupPromise = null;
    }
  }

  _buildBaseArgs(modelPath: string, port: number, options: LlamaServerOptions = {}): string[] {
    const args = [
      "--model",
      modelPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--threads",
      String(options.threads || 4),
      // Unset, this defaults to the model's full trained context (128K+),
      // whose KV cache can exceed total RAM with --fit disabled. See #1203.
      // Sized per request against a memory budget by llamaContextPolicy.
      "--ctx-size",
      String(options.contextSize || DEFAULT_CONTEXT_SIZE),
      "--jinja",
    ];

    // llama-server otherwise reserves 8192 MiB of host RAM for the prompt
    // cache, on top of the KV cache, which would undo the memory budget. Cap
    // it rather than disabling it: 0 forces a full re-prefill every request.
    if (options.cacheRamMiB) args.push("--cache-ram", String(options.cacheRamMiB));

    return args;
  }

  async _doStart(modelPath: string, options: LlamaServerOptions = {}): Promise<void> {
    if (!fs.existsSync(modelPath)) throw new Error(`Model file not found: ${modelPath}`);
    let binaryPaths = this.getServerBinaryPaths();
    if (!binaryPaths.default) {
      await ensureLocalEngine("llama-server");
      binaryPaths = this.getServerBinaryPaths();
    }
    if (!binaryPaths.default) throw new Error("llama-server binary not found");

    this.port = await this.findAvailablePort();
    this.modelPath = modelPath;
    // Store the REQUESTED drafter so start() compares against a stable value across
    // identical requests; activeDraftModelPath tracks what actually loaded (see ctor).
    this.draftModelPath = options.draftModelPath || null;
    this.activeDraftModelPath = null;

    this.activeContextSize = options.contextSize || DEFAULT_CONTEXT_SIZE;
    const baseArgs = this._buildBaseArgs(modelPath, this.port, options);

    // Draft flags stay separate from baseArgs so the fallback ladder can retry without
    // them when a stale (pre-b9763) binary rejects the MTP args at parse time.
    const draftArgs = options.draftModelPath
      ? [
          "--model-draft",
          options.draftModelPath,
          "--spec-type",
          "draft-mtp",
          "--spec-draft-n-max",
          "3",
        ]
      : [];

    const args = [...baseArgs, "--n-gpu-layers", String(options.gpuLayers ?? 99), ...draftArgs];
    await this._startWithBinary(
      binaryPaths.default,
      args,
      this._buildEnv(binaryPaths.default),
      STARTUP_TIMEOUT_MS
    );
    this.activeBackend = "metal";
    this.activeDraftModelPath = this.draftModelPath;

    this.startHealthCheck();
    this.resetIdleTimer();
    debugLogger.info("llama-server started successfully", {
      port: this.port,
      model: path.basename(modelPath),
      backend: this.activeBackend,
      mtp: this.activeDraftModelPath !== null,
    });
  }

  _buildEnv(binaryPath: string): NodeJS.ProcessEnv {
    const binDir = path.dirname(binaryPath);
    const env: NodeJS.ProcessEnv = { ...process.env };

    env.DYLD_LIBRARY_PATH = binDir + (env.DYLD_LIBRARY_PATH ? `:${env.DYLD_LIBRARY_PATH}` : "");

    // Disable llama.cpp auto-fit memory probing (adds ~70s to startup). Set via env
    // so builds without --fit ignore it instead of erroring. See LLAMA_ARG_FIT.
    env.LLAMA_ARG_FIT = process.env.LLAMA_ARG_FIT || "off";

    return env;
  }

  _startWithBinary(binaryPath: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      debugLogger.debug("Spawning llama-server", { binary: binaryPath, port: this.port, args });

      this.process = spawn(binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: getSafeTempDir(),
        env,
        detached: true,
      });
      if (this.process.pid !== undefined) sidecarPidFile.write("llama", this.process.pid);

      let stderrBuffer = "";
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      this.process.stdout.on("data", (data) => {
        debugLogger.debug("llama-server stdout", { data: data.toString().trim() });
      });

      this.process.stderr.on("data", (data) => {
        stderrBuffer += data.toString();
        debugLogger.debug("llama-server stderr", { data: data.toString().trim() });
      });

      this.process.on("error", (error) => {
        debugLogger.error("llama-server process error", { error: error.message });
        this.ready = false;
        settle(() => reject(new Error(`Failed to spawn llama-server: ${error.message}`)));
      });

      this.process.on("close", (code, signal) => {
        exitCode = code ?? null;
        exitSignal = signal ?? null;
        debugLogger.debug("llama-server process exited", { code, signal });
        this.ready = false;
        this.process = null;
        this.stopHealthCheck();
        sidecarPidFile.clear("llama");
      });

      const getProcessInfo = () => ({ stderr: stderrBuffer, exitCode, exitSignal });

      const startTime = Date.now();
      let pollCount = 0;

      const poll = async () => {
        if (settled) return;

        if (!this.process || this.process.killed) {
          const info = getProcessInfo();
          const signal = info.exitSignal;
          const diagParts: string[] = [];
          if (signal) diagParts.push(`signal: ${signal}`);
          else if (info.exitCode !== null && info.exitCode !== undefined)
            diagParts.push(`exit code: ${info.exitCode}`);
          const oomHint =
            signal === "SIGKILL"
              ? " — the process was killed by the OS, likely due to insufficient memory. Try a smaller/more quantized model, or reduce the context size."
              : "";
          const stderr = info.stderr ? info.stderr.trim().slice(-800) : "";
          const diagStr = diagParts.length ? ` (${diagParts.join(", ")})` : "";
          settle(() =>
            reject(
              new Error(
                `llama-server process died during startup${diagStr}${oomHint}${stderr ? `\nProcess output: ${stderr}` : ""}`
              )
            )
          );
          return;
        }

        pollCount++;
        if (await this.checkHealth()) {
          this.ready = true;
          debugLogger.debug("llama-server ready", {
            startupTimeMs: Date.now() - startTime,
            pollCount,
          });
          settle(() => resolve());
          return;
        }

        if (Date.now() - startTime >= timeoutMs) {
          settle(() => reject(new Error(`llama-server failed to start within ${timeoutMs}ms`)));
          return;
        }

        setTimeout(poll, STARTUP_POLL_INTERVAL_MS);
      };

      void poll();
    });
  }

  async _killCurrentProcess(): Promise<void> {
    if (!this.process) return;

    this.stopHealthCheck();

    try {
      killProcess(this.process, "SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) killProcess(this.process, "SIGKILL");
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
      debugLogger.error("Error killing llama-server process", { error: (error as Error).message });
    }

    this.process = null;
    this.ready = false;
  }

  checkHealth(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port ?? undefined,
          path: "/health",
          method: "GET",
          timeout: HEALTH_CHECK_TIMEOUT_MS,
        },
        (res: import("http").IncomingMessage) => {
          resolve(res.statusCode === 200);
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
    this.healthCheckFailures = 0;
    this.healthCheckInterval = setInterval(async () => {
      try {
        if (!this.process) {
          this.stopHealthCheck();
          return;
        }
        if (await this.checkHealth()) {
          this.healthCheckFailures = 0;
        } else {
          this.healthCheckFailures++;
          if (this.healthCheckFailures >= HEALTH_CHECK_FAILURE_THRESHOLD) {
            debugLogger.warn("llama-server health check failed", {
              consecutiveFailures: this.healthCheckFailures,
            });
            this.ready = false;
          }
        }
      } catch (err) {
        debugLogger.error("Health check error", { error: (err as Error).message });
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      debugLogger.info("llama-server idle timeout reached, stopping to free VRAM", {
        timeoutMs: IDLE_TIMEOUT_MS,
        model: this.modelPath ? path.basename(this.modelPath) : null,
      });
      void this.stop();
    }, IDLE_TIMEOUT_MS);
  }

  clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * Small JSON round-trip against the running server.
   *
   * Resolves null on any failure rather than rejecting: these calls exist to
   * make a decision more precise, so a broken one must degrade to the estimate
   * and never fail the user's request.
   */
  _requestJson<T>(path: string, body: unknown = null, timeoutMs = PREFLIGHT_TIMEOUT_MS): Promise<T | null> {
    return new Promise((resolve) => {
      const payload = body === null ? null : JSON.stringify(body);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port ?? undefined,
          path,
          method: payload === null ? "GET" : "POST",
          headers: payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {},
          timeout: timeoutMs,
        },
        (res: import("http").IncomingMessage) => {
          let data = "";
          res.on("data", (chunk: Buffer | string) => {
            data += chunk;
          });
          res.on("end", () => {
            if (res.statusCode !== 200) return resolve(null);
            try {
              resolve(JSON.parse(data) as T);
            } catch {
              resolve(null);
            }
          });
        }
      );

      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * The context window actually in force, which is not always what we asked
   * for: a concurrent caller can join an in-flight start that used a smaller
   * size. Returns null when it cannot be read.
   */
  async usableContextSize(): Promise<number | null> {
    if (!this.ready || !this.process) return null;
    const props = await this._requestJson<{
      default_generation_settings?: { n_ctx?: number };
    }>("/props");
    const contextSize = props?.default_generation_settings?.n_ctx;
    return typeof contextSize === "number" && Number.isFinite(contextSize) && contextSize > 0
      ? contextSize
      : null;
  }

  /**
   * Exact token count for the prompt as the server will actually see it, chat
   * template included. Roughly 15 ms for an 85 KB prompt, which is cheap
   * enough to make the difference between a right-sized window and a 400.
   */
  async countPromptTokens(messages: ChatMessage[], options: CountPromptTokensOptions = {}): Promise<number | null> {
    if (!this.ready || !this.process) return null;

    const payload: {
      messages: ChatMessage[];
      chat_template_kwargs?: { enable_thinking: boolean };
    } = { messages };
    // Must mirror inference() exactly, or we would price a different prompt
    // than the one we go on to send.
    if (options.disableThinking !== false) {
      payload.chat_template_kwargs = { enable_thinking: false };
    }

    const templated = await this._requestJson<{ prompt?: string }>("/apply-template", payload);
    if (typeof templated?.prompt !== "string") return null;

    const tokenized = await this._requestJson<{ tokens?: unknown[] }>("/tokenize", {
      content: templated.prompt,
    });
    return Array.isArray(tokenized?.tokens) ? tokenized.tokens.length : null;
  }

  async inference(messages: ChatMessage[], options: InferenceOptions = {}): Promise<string> {
    if (!this.ready || !this.process) {
      throw new Error("llama-server is not running");
    }
    if (options.signal?.aborted) {
      throw Object.assign(new Error("Inference cancelled"), { name: "AbortError" });
    }

    this.clearIdleTimer();

    const requestBody: {
      messages: ChatMessage[];
      temperature: number;
      max_tokens: number;
      stream: boolean;
      chat_template_kwargs?: { enable_thinking: boolean };
    } = {
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens ?? 512,
      stream: false,
    };

    // Without this, Qwen chat templates leave `message.content` empty and
    // route output into `reasoning_content`. Non-Qwen templates ignore it.
    if (options.disableThinking !== false) {
      requestBody.chat_template_kwargs = { enable_thinking: false };
    }

    const body = JSON.stringify(requestBody);

    let abortRequest: (() => void) | null = null;
    return new Promise<string>((resolve, reject) => {
      const startTime = Date.now();

      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port ?? undefined,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: 300000,
        },
        (res: import("http").IncomingMessage) => {
          let data = "";
          res.on("data", (chunk: Buffer | string) => {
            data += chunk;
          });
          res.on("end", () => {
            debugLogger.debug("llama-server inference completed", {
              statusCode: res.statusCode,
              elapsed: Date.now() - startTime,
            });

            if (res.statusCode !== 200) {
              reject(buildResponseError(res.statusCode ?? 0, data));
              return;
            }

            try {
              const response = JSON.parse(data) as {
                choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string } }>;
              };
              if (
                options.requireCompleteOutput &&
                ["length", "max_tokens"].includes(response.choices?.[0]?.finish_reason ?? "")
              ) {
                reject(new Error("Model output was truncated before the selection edit completed"));
                return;
              }
              const message = response.choices?.[0]?.message;
              const text = message?.content || message?.reasoning_content || "";
              resolve(text.trim());
            } catch (e) {
              reject(new Error(`Failed to parse llama-server response: ${(e as Error).message}`));
            }
          });
        }
      );

      req.on("error", (error: Error) => {
        reject(options.signal?.aborted
          ? Object.assign(new Error("Inference cancelled"), { name: "AbortError" })
          : new Error(`llama-server request failed: ${error.message}`));
      });
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("llama-server request timed out"));
      });

      abortRequest = () => req.destroy(Object.assign(new Error("Inference cancelled"), { name: "AbortError" }));
      options.signal?.addEventListener("abort", abortRequest, { once: true });
      if (options.signal?.aborted) abortRequest();
      req.write(body);
      req.end();
    }).finally(() => {
      if (abortRequest) options.signal?.removeEventListener("abort", abortRequest);
      this.resetIdleTimer();
    });
  }

  async stop(): Promise<void> {
    this.clearIdleTimer();
    this.stopHealthCheck();

    if (!this.process) {
      this.ready = false;
      this.contextSize = null;
      return;
    }

    debugLogger.debug("Stopping llama-server");

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
      debugLogger.error("Error stopping llama-server", { error: (error as Error).message });
    }

    this.process = null;
    this.ready = false;
    this.port = null;
    this.modelPath = null;
    this.draftModelPath = null;
    this.activeDraftModelPath = null;
    this.activeBackend = null;
    this.contextSize = null;
    this.activeContextSize = null;
  }

  getStatus(): {
    available: boolean;
    running: boolean;
    port: number | null;
    modelPath: string | null;
    modelName: string | null;
    backend: string | null;
  } {
    return {
      available: this.isAvailable(),
      running: this.ready && this.process !== null,
      port: this.port,
      modelPath: this.modelPath,
      modelName: this.modelPath ? path.basename(this.modelPath, ".gguf") : null,
      backend: this.activeBackend,
    };
  }
}

// Dual export: modelManagerBridge and legacy tests require this module as the
// class itself, while the TS graph imports the named export.
module.exports = LlamaServerManager;
module.exports.LlamaServerManager = LlamaServerManager;
