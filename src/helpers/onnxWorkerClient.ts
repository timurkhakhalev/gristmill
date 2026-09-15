const path = require("path");
const { app, utilityProcess, MessageChannelMain } = require("electron");
const debugLogger = require("./debugLogger.js");
import {
  parseOnnxWorkerReply,
  type OnnxWorkerMethod,
  type OnnxWorkerReply,
  type OnnxWorkerResult,
} from "../contracts/onnxWorker.js";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PENDING_REQUESTS = 1000;
const RESPAWN_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const MAX_RESPAWN_ATTEMPTS = 5;
const SHUTDOWN_TIMEOUT_MS = 5000;

// Forked via the asar-virtual path: Electron redirects the unpacked file read
// while module resolution stays inside app.asar (onnxruntime-common is asar-only).
const WORKER_SCRIPT = path.join(__dirname, "..", "workers", "onnxWorker.js");

interface UtilityProcessChild {
  pid?: number | undefined;
  stderr: { on(event: string, listener: (chunk: Buffer) => void): unknown } | null;
  stdout: { on(event: string, listener: (chunk: Buffer) => void): unknown } | null;
  once(event: "spawn", listener: () => void): unknown;
  once(event: "error", listener: (err: Error) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  postMessage(message: unknown, transferList?: unknown[]): unknown;
  kill(): unknown;
}

interface MessagePort {
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  start(): void;
  close(): void;
  postMessage(message: unknown, transferList?: unknown[]): unknown;
}

interface PendingEntry {
  resolve: (result: OnnxWorkerResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class WorkerCrashedError extends Error {
  constructor(message = "ONNX worker crashed") {
    super(message);
    this.name = "WorkerCrashedError";
  }
}

export class WorkerOverloadedError extends Error {
  constructor() {
    super("ONNX worker request queue full");
    this.name = "WorkerOverloadedError";
  }
}

export class OnnxWorkerClient {
  child: UtilityProcessChild | null;
  port: MessagePort | null;
  pending: Map<number, PendingEntry>;
  nextRequestId: number;
  crashCount: number;
  shuttingDown: boolean;
  gaveUp: boolean;
  spawnPromise: Promise<void> | null;
  respawnTimer: NodeJS.Timeout | null;

  constructor() {
    this.child = null;
    this.port = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.crashCount = 0;
    this.shuttingDown = false;
    this.gaveUp = false;
    this.spawnPromise = null;
    this.respawnTimer = null;
  }

  _logPath(): string | null {
    try {
      return path.join(app.getPath("userData"), "logs", "onnx-worker.log");
    } catch {
      return null;
    }
  }

  async _spawn(): Promise<void> {
    if (this.child) return;
    if (this.spawnPromise) return this.spawnPromise;

    this.spawnPromise = (async () => {
      const env = { ...process.env };
      const logPath = this._logPath();
      if (logPath) env.OPENHERCULES_ONNX_WORKER_LOG = logPath;

      const child = utilityProcess.fork(WORKER_SCRIPT, [], {
        serviceName: "openhercules-onnx",
        stdio: "pipe",
        env,
        execArgv: ["--max-old-space-size=512"],
      }) as UtilityProcessChild;

      const forwardStderr = (chunk: Buffer) => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
          if (line) debugLogger.warn("onnx worker stderr", { line });
        }
      };
      child.stderr?.on("data", forwardStderr);
      child.stdout?.on("data", forwardStderr);

      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          child.removeListener("error", onError);
          resolve();
        };
        const onError = (err: Error) => {
          child.removeListener("spawn", onSpawn);
          reject(err);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });

      const { port1, port2 } = new MessageChannelMain();
      port1.on("message", (event: { data: unknown }) => this._onMessage(event.data));
      port1.start();

      child.postMessage("init", [port2]);

      child.on("exit", (code: number) => this._onExit(code));

      this.child = child;
      this.port = port1 as unknown as MessagePort;
      debugLogger.info("onnx worker spawned", { pid: child.pid });
    })();

    try {
      await this.spawnPromise;
    } finally {
      this.spawnPromise = null;
    }
  }

  _onMessage(raw: unknown): void {
    // Unknown or malformed replies are dropped before any pending entry is
    // touched; a late or forged reply must never settle someone's request.
    const reply: OnnxWorkerReply | null = parseOnnxWorkerReply(raw);
    if (!reply) return;

    const entry = this.pending.get(reply.id);
    if (!entry) return;
    this.pending.delete(reply.id);
    clearTimeout(entry.timeout);
    if (reply.error) {
      entry.reject(new Error(reply.error.message));
    } else {
      this.crashCount = 0;
      entry.resolve(reply.result);
    }
  }

  _onExit(code: number): void {
    debugLogger.warn("onnx worker exited", {
      code,
      pending: this.pending.size,
      shuttingDown: this.shuttingDown,
    });

    this.child = null;
    if (this.port) {
      try {
        this.port.close();
      } catch {
        // already closed
      }
      this.port = null;
    }

    const err = new WorkerCrashedError();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(err);
    }
    this.pending.clear();

    if (this.shuttingDown) return;

    if (code !== 0) {
      this.crashCount += 1;
      if (this.crashCount > MAX_RESPAWN_ATTEMPTS) {
        this.gaveUp = true;
        debugLogger.error("onnx worker giving up", { crashCount: this.crashCount });
        return;
      }
      const delay =
        RESPAWN_BACKOFF_MS[Math.min(this.crashCount - 1, RESPAWN_BACKOFF_MS.length - 1)];
      debugLogger.info("onnx worker respawn scheduled", {
        delayMs: delay,
        crashCount: this.crashCount,
      });
      this.respawnTimer = setTimeout(() => {
        this.respawnTimer = null;
        this._spawn().catch((spawnErr: Error | undefined) => {
          debugLogger.error("onnx worker respawn failed", { error: spawnErr?.message });
        });
      }, delay);
    }
  }

  async request(method: OnnxWorkerMethod, payload?: unknown, transferList?: unknown[]): Promise<OnnxWorkerResult> {
    if (this.shuttingDown) {
      throw new WorkerCrashedError("worker shutting down");
    }

    if (this.gaveUp) {
      throw new WorkerCrashedError("worker unavailable");
    }

    if (this.respawnTimer) {
      throw new WorkerCrashedError("worker restarting");
    }

    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      const oldestId = this.pending.keys().next().value as number | undefined;
      const oldest = oldestId === undefined ? undefined : this.pending.get(oldestId);
      if (oldest) {
        this.pending.delete(oldestId as number);
        clearTimeout(oldest.timeout);
        oldest.reject(new WorkerOverloadedError());
      }
    }

    await this._spawn();

    const id = this.nextRequestId++;
    return new Promise<OnnxWorkerResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`onnx worker request timeout: ${method}`));
        }
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.port?.postMessage({ id, method, payload }, transferList || []);
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    if (!this.child) return;

    const child = this.child;
    try {
      this.port?.postMessage({ id: 0, method: "shutdown", payload: {} });
    } catch {
      // worker may already be gone
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already dead
        }
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

const instance = new OnnxWorkerClient();
module.exports = instance;
module.exports.OnnxWorkerClient = OnnxWorkerClient;
module.exports.WorkerCrashedError = WorkerCrashedError;
module.exports.WorkerOverloadedError = WorkerOverloadedError;
