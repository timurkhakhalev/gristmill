interface SocketData {
  toString(): string;
}

interface RealtimeSocket {
  readyState: number;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: SocketData) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number, reason?: SocketData) => void): this;
  removeAllListeners(event: string): this;
  send(data: string | Buffer): void;
  close(code?: number): void;
  ping(): void;
}

interface RealtimeSocketConstructor {
  new (url: string): RealtimeSocket;
  readonly OPEN: number;
}

const WebSocket: RealtimeSocketConstructor = require("ws");
const debugLogger = require("./debugLogger");

type Timer = ReturnType<typeof setTimeout>;
type JsonRecord = Record<string, unknown>;

export interface CortiStreamingOptions {
  token?: string | null;
  environment?: string | null;
  tenant?: string | null;
  language?: string | null;
  keyterms?: readonly string[];
  sampleRate?: number;
}

interface CortiSocketOptions extends CortiStreamingOptions {
  token: string;
  environment: string;
  tenant: string;
}

interface CortiConfiguration {
  primaryLanguage: string;
  interimResults: true;
  automaticPunctuation: true;
  audioFormat: string;
  keyterms?: { terms: Array<{ term: string }> };
}

interface TranscriptResult {
  text: string;
}

interface PendingAck {
  type: string;
  resolve: () => void;
  timer: Timer;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null;

const recordField = (record: JsonRecord, key: string): JsonRecord | undefined => {
  const value = record[key];
  return isRecord(value) ? value : undefined;
};

const stringField = (record: JsonRecord | undefined, key: string): string | undefined => {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
};

const numberField = (record: JsonRecord, key: string): number | undefined => {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
};

const errorMessage = (error: unknown): string | undefined =>
  error instanceof Error
    ? error.message
    : isRecord(error)
      ? stringField(error, "message")
      : undefined;

const SAMPLE_RATE = 16000;
const WEBSOCKET_TIMEOUT_MS = 30000;
const TERMINATION_TIMEOUT_MS = 5000;
const KEEPALIVE_INTERVAL_MS = 15000;

// Corti's WSS transport: OAuth token in the query, a JSON config message after
// open, then raw PCM frames. Mirrors the AssemblyAI/Deepgram streaming classes.
export class CortiStreaming {
  declare ws: RealtimeSocket | null;
  declare sessionId: string | null;
  declare isConnected: boolean;
  declare onPartialTranscript: ((text: string) => void) | null;
  declare onFinalTranscript: ((text: string, startedAt: number) => void) | null;
  declare onError: ((error: Error) => void) | null;
  declare onSessionEnd: ((result: TranscriptResult) => void) | null;
  declare onConnectionLost: ((error: Error) => void) | null;
  declare connectionLossNotified: boolean;
  declare pendingResolve: (() => void) | null;
  declare pendingReject: ((reason?: unknown) => void) | null;
  declare connectionTimeout: Timer | null;
  declare accumulatedText: string;
  declare completedSegments: string[];
  declare pendingAck: PendingAck | null;
  declare isDisconnecting: boolean;
  declare configAccepted: boolean;
  declare preConfigBuffer: Buffer[];
  declare preConfigBufferSize: number;
  declare sessionStartedAt: number | null;
  declare audioBytesSent: number;
  declare currentModel: string;
  declare sampleRate: number;
  declare warmConnection: RealtimeSocket | null;
  declare warmConnectionReady: boolean;
  declare warmSessionId: string | null;
  declare warmSessionStartedAt: number | null;
  declare keepAliveInterval: Timer | null;

  constructor() {
    this.ws = null;
    this.sessionId = null;
    this.isConnected = false;
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onSessionEnd = null;
    this.onConnectionLost = null;
    this.connectionLossNotified = false;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.connectionTimeout = null;
    this.accumulatedText = "";
    this.completedSegments = [];
    this.pendingAck = null;
    this.isDisconnecting = false;
    this.configAccepted = false;
    this.preConfigBuffer = [];
    this.preConfigBufferSize = 0;
    this.sessionStartedAt = null;
    this.audioBytesSent = 0;
    this.currentModel = "corti-transcribe";
    this.sampleRate = SAMPLE_RATE;
    this.warmConnection = null;
    this.warmConnectionReady = false;
    this.warmSessionId = null;
    this.warmSessionStartedAt = null;
    this.keepAliveInterval = null;
  }

  buildWebSocketUrl(options: CortiSocketOptions): string {
    const params = new URLSearchParams({
      "tenant-name": options.tenant,
      token: `Bearer ${options.token}`,
    });
    return `wss://api.${options.environment}.corti.app/audio-bridge/v2/transcribe?${params}`;
  }

  buildConfiguration(options: CortiStreamingOptions): CortiConfiguration {
    const configuration: CortiConfiguration = {
      primaryLanguage: options.language && options.language !== "auto" ? options.language : "en",
      interimResults: true,
      automaticPunctuation: true,
      audioFormat: `audio/pcm; rate=${this.sampleRate}; channels=1; bits=16`,
    };
    if (options.keyterms && options.keyterms.length > 0) {
      configuration.keyterms = { terms: options.keyterms.map((term) => ({ term })) };
    }
    return configuration;
  }

  async connect(options: CortiStreamingOptions = {}): Promise<void> {
    const { token, environment, tenant } = options;
    if (!token || !environment || !tenant) {
      throw new Error("Corti streaming requires token, environment, and tenant");
    }

    if (this.isConnected) {
      debugLogger.debug("Corti streaming already connected");
      return;
    }

    this.accumulatedText = "";
    this.completedSegments = [];
    this.configAccepted = false;
    this.connectionLossNotified = false;
    this.preConfigBuffer = [];
    this.preConfigBufferSize = 0;
    this.audioBytesSent = 0;
    this.sampleRate = options.sampleRate || SAMPLE_RATE;

    // Reuse the pre-warmed socket for an instant start; cold-connect otherwise.
    if (this.useWarmConnection()) {
      debugLogger.debug("Corti using warm connection - instant start");
      return;
    }

    const socketOptions = { ...options, token, environment, tenant };
    const url = this.buildWebSocketUrl(socketOptions);
    const configuration = this.buildConfiguration(options);
    debugLogger.debug("Corti streaming connecting", { environment, tenant });

    return new Promise<void>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      this.connectionTimeout = setTimeout(() => {
        this.cleanup();
        reject(new Error("Corti WebSocket connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      const socket = new WebSocket(url);
      this.ws = socket;
      socket.on("open", () => {
        debugLogger.debug("Corti WebSocket connected, sending config");
        socket.send(JSON.stringify({ type: "config", configuration }));
      });
      this.attachSocketHandlers(socket);
    });
  }

  // Live-socket wiring shared by the cold connect and a promoted warm connection.
  attachSocketHandlers(ws: RealtimeSocket): void {
    ws.on("message", (data) => {
      this.handleMessage(data);
    });

    ws.on("error", (error) => {
      const wasActive = this.isConnected;
      debugLogger.error("Corti WebSocket error", { error: error.message });
      this.cleanup();
      if (this.pendingReject) {
        this.pendingReject(error);
        this.pendingReject = null;
        this.pendingResolve = null;
      }
      if (wasActive && !this.isDisconnecting) {
        this.notifyConnectionLost(error);
      } else if (!this.isDisconnecting) {
        this.onError?.(error);
      }
    });

    ws.on("close", (code, reason) => {
      const wasActive = this.isConnected;
      debugLogger.debug("Corti WebSocket closed", {
        code,
        reason: reason?.toString(),
        wasActive,
      });
      if (this.pendingReject) {
        this.pendingReject(new Error(`Corti WebSocket closed before ready (code: ${code})`));
        this.pendingReject = null;
        this.pendingResolve = null;
      }
      this.resolvePendingAck();
      this.cleanup();
      if (wasActive && !this.isDisconnecting) {
        this.notifyConnectionLost(new Error(`Connection lost (code: ${code})`));
      }
    });
  }

  notifyConnectionLost(error: Error): void {
    if (this.connectionLossNotified) return;
    this.connectionLossNotified = true;
    if (this.onConnectionLost) {
      this.onConnectionLost(error);
    } else {
      this.onError?.(error);
    }
  }

  // Pre-open the socket and finish the config handshake before recording, so the
  // first words aren't lost waiting for CONFIG_ACCEPTED. Mirrors Deepgram/AssemblyAI.
  async warmup(options: CortiStreamingOptions = {}): Promise<void> {
    const { token, environment, tenant } = options;
    if (!token || !environment || !tenant) {
      throw new Error("Corti warmup requires token, environment, and tenant");
    }
    if (this.warmConnection) {
      debugLogger.debug(
        this.warmConnectionReady
          ? "Corti connection already warm"
          : "Corti warmup already in progress, skipping"
      );
      return;
    }

    this.warmConnectionReady = false;
    this.warmSessionId = null;
    this.sampleRate = options.sampleRate || SAMPLE_RATE;

    const socketOptions = { ...options, token, environment, tenant };
    const url = this.buildWebSocketUrl(socketOptions);
    const configuration = this.buildConfiguration(options);
    debugLogger.debug("Corti warming up connection", { environment, tenant });

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const warmupTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.cleanupWarmConnection();
        reject(new Error("Corti warmup connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      const socket = new WebSocket(url);
      this.warmConnection = socket;

      socket.on("open", () => {
        debugLogger.debug("Corti warm connection opened, sending config");
        socket.send(JSON.stringify({ type: "config", configuration }));
      });

      socket.on("message", (data) => {
        let message: JsonRecord;
        try {
          const parsed: unknown = JSON.parse(data.toString());
          if (!isRecord(parsed)) return;
          message = parsed;
        } catch {
          return;
        }
        if (message.type === "CONFIG_ACCEPTED" && !settled) {
          settled = true;
          clearTimeout(warmupTimeout);
          this.warmConnectionReady = true;
          this.warmSessionId = stringField(message, "sessionId") || null;
          this.warmSessionStartedAt = Date.now();
          this.startKeepAlive();
          debugLogger.debug("Corti connection warmed up", { sessionId: this.warmSessionId });
          resolve();
        }
      });

      socket.on("error", (error) => {
        debugLogger.error("Corti warmup connection error", { error: error.message });
        this.cleanupWarmConnection();
        if (!settled) {
          settled = true;
          clearTimeout(warmupTimeout);
          reject(error);
        }
      });

      socket.on("close", (code, reason) => {
        clearTimeout(warmupTimeout);
        const wasReady = this.warmConnectionReady;
        debugLogger.debug("Corti warm connection closed", {
          code,
          reason: reason?.toString(),
          wasReady,
        });
        this.cleanupWarmConnection();
        if (!settled) {
          settled = true;
          reject(new Error(`Corti warmup connection closed (code: ${code})`));
        }
      });
    });
  }

  hasWarmConnection(): boolean {
    return (
      this.warmConnection !== null &&
      this.warmConnectionReady &&
      this.warmConnection.readyState === WebSocket.OPEN
    );
  }

  // Promote the warm socket to the active session — config is already accepted, so
  // audio flows immediately. Returns false (clearing any stale socket) if none usable.
  useWarmConnection(): boolean {
    const socket = this.warmConnection;
    if (!this.hasWarmConnection() || !socket) {
      this.cleanupWarmConnection();
      return false;
    }

    this.stopKeepAlive();
    this.ws = socket;
    this.isConnected = true;
    this.configAccepted = true;
    this.sessionId = this.warmSessionId || null;
    this.sessionStartedAt = this.warmSessionStartedAt || Date.now();
    this.warmConnection = null;
    this.warmConnectionReady = false;
    this.warmSessionId = null;
    this.warmSessionStartedAt = null;

    socket.removeAllListeners("open");
    socket.removeAllListeners("message");
    socket.removeAllListeners("error");
    socket.removeAllListeners("close");
    this.attachSocketHandlers(socket);
    return true;
  }

  startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveInterval = setInterval(() => {
      if (this.warmConnection?.readyState === WebSocket.OPEN) {
        try {
          this.warmConnection.ping();
        } catch (err) {
          debugLogger.debug("Corti keep-alive ping failed", { error: errorMessage(err) });
          this.cleanupWarmConnection();
        }
      } else {
        this.stopKeepAlive();
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  cleanupWarmConnection(): void {
    this.stopKeepAlive();
    if (this.warmConnection) {
      try {
        this.warmConnection.close(1000);
      } catch {
        // Ignore close errors
      }
      this.warmConnection = null;
    }
    this.warmConnectionReady = false;
    this.warmSessionId = null;
    this.warmSessionStartedAt = null;
  }

  handleMessage(data: SocketData): void {
    let message: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(data.toString());
      if (!isRecord(parsed)) return;
      message = parsed;
    } catch (err) {
      debugLogger.error("Corti message parse error", { error: errorMessage(err) });
      return;
    }

    switch (message.type) {
      case "CONFIG_ACCEPTED":
        this.isConnected = true;
        this.configAccepted = true;
        this.sessionId = stringField(message, "sessionId") || null;
        this.sessionStartedAt = Date.now();
        if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
        this.flushPreConfigBuffer();
        debugLogger.debug("Corti session started", { sessionId: this.sessionId });
        if (this.pendingResolve) {
          this.pendingResolve();
          this.pendingResolve = null;
          this.pendingReject = null;
        }
        break;

      case "transcript": {
        const data = recordField(message, "data");
        const text = stringField(data, "text");
        if (!text) break;
        if (data?.isFinal) {
          const trimmed = text.trim();
          if (!trimmed) break;
          this.completedSegments.push(trimmed);
          this.accumulatedText = this.completedSegments.join(" ");
          const start = numberField(data, "start");
          const startedAt =
            this.sessionStartedAt != null && start !== undefined
              ? this.sessionStartedAt + start * 1000
              : Date.now();
          this.onFinalTranscript?.(this.accumulatedText, startedAt);
        } else {
          this.onPartialTranscript?.(text);
        }
        break;
      }

      case "flushed":
      case "ended":
        if (this.pendingAck?.type === message.type) {
          this.resolvePendingAck();
        }
        break;

      case "delta_usage":
      case "usage":
        break;

      case "error":
        debugLogger.error("Corti streaming error", { error: message.error });
        this.onError?.(
          new Error(
            stringField(recordField(message, "error"), "title") ||
              stringField(recordField(message, "error"), "details") ||
              "Corti error"
          )
        );
        break;

      default:
        debugLogger.debug("Corti unknown message type", { type: message.type });
    }
  }

  flushPreConfigBuffer(): void {
    if (this.preConfigBuffer.length === 0) return;
    const socket = this.ws;
    if (!socket) return;
    debugLogger.debug("Corti flushing pre-config buffer", {
      chunks: this.preConfigBuffer.length,
      bytes: this.preConfigBufferSize,
    });
    for (const frame of this.preConfigBuffer) {
      socket.send(frame);
      this.audioBytesSent += frame.length;
    }
    this.preConfigBuffer = [];
    this.preConfigBufferSize = 0;
  }

  sendAudio(pcmBuffer: Buffer): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    if (!this.configAccepted) {
      // Corti rejects audio sent before it acks config; cap the handshake buffer at ~3s.
      if (this.preConfigBufferSize < 3 * this.sampleRate * 2) {
        const copy = Buffer.from(pcmBuffer);
        this.preConfigBuffer.push(copy);
        this.preConfigBufferSize += copy.length;
      }
      return true;
    }

    this.audioBytesSent += pcmBuffer.length;
    this.ws.send(pcmBuffer);
    return true;
  }

  finalize(): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.ws.send(JSON.stringify({ type: "flush" }));
    debugLogger.debug("Corti flush sent");
    return true;
  }

  // Resolves a single in-flight waitForAck (server ack or socket close).
  resolvePendingAck(): void {
    if (!this.pendingAck) return;
    clearTimeout(this.pendingAck.timer);
    this.pendingAck.resolve();
    this.pendingAck = null;
  }

  waitForAck(type: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAck = null;
        resolve();
      }, TERMINATION_TIMEOUT_MS);
      this.pendingAck = { type, resolve, timer };
    });
  }

  async disconnect(closeStream = true): Promise<TranscriptResult> {
    if (!this.ws) return { text: this.accumulatedText };

    this.isDisconnecting = true;

    if (closeStream && this.ws.readyState === WebSocket.OPEN) {
      // Corti's close handshake: flush buffered audio, wait for the trailing
      // finals (`flushed`), then signal `end` and close cleanly.
      this.ws.send(JSON.stringify({ type: "flush" }));
      await this.waitForAck("flushed");

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "end" }));
      }

      const result = { text: this.accumulatedText };
      this.onSessionEnd?.(result);
      this.cleanup();
      this.isDisconnecting = false;
      return result;
    }

    const result = { text: this.accumulatedText };
    this.cleanup();
    this.isDisconnecting = false;
    return result;
  }

  cleanup(): void {
    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    this.preConfigBuffer = [];
    this.preConfigBufferSize = 0;

    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }

    this.isConnected = false;
    this.configAccepted = false;
    this.sessionId = null;
    this.resolvePendingAck();
  }

  getStatus(): { isConnected: boolean; sessionId: string | null } {
    return {
      isConnected: this.isConnected,
      sessionId: this.sessionId,
    };
  }
}

module.exports = CortiStreaming;
module.exports.CortiStreaming = CortiStreaming;
