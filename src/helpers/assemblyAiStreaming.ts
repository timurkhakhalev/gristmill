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

export interface AssemblyAiStreamingOptions {
  token?: string | null;
  mode?: string;
  sampleRate?: number;
  model?: string | null;
  minTurnSilence?: number;
  maxTurnSilence?: number;
  keyterms?: readonly string[];
}

interface TranscriptResult {
  text: string;
  audioDuration?: number;
}

interface CompletedTurn {
  text: string;
  normalized: string;
  startedAt: number;
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
const TOKEN_REFRESH_BUFFER_MS = 30000;
const TOKEN_EXPIRY_MS = 300000;
const REWARM_DELAY_MS = 2000;
const MAX_REWARM_ATTEMPTS = 10;
const KEEPALIVE_INTERVAL_MS = 15000;
const MIN_FRAME_MS = 50;
// AssemblyAI hard-closes the session outside 50-1000 ms but documents 50-250 ms
// as the supported shape, so the split targets the recommended ceiling: 1000 would
// put the first slice of a coalesced read exactly on the limit it exists to avoid.
const MAX_FRAME_MS = 250;
// Both bounds follow the rate the socket opened at: Note Recording streams at
// 24 kHz, where a frame sized against this module's 16 kHz default lasts only
// 33 ms (#2140).
const minFrameBytes = (sampleRate: number): number =>
  Math.ceil((sampleRate * 2 * MIN_FRAME_MS) / 1000);
const maxFrameBytes = (sampleRate: number): number =>
  Math.floor((sampleRate * 2 * MAX_FRAME_MS) / 1000);

export class AssemblyAiStreaming {
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
  declare lastTurnText: string;
  declare turns: CompletedTurn[];
  declare terminationResolve: ((result: TranscriptResult) => void) | null;
  declare cachedToken: string | null;
  declare tokenFetchedAt: number | null;
  declare mode: "byok" | null;
  declare warmConnection: RealtimeSocket | null;
  declare warmConnectionReady: boolean;
  declare warmConnectionOptions: AssemblyAiStreamingOptions | null;
  declare warmSessionId: string | null;
  declare requestedModel: string | null;
  declare sessionSampleRate: number;
  declare rewarmAttempts: number;
  declare rewarmTimer: Timer | null;
  declare keepAliveInterval: Timer | null;
  declare isDisconnecting: boolean;
  declare pendingAudio: Buffer[];
  declare pendingAudioBytes: number;
  declare completedSegments: string[];
  declare speechStartedAt: number | null;

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
    this.lastTurnText = "";
    this.turns = [];
    this.terminationResolve = null;
    this.cachedToken = null;
    this.tokenFetchedAt = null;
    this.mode = null;
    this.warmConnection = null;
    this.warmConnectionReady = false;
    this.warmConnectionOptions = null;
    this.warmSessionId = null;
    this.requestedModel = null;
    this.sessionSampleRate = SAMPLE_RATE;
    this.rewarmAttempts = 0;
    this.rewarmTimer = null;
    this.keepAliveInterval = null;
    this.isDisconnecting = false;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.completedSegments = [];
    this.speechStartedAt = null;
  }

  buildWebSocketUrl(options: AssemblyAiStreamingOptions & { token: string }): string {
    const sampleRate = options.sampleRate || SAMPLE_RATE;
    this.sessionSampleRate = sampleRate;
    const params = new URLSearchParams({
      sample_rate: String(sampleRate),
      encoding: "pcm_s16le",
      format_turns: "true",
      token: options.token,
    });
    this.requestedModel = options.model || null;
    if (options.model) {
      params.set("speech_model", options.model);
    }
    if (options.minTurnSilence != null) {
      params.set("min_turn_silence", String(options.minTurnSilence));
    }
    if (options.maxTurnSilence != null) {
      params.set("max_turn_silence", String(options.maxTurnSilence));
    }
    if (options.keyterms && options.keyterms.length > 0) {
      params.set("keyterms_prompt", JSON.stringify(options.keyterms.slice(0, 100)));
    }
    return `wss://streaming.assemblyai.com/v3/ws?${params.toString()}`;
  }

  cacheToken(token: string): void {
    this.cachedToken = token;
    this.tokenFetchedAt = Date.now();
    debugLogger.debug("AssemblyAI token cached", { expiresIn: TOKEN_EXPIRY_MS });
  }

  // A token or warm socket minted under one direct credential must never serve
  // another connection. Callers that read the cache before connecting adopt
  // the direct mode first.
  adoptMode(options: AssemblyAiStreamingOptions): void {
    if (options.mode !== "byok") {
      throw new Error("AssemblyAI realtime requires a direct provider API key");
    }
    const mode = "byok";
    if (this.mode !== null && this.mode !== mode) {
      debugLogger.debug("AssemblyAI credential mode changed, dropping cached session state", {
        from: this.mode,
        to: mode,
      });
      this.cachedToken = null;
      this.tokenFetchedAt = null;
      this.cleanupWarmConnection();
    }
    this.mode = mode;
  }

  isTokenValid(): boolean {
    if (!this.cachedToken || !this.tokenFetchedAt) return false;
    const age = Date.now() - this.tokenFetchedAt;
    return age < TOKEN_EXPIRY_MS - TOKEN_REFRESH_BUFFER_MS;
  }

  getCachedToken(): string | null {
    return this.isTokenValid() ? this.cachedToken : null;
  }

  startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveInterval = setInterval(() => {
      if (this.warmConnection && this.warmConnection.readyState === WebSocket.OPEN) {
        try {
          this.warmConnection.ping();
        } catch (err) {
          debugLogger.debug("AssemblyAI keep-alive ping failed", { error: errorMessage(err) });
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

  async warmup(options: AssemblyAiStreamingOptions = {}): Promise<void> {
    const { token } = options;
    if (!token) {
      throw new Error("Streaming token is required for warmup");
    }

    this.adoptMode(options);
    if (this.warmConnection) {
      debugLogger.debug(
        this.warmConnectionReady
          ? "AssemblyAI connection already warm"
          : "AssemblyAI warmup already in progress, skipping"
      );
      return;
    }

    this.warmConnectionReady = false;
    this.warmSessionId = null;
    this.cachedToken = token;
    this.tokenFetchedAt = Date.now();
    this.warmConnectionOptions = options;
    this.rewarmAttempts = 0;

    const url = this.buildWebSocketUrl({ ...options, token });
    debugLogger.debug("AssemblyAI warming up connection");

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const warmupTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.cleanupWarmConnection();
        reject(new Error("AssemblyAI warmup connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      this.warmConnection = new WebSocket(url);

      this.warmConnection.on("open", () => {
        debugLogger.debug("AssemblyAI warm connection socket opened");
      });

      this.warmConnection.on("message", (data) => {
        try {
          const parsed: unknown = JSON.parse(data.toString());
          if (isRecord(parsed) && parsed.type === "Begin" && !settled) {
            settled = true;
            clearTimeout(warmupTimeout);
            this.warmConnectionReady = true;
            this.warmSessionId = stringField(parsed, "id") || null;
            this.startKeepAlive();
            debugLogger.debug("AssemblyAI connection warmed up", { sessionId: parsed.id });
            resolve();
          }
        } catch (err) {
          debugLogger.error("AssemblyAI warmup message parse error", { error: errorMessage(err) });
        }
      });

      this.warmConnection.on("error", (error) => {
        clearTimeout(warmupTimeout);
        debugLogger.error("AssemblyAI warmup connection error", { error: error.message });
        this.cleanupWarmConnection();
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      this.warmConnection.on("close", (code, reason) => {
        clearTimeout(warmupTimeout);
        this.stopKeepAlive();
        const wasReady = this.warmConnectionReady;
        const savedOptions = this.warmConnectionOptions ? { ...this.warmConnectionOptions } : null;
        debugLogger.debug("AssemblyAI warm connection closed", {
          wasReady,
          code,
          reason: reason?.toString(),
        });
        this.cleanupWarmConnection();
        if (!settled) {
          settled = true;
          reject(new Error(`AssemblyAI warmup connection closed before ready (code: ${code})`));
          return;
        }
        if (wasReady && savedOptions) {
          this.warmConnectionOptions = savedOptions;
          this.scheduleRewarm();
        }
      });
    });
  }

  scheduleRewarm(): void {
    if (this.rewarmAttempts >= MAX_REWARM_ATTEMPTS) {
      debugLogger.debug("AssemblyAI max re-warm attempts reached, will cold-start next recording");
      return;
    }
    if (this.isConnected) {
      // Active session in progress, don't re-warm
      return;
    }
    const token = this.getCachedToken();
    if (!token || !this.warmConnectionOptions) {
      debugLogger.debug("AssemblyAI cannot re-warm: no valid token or options");
      return;
    }

    this.rewarmAttempts++;
    const delay = Math.min(REWARM_DELAY_MS * Math.pow(2, this.rewarmAttempts - 1), 60000);
    debugLogger.debug("AssemblyAI scheduling re-warm", {
      attempt: this.rewarmAttempts,
      delayMs: delay,
    });
    if (this.rewarmTimer) clearTimeout(this.rewarmTimer);
    this.rewarmTimer = setTimeout(() => {
      this.rewarmTimer = null;
      if (this.hasWarmConnection() || this.isConnected) return;
      this.warmup({ ...this.warmConnectionOptions, token }).catch((err) => {
        debugLogger.debug("AssemblyAI auto re-warm failed", { error: errorMessage(err) });
      });
    }, delay);
  }

  useWarmConnection(): boolean {
    if (!this.warmConnection || !this.warmConnectionReady) {
      return false;
    }

    if (this.warmConnection.readyState !== WebSocket.OPEN) {
      debugLogger.debug("AssemblyAI warm connection readyState not OPEN, discarding", {
        readyState: this.warmConnection.readyState,
      });
      this.cleanupWarmConnection();
      return false;
    }

    this.stopKeepAlive();

    this.ws = this.warmConnection;
    this.isConnected = true;
    this.connectionLossNotified = false;
    this.sessionId = this.warmSessionId || null;
    this.warmConnection = null;
    this.warmConnectionReady = false;
    this.warmSessionId = null;

    this.ws.removeAllListeners("message");
    this.ws.on("message", (data) => {
      this.handleMessage(data);
    });

    this.ws.removeAllListeners("error");
    this.ws.on("error", (error) => {
      const wasActive = this.isConnected;
      debugLogger.error("AssemblyAI WebSocket error", { error: error.message });
      this.cleanup();
      if (wasActive && !this.isDisconnecting) this.notifyConnectionLost(error);
    });

    this.ws.removeAllListeners("close");
    this.ws.on("close", (code, reason) => {
      const wasActive = this.isConnected;
      debugLogger.debug("AssemblyAI WebSocket closed", {
        code,
        reason: reason?.toString(),
        wasActive,
      });
      this.cleanup();
      if (wasActive && !this.isDisconnecting) {
        this.notifyConnectionLost(new Error(`Connection lost (code: ${code})`));
      }
    });

    debugLogger.debug("AssemblyAI using pre-warmed connection");
    return true;
  }

  cleanupWarmConnection(): void {
    this.stopKeepAlive();
    if (this.warmConnection) {
      try {
        this.warmConnection.close();
      } catch {
        // Ignore
      }
      this.warmConnection = null;
    }
    this.warmConnectionReady = false;
    this.warmConnectionOptions = null;
    this.warmSessionId = null;
  }

  hasWarmConnection(): boolean {
    return (
      this.warmConnection !== null &&
      this.warmConnectionReady &&
      this.warmConnection.readyState === WebSocket.OPEN
    );
  }

  async connect(options: AssemblyAiStreamingOptions = {}): Promise<void> {
    const { token } = options;
    if (!token) {
      throw new Error("Streaming token is required");
    }

    if (this.isConnected) {
      debugLogger.debug("AssemblyAI streaming already connected");
      return;
    }

    // Reset accumulated text for new session
    this.accumulatedText = "";
    this.lastTurnText = "";
    this.turns = [];
    this.connectionLossNotified = false;

    this.adoptMode(options);
    // The server pins speech_model at Begin, so a warm socket opened for another
    // model would keep that model for the whole session — and the Begin mismatch
    // warning could never fire for the model actually requested.
    if (
      this.hasWarmConnection() &&
      ((this.warmConnectionOptions?.model || null) !== (options.model || null) ||
        (this.warmConnectionOptions?.sampleRate || SAMPLE_RATE) !==
          (options.sampleRate || SAMPLE_RATE))
    ) {
      debugLogger.debug("AssemblyAI warm connection differs, cold-starting", {
        warm: this.warmConnectionOptions?.model || null,
        requested: options.model || null,
        warmSampleRate: this.warmConnectionOptions?.sampleRate || SAMPLE_RATE,
        requestedSampleRate: options.sampleRate || SAMPLE_RATE,
      });
      this.cleanupWarmConnection();
    }

    // Try to use pre-warmed connection for instant start
    if (this.hasWarmConnection()) {
      if (this.useWarmConnection()) {
        debugLogger.debug("AssemblyAI using warm connection - instant start");
        return;
      }
    }

    const url = this.buildWebSocketUrl({ ...options, token });
    debugLogger.debug("AssemblyAI streaming connecting (cold start)");

    return new Promise<void>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      this.connectionTimeout = setTimeout(() => {
        this.cleanup();
        reject(new Error("AssemblyAI WebSocket connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        debugLogger.debug("AssemblyAI WebSocket connected");
      });

      this.ws.on("message", (data) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (error) => {
        const wasActive = this.isConnected;
        debugLogger.error("AssemblyAI WebSocket error", { error: error.message });
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

      this.ws.on("close", (code, reason) => {
        const wasActive = this.isConnected;
        debugLogger.debug("AssemblyAI WebSocket closed", {
          code,
          reason: reason?.toString(),
          wasActive,
        });
        if (this.pendingReject) {
          this.pendingReject(new Error(`AssemblyAI WebSocket closed before ready (code: ${code})`));
          this.pendingReject = null;
          this.pendingResolve = null;
        }
        this.cleanup();
        if (wasActive && !this.isDisconnecting) {
          this.notifyConnectionLost(new Error(`Connection lost (code: ${code})`));
        }
      });
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

  handleMessage(data: SocketData): void {
    try {
      const parsed: unknown = JSON.parse(data.toString());
      if (!isRecord(parsed)) return;
      const message = parsed;

      switch (message.type) {
        case "Begin":
          this.sessionId = stringField(message, "id") || null;
          this.isConnected = true;
          if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
          debugLogger.debug("AssemblyAI session started", { sessionId: this.sessionId });
          // AssemblyAI ignores unrecognized query params instead of rejecting them,
          // so a bad speech_model silently downgrades the session.
          if (
            stringField(recordField(message, "configuration"), "model") &&
            this.requestedModel &&
            stringField(recordField(message, "configuration"), "model") !== this.requestedModel
          ) {
            debugLogger.warn(
              "AssemblyAI applied a different speech model than requested",
              {
                requested: this.requestedModel,
                applied: stringField(recordField(message, "configuration"), "model"),
              },
              "transcription"
            );
          }
          if (this.pendingResolve) {
            this.pendingResolve();
            this.pendingResolve = null;
            this.pendingReject = null;
          }
          break;

        case "Turn":
          if (stringField(message, "transcript")) {
            const transcript = stringField(message, "transcript") || "";
            if (message.end_of_turn) {
              // Turn has ended - append once, then replace with formatted variant if needed
              const trimmedTranscript = transcript.trim();
              const normalizedTranscript = this.normalizeTurnText(trimmedTranscript);
              const previousTurn = this.turns[this.turns.length - 1];

              if (!trimmedTranscript || !normalizedTranscript) {
                break;
              }

              if (previousTurn && previousTurn.normalized === normalizedTranscript) {
                // AssemblyAI can emit the same turn twice (raw then formatted). Replace previous
                // turn only when this variant is formatted, otherwise ignore duplicate.
                if (message.turn_is_formatted && previousTurn.text !== trimmedTranscript) {
                  previousTurn.text = trimmedTranscript;
                  this.completedSegments[this.completedSegments.length - 1] = trimmedTranscript;
                  this.lastTurnText = trimmedTranscript;
                  this.accumulatedText = this.turns.map((turn) => turn.text).join(" ");
                  this.onFinalTranscript?.(this.accumulatedText, previousTurn.startedAt);
                  debugLogger.debug("AssemblyAI formatted turn update applied", {
                    text: trimmedTranscript.slice(0, 100),
                    totalAccumulated: this.accumulatedText.length,
                  });
                } else {
                  debugLogger.debug("AssemblyAI duplicate turn ignored", {
                    text: trimmedTranscript.slice(0, 100),
                  });
                }
                break;
              }

              const speechTimestamp = this.speechStartedAt || Date.now();
              this.speechStartedAt = null;
              this.turns.push({
                text: trimmedTranscript,
                normalized: normalizedTranscript,
                startedAt: speechTimestamp,
              });
              this.completedSegments.push(trimmedTranscript);
              this.lastTurnText = trimmedTranscript;
              this.accumulatedText = this.turns.map((turn) => turn.text).join(" ");
              this.onFinalTranscript?.(this.accumulatedText, speechTimestamp);
              debugLogger.debug("AssemblyAI final transcript (end_of_turn)", {
                text: transcript.slice(0, 100),
                totalAccumulated: this.accumulatedText.length,
              });
            } else if (message.turn_is_formatted) {
              // Formatted but turn not ended yet - show as preview without accumulating
              this.onPartialTranscript?.(transcript);
            } else {
              // Partial transcript - show real-time updates (current turn only)
              this.onPartialTranscript?.(transcript);
            }
          }
          break;

        case "Termination":
          debugLogger.debug("AssemblyAI session terminated", {
            audioDuration: numberField(message, "audio_duration_seconds"),
          });
          // Resolve any pending termination wait
          if (this.terminationResolve) {
            this.terminationResolve({
              audioDuration: numberField(message, "audio_duration_seconds"),
              text: this.accumulatedText,
            });
            this.terminationResolve = null;
          }
          this.onSessionEnd?.({
            audioDuration: numberField(message, "audio_duration_seconds"),
            text: this.accumulatedText,
          });
          this.cleanup();
          break;

        case "Error":
          debugLogger.error("AssemblyAI streaming error", { error: message.error });
          this.onError?.(new Error(stringField(message, "error")));
          break;

        case "SpeechStarted":
          this.speechStartedAt = Date.now();
          break;

        default:
          debugLogger.debug("AssemblyAI unknown message type", { type: message.type });
      }
    } catch (err) {
      debugLogger.error("AssemblyAI message parse error", { error: errorMessage(err) });
    }
  }

  normalizeTurnText(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  sendAudio(pcmBuffer: Buffer): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    this.pendingAudio.push(pcmBuffer);
    this.pendingAudioBytes += pcmBuffer.length;
    const minBytes = minFrameBytes(this.sessionSampleRate);
    if (this.pendingAudioBytes < minBytes) {
      return true;
    }

    const frame = Buffer.concat(this.pendingAudio, this.pendingAudioBytes);
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;

    // The native system-audio helpers forward raw stdout chunks, so one read can
    // far exceed the nominal 100 ms when a stalled main process lets the pipe
    // coalesce. Carry a sub-floor remainder forward rather than sending it short.
    const maxBytes = maxFrameBytes(this.sessionSampleRate);
    let offset = 0;
    while (frame.length - offset >= minBytes) {
      const end = Math.min(offset + maxBytes, frame.length);
      this.ws.send(frame.subarray(offset, end));
      offset = end;
    }
    if (offset < frame.length) {
      const remainder = frame.subarray(offset);
      this.pendingAudio.push(remainder);
      this.pendingAudioBytes = remainder.length;
    }
    return true;
  }

  forceEndpoint(): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    this.ws.send(JSON.stringify({ type: "ForceEndpoint" }));
    debugLogger.debug("AssemblyAI ForceEndpoint sent");
    return true;
  }

  async disconnect(terminate = true): Promise<TranscriptResult> {
    if (!this.ws) return { text: this.accumulatedText };

    this.isDisconnecting = true;

    if (terminate && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "Terminate" }));

        let timeoutId: Timer | undefined;
        const result = await Promise.race([
          new Promise<TranscriptResult>((resolve) => {
            this.terminationResolve = resolve;
          }),
          new Promise<TranscriptResult>((resolve) => {
            timeoutId = setTimeout(() => {
              debugLogger.debug("AssemblyAI termination timeout, using accumulated text");
              resolve({ text: this.accumulatedText });
            }, TERMINATION_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(timeoutId);

        this.terminationResolve = null;
        this.cleanup();
        this.isDisconnecting = false;
        return result;
      } catch (err) {
        debugLogger.debug("AssemblyAI terminate send failed", { error: errorMessage(err) });
      }
    }

    const result = { text: this.accumulatedText };
    this.cleanup();
    this.isDisconnecting = false;
    return result;
  }

  cleanup(): void {
    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;

    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.completedSegments = [];
    this.speechStartedAt = null;

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }

    this.isConnected = false;
    this.sessionId = null;
    this.terminationResolve = null;
  }

  cleanupAll(): void {
    this.cleanup();
    this.cleanupWarmConnection();
    if (this.rewarmTimer) clearTimeout(this.rewarmTimer);
    this.rewarmTimer = null;
    this.cachedToken = null;
    this.tokenFetchedAt = null;
    this.warmConnectionOptions = null;
    this.turns = [];
  }

  getStatus(): {
    isConnected: boolean;
    sessionId: string | null;
    hasWarmConnection: boolean;
    hasValidToken: boolean;
  } {
    return {
      isConnected: this.isConnected,
      sessionId: this.sessionId,
      hasWarmConnection: this.hasWarmConnection(),
      hasValidToken: this.isTokenValid(),
    };
  }
}

module.exports = AssemblyAiStreaming;
module.exports.AssemblyAiStreaming = AssemblyAiStreaming;
