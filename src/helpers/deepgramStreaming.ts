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
}

interface RealtimeSocketConstructor {
  new (url: string, options?: { headers?: Record<string, string> }): RealtimeSocket;
  readonly CONNECTING: number;
  readonly OPEN: number;
}

const WebSocket: RealtimeSocketConstructor = require("ws");
const debugLogger = require("./debugLogger");

type Timer = ReturnType<typeof setTimeout>;
type JsonRecord = Record<string, unknown>;

export interface DeepgramStreamingOptions {
  token?: string | null;
  mode?: string;
  sampleRate?: number;
  language?: string | null;
  model?: string | null;
  keyterms?: readonly string[];
  replayBuffer?: Buffer[];
  forceNew?: boolean;
}

interface TranscriptResult {
  text: string;
}

interface WarmupMeta {
  requestId?: string;
  via?: string;
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
const KEEPALIVE_INTERVAL_MS = 3000;
const COLD_START_BUFFER_MAX = 3 * SAMPLE_RATE * 2; // 3 seconds of 16-bit PCM
const LIVENESS_TIMEOUT_MS = 2500; // Max wait for first Results from a warm connection

// Languages supported by Nova-3 (base codes). If a language isn't here, fall back to Nova-2.
const NOVA3_LANGUAGES = new Set([
  "ar",
  "be",
  "bn",
  "bs",
  "bg",
  "ca",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "et",
  "fi",
  "fr",
  "de",
  "el",
  "he",
  "hi",
  "hu",
  "id",
  "it",
  "ja",
  "kn",
  "ko",
  "lv",
  "lt",
  "mk",
  "ms",
  "mr",
  "no",
  "fa",
  "pl",
  "pt",
  "ro",
  "ru",
  "sr",
  "sk",
  "sl",
  "es",
  "sv",
  "tl",
  "ta",
  "te",
  "tr",
  "uk",
  "ur",
  "vi",
  "multi",
]);

// 100ms of silence at 16kHz 16-bit mono — sent to warm connections to prevent
// Deepgram's net0001 idle timeout (which only resets on audio data, not KeepAlive).
const SILENCE_FRAME = Buffer.alloc((SAMPLE_RATE / 10) * 2);

// Deepgram binds the scheme to the credential: a raw API key (BYOK) is accepted
// Direct Deepgram API keys use the Token scheme. #2140
export const authorizationHeader = (_mode: string | null, token: string): string =>
  `Token ${token}`;

// Everything buildWebSocketUrl pins on the socket, folded the way it folds it, so
// a warm connection can be compared against the session that wants to ride it.
// Dictation warms on the UI language before it can know a translation wants the
// source language, and the dictionary can be edited between the two.
const urlIdentity = (options: DeepgramStreamingOptions) =>
  JSON.stringify([
    options.sampleRate || SAMPLE_RATE,
    options.language && options.language !== "auto" ? options.language : null,
    (options.keyterms || []).filter(Boolean),
  ]);

export class DeepgramStreaming {
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
  declare finalSegments: string[];
  declare sessionStartedAt: number | null;
  declare closeResolve: ((result: TranscriptResult) => void) | null;
  declare cachedToken: string | null;
  declare tokenFetchedAt: number | null;
  declare mode: "byok" | null;
  declare warmConnection: RealtimeSocket | null;
  declare warmConnectionReady: boolean;
  declare warmConnectionOptions: DeepgramStreamingOptions | null;
  declare warmSessionId: string | null;
  declare rewarmAttempts: number;
  declare rewarmTimer: Timer | null;
  declare keepAliveInterval: Timer | null;
  declare isDisconnecting: boolean;
  declare coldStartBuffer: Buffer[];
  declare coldStartBufferSize: number;
  declare tokenRefreshFn: (() => Promise<string | null | undefined>) | null;
  declare proactiveRefreshTimer: Timer | null;
  declare _generation: number;
  declare audioBytesSent: number;
  declare currentModel: string;
  declare resultsReceived: number;
  declare livenessTimer: Timer | null;
  declare replayBuffer: Buffer[];
  declare replayBufferSize: number;
  declare connectionOptions: DeepgramStreamingOptions | null;

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
    this.finalSegments = [];
    this.sessionStartedAt = null;
    this.closeResolve = null;
    this.cachedToken = null;
    this.tokenFetchedAt = null;
    this.mode = null;
    this.warmConnection = null;
    this.warmConnectionReady = false;
    this.warmConnectionOptions = null;
    this.warmSessionId = null;
    this.rewarmAttempts = 0;
    this.rewarmTimer = null;
    this.keepAliveInterval = null;
    this.isDisconnecting = false;
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
    this.tokenRefreshFn = null;
    this.proactiveRefreshTimer = null;
    this._generation = 0;
    this.audioBytesSent = 0;
    this.currentModel = "nova-3";
    this.resultsReceived = 0;
    this.livenessTimer = null;
    this.replayBuffer = [];
    this.replayBufferSize = 0;
    this.connectionOptions = null;
  }

  get completedSegments() {
    return this.finalSegments;
  }

  setTokenRefreshFn(fn: () => Promise<string | null | undefined>): void {
    this.tokenRefreshFn = fn;
  }

  buildWebSocketUrl(options: DeepgramStreamingOptions): string {
    const sampleRate = options.sampleRate || SAMPLE_RATE;
    const lang = options.language && options.language !== "auto" ? options.language : null;
    const baseLang = lang ? lang.split("-")[0].toLowerCase() : null;
    const useNova3 =
      !lang || NOVA3_LANGUAGES.has(lang) || (baseLang !== null && NOVA3_LANGUAGES.has(baseLang));
    // options.model is intentionally ignored: the registry only offers nova-3,
    // and honouring a user-pinned family would defeat the nova-2 downgrade that
    // keeps languages outside NOVA3_LANGUAGES working.
    const model = useNova3 ? "nova-3" : "nova-2";
    this.currentModel = model;

    if (!useNova3) {
      debugLogger.debug("Deepgram falling back to nova-2", { language: lang });
    }

    const params = new URLSearchParams({
      encoding: "linear16",
      sample_rate: String(sampleRate),
      channels: "1",
      model,
      punctuate: "true",
      interim_results: "true",
    });
    if (lang) {
      params.set("language", lang);
    }
    if (Array.isArray(options.keyterms)) {
      // Nova-3 uses "keyterm", Nova-2 uses "keywords"
      const paramName = useNova3 ? "keyterm" : "keywords";
      for (const term of options.keyterms) {
        if (term) params.append(paramName, term);
      }
    }
    return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  }

  cacheToken(token: string): void {
    this.cachedToken = token;
    this.tokenFetchedAt = Date.now();
    debugLogger.debug("Deepgram token cached", { expiresIn: TOKEN_EXPIRY_MS });
  }

  // A token or warm socket minted under one direct credential must never serve
  // another connection. Callers that read the cache before connecting adopt
  // the direct mode first.
  adoptMode(options: DeepgramStreamingOptions): void {
    if (options.mode !== "byok") {
      throw new Error("Deepgram realtime requires a direct provider API key");
    }
    const mode = "byok";
    if (this.mode !== null && this.mode !== mode) {
      debugLogger.debug("Deepgram credential mode changed, dropping cached session state", {
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

  startKeepAlive(socket?: RealtimeSocket | null): void {
    this.stopKeepAlive();
    const target = socket || this.warmConnection;
    const isWarm = !socket;
    debugLogger.debug("Deepgram keep-alive started", { isWarm });
    this.keepAliveInterval = setInterval(() => {
      if (target && target.readyState === WebSocket.OPEN) {
        try {
          // Warm connections send silence audio — Deepgram's net0001 idle timeout
          // only resets on audio data, not KeepAlive messages, for pre-audio sessions.
          // Active connections use KeepAlive JSON (audio flow already resets the timer).
          target.send(isWarm ? SILENCE_FRAME : JSON.stringify({ type: "KeepAlive" }));
        } catch (err) {
          debugLogger.debug("Deepgram keep-alive failed", { error: errorMessage(err) });
          if (target === this.warmConnection) {
            this.cleanupWarmConnection();
          }
        }
      } else {
        debugLogger.debug("Deepgram keep-alive target gone", {
          isWarm,
          readyState: target?.readyState,
        });
        this.stopKeepAlive();
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      debugLogger.debug("Deepgram keep-alive stopped");
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  async warmup(options: DeepgramStreamingOptions = {}): Promise<void> {
    const { token } = options;
    if (!token) {
      throw new Error("Streaming token is required for warmup");
    }

    this.adoptMode(options);
    if (this.warmConnection) {
      debugLogger.debug(
        this.warmConnectionReady
          ? "Deepgram connection already warm"
          : "Deepgram warmup already in progress, skipping"
      );
      return;
    }

    this.warmConnectionReady = false;
    this.warmSessionId = null;
    // Only update tokenFetchedAt when the token actually changes —
    // re-warming with the same token must not reset the expiry clock.
    if (token !== this.cachedToken) {
      this.cachedToken = token;
      this.tokenFetchedAt = Date.now();
    }
    this.warmConnectionOptions = options;
    this.rewarmAttempts = 0;

    const url = this.buildWebSocketUrl(options);
    debugLogger.debug("Deepgram warming up connection");

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const resolveWarmup = (meta: WarmupMeta = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(warmupTimeout);
        this.warmConnectionReady = true;
        if (meta.requestId) {
          this.warmSessionId = meta.requestId;
        }
        // Send immediate silence frame so the connection doesn't timeout
        // before the first keep-alive interval fires.
        try {
          this.warmConnection?.send(SILENCE_FRAME);
        } catch {
          // Ignore
        }
        this.startKeepAlive();
        this.scheduleProactiveRefresh();
        debugLogger.debug("Deepgram connection warmed up", {
          sessionId: this.warmSessionId,
          via: meta.via || "unknown",
        });
        resolve();
      };

      const warmupTimeout = setTimeout(() => {
        this.cleanupWarmConnection();
        reject(new Error("Deepgram warmup connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      this.warmConnection = new WebSocket(url, {
        headers: { Authorization: authorizationHeader(this.mode, token) },
      });

      this.warmConnection.on("open", () => {
        debugLogger.debug("Deepgram warm connection socket opened");
        // Consider the socket warm as soon as it's open. Deepgram may not emit
        // Metadata until audio starts, which would make startup warmup appear broken.
        resolveWarmup({ via: "open" });
      });

      this.warmConnection.on("message", (data) => {
        try {
          const parsed: unknown = JSON.parse(data.toString());
          if (isRecord(parsed) && parsed.type === "Metadata") {
            const requestId = stringField(parsed, "request_id");
            this.warmSessionId = requestId || null;
            resolveWarmup({ requestId, via: "metadata" });
          }
        } catch (err) {
          debugLogger.error("Deepgram warmup message parse error", { error: errorMessage(err) });
        }
      });

      this.warmConnection.on("error", (error) => {
        clearTimeout(warmupTimeout);
        debugLogger.error("Deepgram warmup connection error", { error: error.message });
        // Invalidate cached token on auth failure so next attempt fetches fresh
        if (error.message && error.message.includes("401")) {
          this.cachedToken = null;
          this.tokenFetchedAt = null;
        }
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
        debugLogger.debug("Deepgram warm connection closed", {
          wasReady,
          code,
          reason: reason?.toString(),
        });
        this.cleanupWarmConnection();
        if (!settled) {
          settled = true;
          reject(new Error(`Deepgram warmup connection closed (code: ${code})`));
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
      debugLogger.debug("Deepgram max re-warm attempts reached, will cold-start next recording");
      return;
    }
    if (this.isConnected) {
      return;
    }
    if (!this.warmConnectionOptions) {
      debugLogger.debug("Deepgram cannot re-warm: no saved options");
      return;
    }

    this.rewarmAttempts++;
    const delay = Math.min(REWARM_DELAY_MS * Math.pow(2, this.rewarmAttempts - 1), 60000);
    debugLogger.debug("Deepgram scheduling re-warm", {
      attempt: this.rewarmAttempts,
      delayMs: delay,
    });
    if (this.rewarmTimer) clearTimeout(this.rewarmTimer);
    this.rewarmTimer = setTimeout(async () => {
      this.rewarmTimer = null;
      if (this.hasWarmConnection() || this.isConnected) return;

      // cleanupWarmConnection() drops these without cancelling this timer, and
      // spreading a null one loses `mode`, re-warming a BYOK key as a Bearer.
      const savedOptions = this.warmConnectionOptions;
      if (!savedOptions) {
        debugLogger.debug("Deepgram cannot re-warm: options dropped before the timer fired");
        return;
      }

      let token: string | null | undefined = this.getCachedToken();
      if (!token && this.tokenRefreshFn) {
        try {
          token = await this.tokenRefreshFn();
          if (token) this.cacheToken(token);
        } catch (err) {
          debugLogger.debug("Deepgram token refresh for re-warm failed", {
            error: errorMessage(err),
          });
        }
      }
      if (!token) {
        debugLogger.debug("Deepgram cannot re-warm: no valid token");
        return;
      }

      this.warmup({ ...savedOptions, token }).catch((err) => {
        debugLogger.debug("Deepgram auto re-warm failed", { error: errorMessage(err) });
      });
    }, delay);
  }

  scheduleProactiveRefresh(): void {
    if (this.proactiveRefreshTimer) clearTimeout(this.proactiveRefreshTimer);
    const refreshDelay = TOKEN_EXPIRY_MS - TOKEN_REFRESH_BUFFER_MS * 2;
    this.proactiveRefreshTimer = setTimeout(async () => {
      this.proactiveRefreshTimer = null;
      if (!this.hasWarmConnection() || this.isConnected) return;

      const savedOptions = this.warmConnectionOptions ? { ...this.warmConnectionOptions } : null;
      if (!savedOptions || !this.tokenRefreshFn) return;

      let newToken;
      try {
        newToken = await this.tokenRefreshFn();
      } catch (err) {
        debugLogger.debug("Deepgram proactive token refresh failed", {
          error: errorMessage(err),
        });
        return;
      }
      if (!newToken || this.isConnected) return;

      debugLogger.debug("Deepgram rotating warm connection with fresh token");
      this.cleanupWarmConnection();
      this.cacheToken(newToken);
      this.rewarmAttempts = 0;
      this.warmup({ ...savedOptions, token: newToken }).catch((err) => {
        debugLogger.debug("Deepgram proactive re-warm failed", { error: errorMessage(err) });
      });
    }, refreshDelay);
  }

  useWarmConnection(): boolean {
    if (!this.warmConnection || !this.warmConnectionReady) {
      return false;
    }

    if (this.warmConnection.readyState !== WebSocket.OPEN) {
      debugLogger.debug("Deepgram warm connection readyState not OPEN, discarding", {
        readyState: this.warmConnection.readyState,
      });
      this.cleanupWarmConnection();
      return false;
    }

    this.stopKeepAlive();
    if (this.proactiveRefreshTimer) clearTimeout(this.proactiveRefreshTimer);
    this.proactiveRefreshTimer = null;

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
      debugLogger.error("Deepgram WebSocket error", { error: error.message });
      this.cleanup();
      if (wasActive && !this.isDisconnecting) this.notifyConnectionLost(error);
    });

    this.ws.removeAllListeners("close");
    this.ws.on("close", (code, reason) => {
      const wasActive = this.isConnected;
      debugLogger.debug("Deepgram WebSocket closed", {
        code,
        reason: reason?.toString(),
        wasActive,
      });
      if (this.closeResolve) {
        this.closeResolve({ text: this.accumulatedText });
      }
      this.cleanup();
      if (wasActive && !this.isDisconnecting) {
        this.notifyConnectionLost(new Error(`Connection lost (code: ${code})`));
      }
    });

    this.startKeepAlive(this.ws);
    debugLogger.debug("Deepgram using pre-warmed connection");
    return true;
  }

  cleanupWarmConnection(): void {
    this.stopKeepAlive();
    if (this.proactiveRefreshTimer) clearTimeout(this.proactiveRefreshTimer);
    this.proactiveRefreshTimer = null;
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
    const result =
      this.warmConnection !== null &&
      this.warmConnectionReady &&
      this.warmConnection.readyState === WebSocket.OPEN;
    if (!result && (this.warmConnection || this.warmConnectionReady)) {
      debugLogger.debug("Deepgram hasWarmConnection=false", {
        hasSocket: this.warmConnection !== null,
        ready: this.warmConnectionReady,
        readyState: this.warmConnection?.readyState,
        hasKeepAlive: this.keepAliveInterval !== null,
      });
    }
    return result;
  }

  startLivenessCheck(): void {
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    this.livenessTimer = setTimeout(() => {
      this.handleLivenessTimeout().catch((err) => {
        debugLogger.error("Deepgram liveness reconnect error", { error: errorMessage(err) });
      });
    }, LIVENESS_TIMEOUT_MS);
  }

  async handleLivenessTimeout(): Promise<void> {
    if (this.resultsReceived > 0 || !this.isConnected) return;

    const gen = this._generation;
    const savedReplay = this.replayBuffer;

    debugLogger.warn("Deepgram warm connection unresponsive, reconnecting", {
      audioBytesSent: this.audioBytesSent,
    });

    this.isDisconnecting = true;
    this.cleanup();
    this.isDisconnecting = false;

    if (gen !== this._generation) return;

    let token: string | null | undefined = this.getCachedToken();
    if (!token && this.tokenRefreshFn) {
      try {
        token = await this.tokenRefreshFn();
        if (token) this.cacheToken(token);
      } catch (err) {
        debugLogger.error("Deepgram reconnect token refresh failed", {
          error: errorMessage(err),
        });
        return;
      }
    }
    if (!token) return;
    if (gen !== this._generation) return;

    try {
      await this.connect({
        ...(this.connectionOptions || {}),
        token,
        replayBuffer: savedReplay,
        forceNew: true,
      });
      debugLogger.debug("Deepgram liveness reconnect succeeded");
    } catch (err) {
      debugLogger.error("Deepgram liveness reconnect failed", { error: errorMessage(err) });
    }
  }

  async connect(options: DeepgramStreamingOptions = {}): Promise<void> {
    const { token, replayBuffer, forceNew } = options;
    if (!token) {
      throw new Error("Streaming token is required");
    }

    if (this.isConnected) {
      debugLogger.debug("Deepgram streaming already connected");
      return;
    }

    this.adoptMode(options);
    this.connectionOptions = {
      sampleRate: options.sampleRate,
      language: options.language,
      keyterms: options.keyterms,
      mode: options.mode,
    };
    this.accumulatedText = "";
    this.finalSegments = [];
    this.audioBytesSent = 0;
    this.resultsReceived = 0;
    this.connectionLossNotified = false;

    if (replayBuffer && replayBuffer.length > 0) {
      this.coldStartBuffer = replayBuffer;
      this.coldStartBufferSize = replayBuffer.reduce((sum, b) => sum + b.length, 0);
      debugLogger.debug("Deepgram replaying buffered audio", {
        chunks: replayBuffer.length,
        bytes: this.coldStartBufferSize,
      });
    } else {
      this.coldStartBuffer = [];
      this.coldStartBufferSize = 0;
    }

    // The socket carries these for its whole life, so riding a warm one opened
    // for other values transcribes the session under them — silently, since
    // Deepgram has no reason to object to the audio.
    if (
      this.hasWarmConnection() &&
      this.warmConnectionOptions &&
      urlIdentity(this.warmConnectionOptions) !== urlIdentity(options)
    ) {
      debugLogger.debug("Deepgram warm connection differs, cold-starting", {
        warm: urlIdentity(this.warmConnectionOptions),
        requested: urlIdentity(options),
      });
      this.cleanupWarmConnection();
    }

    if (!forceNew && this.hasWarmConnection()) {
      if (this.useWarmConnection()) {
        this.startLivenessCheck();
        debugLogger.debug("Deepgram using warm connection - instant start");
        return;
      }
    }

    const url = this.buildWebSocketUrl(options);
    debugLogger.debug("Deepgram streaming connecting (cold start)");

    return new Promise<void>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      this.connectionTimeout = setTimeout(() => {
        this.cleanup();
        reject(new Error("Deepgram WebSocket connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      this.ws = new WebSocket(url, {
        headers: { Authorization: authorizationHeader(this.mode, token) },
      });

      this.ws.on("open", () => {
        debugLogger.debug("Deepgram WebSocket connected");
      });

      this.ws.on("message", (data) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (error) => {
        const wasActive = this.isConnected;
        debugLogger.error("Deepgram WebSocket error", { error: error.message });
        // Invalidate cached token on auth failure so next attempt fetches fresh
        if (error.message && error.message.includes("401")) {
          this.cachedToken = null;
          this.tokenFetchedAt = null;
        }
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
        debugLogger.debug("Deepgram WebSocket closed", {
          code,
          reason: reason?.toString(),
          wasActive,
        });
        if (this.pendingReject) {
          this.pendingReject(new Error(`WebSocket closed before ready (code: ${code})`));
          this.pendingReject = null;
          this.pendingResolve = null;
        }
        if (this.closeResolve) {
          this.closeResolve({ text: this.accumulatedText });
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

      // Resolve pending connect() promise on first valid message.
      // With nova-3, when audio is already flowing, Deepgram may skip
      // the Metadata message and jump straight to SpeechStarted/Results.
      if (this.pendingResolve) {
        this.isConnected = true;
        this.sessionStartedAt = Date.now();
        if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
        this.startKeepAlive(this.ws);
        if (message.type === "Metadata") {
          this.sessionId = stringField(message, "request_id") || null;
        }
        debugLogger.debug("Deepgram session started", {
          sessionId: this.sessionId,
          firstMessageType: message.type,
        });
        this.pendingResolve();
        this.pendingResolve = null;
        this.pendingReject = null;
      }

      switch (message.type) {
        case "Metadata":
          this.sessionId = stringField(message, "request_id") || null;
          break;

        case "Results": {
          this.resultsReceived++;
          if (this.livenessTimer) {
            clearTimeout(this.livenessTimer);
            this.livenessTimer = null;
            this.replayBuffer = [];
            this.replayBufferSize = 0;
          }
          const alternatives = recordField(message, "channel")?.alternatives;
          const firstAlternative = Array.isArray(alternatives) ? alternatives[0] : undefined;
          const transcript = isRecord(firstAlternative)
            ? stringField(firstAlternative, "transcript")
            : undefined;
          if (!transcript) break;

          if (message.is_final || message.from_finalize) {
            const trimmed = transcript.trim();
            if (trimmed) {
              this.finalSegments.push(trimmed);
              this.accumulatedText = this.finalSegments.join(" ");
              const start = numberField(message, "start");
              const startedAt =
                this.sessionStartedAt != null && start !== undefined
                  ? this.sessionStartedAt + start * 1000
                  : Date.now();
              this.onFinalTranscript?.(this.accumulatedText, startedAt);
              debugLogger.debug("Deepgram final transcript", {
                text: trimmed.slice(0, 100),
                totalAccumulated: this.accumulatedText.length,
              });
            }
          } else {
            this.onPartialTranscript?.(transcript);
          }
          break;
        }

        case "UtteranceEnd":
          debugLogger.debug("Deepgram utterance end");
          break;

        case "SpeechStarted":
          debugLogger.debug("Deepgram speech started");
          break;

        case "Error":
          debugLogger.error("Deepgram streaming error", { error: message.description });
          this.onError?.(new Error(stringField(message, "description") || "Deepgram error"));
          break;

        default:
          debugLogger.debug("Deepgram unknown message type", { type: message.type });
      }
    } catch (err) {
      debugLogger.error("Deepgram message parse error", { error: errorMessage(err) });
    }
  }

  sendAudio(pcmBuffer: Buffer): boolean {
    if (!this.ws) {
      if (this.audioBytesSent === 0 && pcmBuffer.length > 0) {
        debugLogger.warn("Deepgram sendAudio: ws is null, audio dropped", {
          bufferSize: pcmBuffer.length,
          isConnected: this.isConnected,
        });
      }
      return false;
    }

    if (this.ws.readyState !== WebSocket.OPEN) {
      // Buffer audio during cold start so no frames are lost while WebSocket connects
      if (
        this.ws.readyState === WebSocket.CONNECTING &&
        this.coldStartBufferSize < COLD_START_BUFFER_MAX
      ) {
        const copy = Buffer.from(pcmBuffer);
        this.coldStartBuffer.push(copy);
        this.coldStartBufferSize += copy.length;
      }
      return false;
    }

    if (this.keepAliveInterval) {
      this.stopKeepAlive();
    }

    // Flush any audio buffered during cold start
    if (this.coldStartBuffer.length > 0) {
      debugLogger.debug("Deepgram flushing cold-start buffer", {
        chunks: this.coldStartBuffer.length,
        bytes: this.coldStartBufferSize,
      });
      for (const buf of this.coldStartBuffer) {
        this.ws.send(buf);
      }
      this.coldStartBuffer = [];
      this.coldStartBufferSize = 0;
    }

    if (this.livenessTimer) {
      const copy = Buffer.from(pcmBuffer);
      this.replayBuffer.push(copy);
      this.replayBufferSize += copy.length;
    }

    this.audioBytesSent += pcmBuffer.length;
    this.ws.send(pcmBuffer);
    return true;
  }

  finalize(): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    this.ws.send(JSON.stringify({ type: "Finalize" }));
    debugLogger.debug("Deepgram Finalize sent");
    return true;
  }

  async disconnect(closeStream = true): Promise<TranscriptResult> {
    this._generation++;
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    this.livenessTimer = null;

    debugLogger.debug("Deepgram disconnect", {
      audioBytesSent: this.audioBytesSent,
      resultsReceived: this.resultsReceived,
      textLength: this.accumulatedText.length,
    });

    if (!this.ws) return { text: this.accumulatedText };

    this.isDisconnecting = true;

    if (closeStream && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "CloseStream" }));

      let timeoutId;
      const result = await Promise.race([
        new Promise<TranscriptResult>((resolve) => {
          this.closeResolve = resolve;
        }),
        new Promise<TranscriptResult>((resolve) => {
          timeoutId = setTimeout(() => {
            debugLogger.debug("Deepgram close timeout, using accumulated text");
            resolve({ text: this.accumulatedText });
          }, TERMINATION_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timeoutId);

      this.closeResolve = null;
      this.cleanup();
      this.isDisconnecting = false;
      this.accumulatedText = "";
      this.finalSegments = [];
      return result;
    }

    const result = { text: this.accumulatedText };
    this.cleanup();
    this.isDisconnecting = false;
    this.accumulatedText = "";
    this.finalSegments = [];
    return result;
  }

  cleanup(): void {
    this.stopKeepAlive();
    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    this.livenessTimer = null;
    this.replayBuffer = [];
    this.replayBufferSize = 0;

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
    this.closeResolve = null;
  }

  cleanupAll(): void {
    this.cleanup();
    this.cleanupWarmConnection();
    if (this.rewarmTimer) clearTimeout(this.rewarmTimer);
    this.rewarmTimer = null;
    if (this.proactiveRefreshTimer) clearTimeout(this.proactiveRefreshTimer);
    this.proactiveRefreshTimer = null;
    this.cachedToken = null;
    this.tokenFetchedAt = null;
    this.warmConnectionOptions = null;
    this.finalSegments = [];
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

module.exports = DeepgramStreaming;
module.exports.DeepgramStreaming = DeepgramStreaming;
module.exports.authorizationHeader = authorizationHeader;
