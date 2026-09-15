interface SocketData {
  toString(): string;
}

interface RealtimeSocket {
  readyState: number;
  isAlive?: boolean;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: SocketData) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number, reason?: SocketData) => void): this;
  on(event: "pong", listener: () => void): this;
  send(data: string | Buffer): void;
  close(code?: number): void;
  terminate(): void;
  ping(): void;
}

interface RealtimeSocketConstructor {
  new (url: string): RealtimeSocket;
  readonly OPEN: number;
}

const WebSocket: RealtimeSocketConstructor = require("ws");
const debugLogger = require("./debugLogger");
const {
  computePcm16Rms,
}: { computePcm16Rms: (pcmBuffer: Buffer) => number } = require("../utils/audioUtils.js");

type Timer = ReturnType<typeof setTimeout>;
type JsonRecord = Record<string, unknown>;

export interface GeminiLiveOptions {
  token?: string | null;
  mode?: string;
  model?: string | null;
  language?: string | null;
  keyterms?: readonly string[];
}

interface GeminiSetupInputTranscription {
  languageCodes?: string[];
  customVocabulary?: string[];
}

interface TranscriptResult {
  text: string;
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

const errorMessage = (error: unknown): string | undefined =>
  error instanceof Error
    ? error.message
    : isRecord(error)
      ? stringField(error, "message")
      : undefined;

const SAMPLE_RATE = 16000;
const WEBSOCKET_TIMEOUT_MS = 15000;
// Budget for the final transcript, measured from audioStreamEnd (it lands
// ~500ms after, ~2s at the p95 tail). The renderer's gemini settle ceiling in
// audioManager.js is the same 3s; disconnect only spends what is left of it.
const DISCONNECT_TIMEOUT_MS = 3000;
const KEEPALIVE_INTERVAL_MS = 15000;
const COLD_START_BUFFER_MAX = 3 * SAMPLE_RATE * 2; // 3 seconds of 16-bit PCM
// Google documents a 1000-phrase ceiling but only promises quality up to 100;
// the batch dictionary paths truncate the same array at 100.
const MAX_CUSTOM_VOCABULARY = 100;
// Trailing room noise in dictation recordings measures 0.003-0.010 RMS while
// speech frames sit above ~0.0105, so only a frame at this level is a new
// utterance rather than the tail of a turn the server already closed.
const TURN_REOPEN_RMS = 0.012;
export const GEMINI_LIVE_MODEL = "gemini-3.5-transcribe-live";

const resolveLiveModel = (model?: string | null): string =>
  model && model.startsWith("gemini-") ? model : GEMINI_LIVE_MODEL;

const WS_BASE = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage";

export function buildGeminiLiveUrl({ token }: { token: string }): string {
  return `${WS_BASE}.v1beta.GenerativeService.BidiGenerateContent?key=${token}`;
}

// Every Live failure arrives as a close frame after the upgrade succeeded (the
// socket's `error` event never carries them), and the server truncates close
// reasons to the 123-byte WebSocket limit — classify on the code alone; the
// reason is only logged by the close handler.
function closeFrameError(code: number): Error {
  if (code === 1011) {
    // A provider key that the service rejects is not recoverable by retrying.
    return Object.assign(new Error("Gemini Live session token expired"), {
      code: "AUTH_EXPIRED",
    });
  }
  if (code === 1007 || code === 1008) {
    // 1007 is a malformed credential, 1008 one Google no longer knows (revoked
    // or deleted); neither is retryable, both are fixed in Settings.
    return Object.assign(new Error("Invalid Gemini API key. Check your key in Settings."), {
      code: "INVALID_KEY",
    });
  }
  return new Error(`Gemini Live closed before ready (code: ${code})`);
}

export class GeminiLiveStreaming {
  declare ws: RealtimeSocket | null;
  declare isConnected: boolean;
  declare isConnecting: boolean;
  declare isDisconnecting: boolean;
  declare completedSegments: string[];
  declare onPartialTranscript: ((text: string) => void) | null;
  declare onFinalTranscript: ((text: string, startedAt: number) => void) | null;
  declare onError: ((error: Error) => void) | null;
  declare onSessionEnd: ((result: TranscriptResult) => void) | null;
  declare onConnectionLost: ((error: Error) => void) | null;
  declare pendingResolve: (() => void) | null;
  declare pendingReject: ((reason?: unknown) => void) | null;
  declare connectionTimeout: Timer | null;
  declare keepAliveInterval: Timer | null;
  declare coldStartBuffer: Buffer[];
  declare coldStartBufferSize: number;
  declare bufferingAudio: boolean;
  declare audioBytesSent: number;
  declare currentModel: string;
  declare _connectionLossNotified: boolean;
  declare _audioStreamEndSentAt: number | null;
  declare _turnEnded: boolean;
  declare _turnEndResolve: (() => void) | null;

  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.isDisconnecting = false;
    this.completedSegments = [];
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onSessionEnd = null;
    this.onConnectionLost = null;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.connectionTimeout = null;
    this.keepAliveInterval = null;
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
    this.bufferingAudio = false;
    this.audioBytesSent = 0;
    this.currentModel = GEMINI_LIVE_MODEL;
    this._connectionLossNotified = false;
    this._audioStreamEndSentAt = null;
    this._turnEnded = false;
    this._turnEndResolve = null;
  }

  // Starts buffering audio before the socket exists, covering the token fetch
  // and the 350ms-1.4s handshake so sendAudio() doesn't drop the first words.
  beginConnecting() {
    this.bufferingAudio = true;
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
  }

  getFullTranscript() {
    return this.completedSegments.join(" ");
  }

  // Test seam: overridden to point at a loopback server.
  buildWebSocketUrl(options: GeminiLiveOptions & { token: string }): string {
    return buildGeminiLiveUrl({ token: options.token });
  }

  buildSetupMessage({ model, language, keyterms }: GeminiLiveOptions = {}) {
    const customVocabulary = (keyterms || [])
      .map((term) => String(term).trim())
      .filter(Boolean)
      .slice(0, MAX_CUSTOM_VOCABULARY);
    const inputAudioTranscription: GeminiSetupInputTranscription = {};
    // `languageCodes` on its own costs punctuation and sentence casing, and an
    // invalid locale is accepted silently — only ever send a language the user
    // picked explicitly ("auto" is stripped upstream).
    if (language) inputAudioTranscription.languageCodes = [language];
    if (customVocabulary.length) inputAudioTranscription.customVocabulary = customVocabulary;

    return {
      setup: {
        model: `models/${resolveLiveModel(model)}`,
        generationConfig: { responseModalities: ["TEXT"] },
        inputAudioTranscription,
      },
    };
  }

  async connect(options: GeminiLiveOptions = {}): Promise<void> {
    const { token, mode } = options;
    if (mode !== "byok") {
      throw new Error("Gemini realtime requires a direct provider API key");
    }
    if (!token) {
      throw Object.assign(new Error("Gemini API key not configured. Add your key in Settings."), {
        code: "API_KEY_MISSING",
      });
    }

    if (this.isConnected || this.isConnecting) {
      debugLogger.debug("Gemini Live already connected/connecting");
      return;
    }

    if (!this.bufferingAudio) this.beginConnecting();
    this.completedSegments = [];
    this.audioBytesSent = 0;
    this.currentModel = resolveLiveModel(options.model);
    this._connectionLossNotified = false;
    this._audioStreamEndSentAt = null;
    this._turnEnded = false;

    await this._openSocket({ ...options, token });
  }

  _openSocket(options: GeminiLiveOptions & { token: string }): Promise<void> {
    const url = this.buildWebSocketUrl(options);
    debugLogger.debug("Gemini Live connecting", {
      mode: "byok",
      model: this.currentModel,
    });

    return new Promise<void>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      this.isConnecting = true;
      this.connectionTimeout = setTimeout(() => {
        this.cleanup();
        reject(new Error("Gemini Live connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      const socket = new WebSocket(url);
      this.ws = socket;

      socket.on("open", () => {
        // Audio sent before setupComplete is discarded by the server, so the
        // setup message is the only thing that goes out on open.
        socket.send(JSON.stringify(this.buildSetupMessage(options)));
      });

      socket.on("message", (data) => {
        this.handleMessage(data);
      });

      socket.on("error", (error) => {
        const wasActive = this.isConnected;
        debugLogger.error("Gemini Live WebSocket error", { error: error.message });
        this.cleanup();
        this._rejectPending(error);
        if (wasActive && !this.isDisconnecting) {
          this._notifyConnectionLost(error);
        } else if (!this.isDisconnecting) {
          this.onError?.(error);
        }
      });

      socket.on("close", (code, reason) => {
        const wasActive = this.isConnected;
        debugLogger.debug("Gemini Live WebSocket closed", {
          code,
          reason: reason?.toString() || "",
          wasActive,
        });
        this._resolveTurnEnd();
        this.cleanup();
        if (!wasActive) {
          this._rejectPending(closeFrameError(code));
        } else if (!this.isDisconnecting) {
          // A session killed mid-dictation (the ~10 minute cap, a dead network)
          // still hands over what it transcribed; there is no resumption handle
          // to reconnect with, so the caller finalizes with this text.
          this.onSessionEnd?.({ text: this.getFullTranscript() });
          this._notifyConnectionLost(new Error(`Connection lost (code: ${code})`));
        }
      });
    });
  }

  // The complete server vocabulary is `setupComplete` plus
  // `serverContent.{speechState, interimInputTranscription, inputTranscription,
  // generationComplete}`. There is no `turnComplete`, no `usageMetadata` and no
  // `sessionResumptionUpdate` on this model, so end-of-turn is the final
  // transcript arriving with `generationComplete` in the same millisecond.
  handleMessage(data: SocketData): void {
    try {
      const parsed: unknown = JSON.parse(data.toString());
      if (!isRecord(parsed)) return;
      const message = parsed;

      if (message.setupComplete) this._markConnected();

      const serverContent = recordField(message, "serverContent");
      if (!serverContent) return;

      // Partials are revised, not appended to ("The quick brown" becomes
      // "the quick brown fox"), so consumers must replace the whole string.
      const partial = stringField(recordField(serverContent, "interimInputTranscription"), "text");
      if (partial) {
        this._turnEnded = false;
        this.onPartialTranscript?.(partial);
      }

      const final = stringField(recordField(serverContent, "inputTranscription"), "text")?.trim();
      if (final) {
        this.completedSegments.push(final);
        const fullText = this.getFullTranscript();
        this.onFinalTranscript?.(fullText, Date.now());
        debugLogger.debug("Gemini Live turn completed", {
          turnText: final.slice(0, 100),
          totalLength: fullText.length,
          segments: this.completedSegments.length,
        });
      }

      // The server closes a turn on trailing silence, often before the hotkey is
      // released; that generationComplete already answers the final. Speech
      // (a loud frame or a new partial) reopens a turn, so a later stop waits again.
      if (serverContent.generationComplete) this._resolveTurnEnd();
    } catch (err) {
      debugLogger.error("Gemini Live message parse error", { error: errorMessage(err) });
    }
  }

  _markConnected(): void {
    if (this.isConnected) return;
    this.isConnected = true;
    this.isConnecting = false;
    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    this.startKeepAlive();
    debugLogger.debug("Gemini Live setup complete", { model: this.currentModel });
    // A dictation shorter than the handshake leaves every frame in the buffer,
    // and sendAudio never runs again to drain it.
    this._flushColdStartBuffer();
    if (this.pendingResolve) {
      this.pendingResolve();
      this.pendingResolve = null;
      this.pendingReject = null;
    }
  }

  _rejectPending(error: Error): void {
    if (!this.pendingReject) return;
    this.pendingReject(error);
    this.pendingReject = null;
    this.pendingResolve = null;
  }

  _notifyConnectionLost(error: Error): void {
    if (this._connectionLossNotified) return;
    this._connectionLossNotified = true;
    if (this.onConnectionLost) {
      this.onConnectionLost(error);
    } else {
      this.onError?.(error);
    }
  }

  _resolveTurnEnd(): void {
    this._turnEnded = true;
    this._turnEndResolve?.();
    this._turnEndResolve = null;
  }

  // A warm socket sits idle between dictations with no other liveness check; a
  // network path that dies silently leaves isConnected stuck true and the next
  // recording gets sent into a dead socket.
  startKeepAlive(): void {
    this.stopKeepAlive();
    const socket = this.ws;
    if (!socket) return;

    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });

    this.keepAliveInterval = setInterval(() => {
      if (socket !== this.ws || socket.readyState !== WebSocket.OPEN) {
        this.stopKeepAlive();
        return;
      }
      if (socket.isAlive === false) {
        debugLogger.debug("Gemini Live keep-alive missed pong, terminating stale connection");
        socket.terminate();
        return;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch (err) {
        debugLogger.debug("Gemini Live keep-alive ping failed", { error: errorMessage(err) });
        socket.terminate();
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  _sendAudioFrame(pcmBuffer: Buffer): void {
    const socket = this.ws;
    if (!socket) return;
    socket.send(
      JSON.stringify({
        realtimeInput: {
          audio: { data: pcmBuffer.toString("base64"), mimeType: `audio/pcm;rate=${SAMPLE_RATE}` },
        },
      })
    );
    this.audioBytesSent += pcmBuffer.length;
    if (this._turnEnded && computePcm16Rms(pcmBuffer) >= TURN_REOPEN_RMS) this._turnEnded = false;
  }

  sendAudio(pcmBuffer: Buffer | null | undefined): boolean {
    // The capture worklet ends its stream with a "flushed" string sentinel;
    // only s16 PCM (even byte length) is audio, and only audioStreamEnd closes
    // a Gemini turn.
    if (!pcmBuffer || pcmBuffer.length % 2 !== 0) return false;

    if (this.ws?.readyState !== WebSocket.OPEN || !this.isConnected) {
      if (this.bufferingAudio && this.coldStartBufferSize < COLD_START_BUFFER_MAX) {
        const copy = Buffer.from(pcmBuffer);
        this.coldStartBuffer.push(copy);
        this.coldStartBufferSize += copy.length;
      }
      return false;
    }

    this._flushColdStartBuffer();
    this._sendAudioFrame(pcmBuffer);
    return true;
  }

  _flushColdStartBuffer(): void {
    if (this.coldStartBuffer.length === 0) return;
    debugLogger.debug("Gemini Live flushing cold-start buffer", {
      chunks: this.coldStartBuffer.length,
      bytes: this.coldStartBufferSize,
    });
    for (const buffered of this.coldStartBuffer) {
      this._sendAudioFrame(buffered);
    }
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
  }

  // Gemini has no mid-stream finalize: audioStreamEnd ends the turn, and the
  // server answers with the final transcript. Sending it from here (the stop
  // sequence calls finalize() before it waits for text) buys back the wait.
  finalize(): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN || this._audioStreamEndSentAt) return false;
    this._audioStreamEndSentAt = Date.now();
    this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    debugLogger.debug("Gemini Live audioStreamEnd sent", { audioBytesSent: this.audioBytesSent });
    return true;
  }

  async disconnect(closeStream = true): Promise<TranscriptResult> {
    debugLogger.debug("Gemini Live disconnect", {
      audioBytesSent: this.audioBytesSent,
      segments: this.completedSegments.length,
      textLength: this.getFullTranscript().length,
      readyState: this.ws?.readyState,
    });

    if (!this.ws) return this._takeTranscript();

    this.isDisconnecting = true;

    if (closeStream && this.ws.readyState === WebSocket.OPEN && this.isConnected) {
      this._flushColdStartBuffer();
    }

    if (closeStream && this.ws.readyState === WebSocket.OPEN && this.audioBytesSent > 0) {
      this.finalize();
      if (!this._turnEnded) await this._awaitTurnEnd();
    }

    const result = this._takeTranscript();
    this.cleanup();
    this.isDisconnecting = false;
    return result;
  }

  // The stop sequence finalizes first and waits on the renderer side before it
  // gets here, so the budget runs from audioStreamEnd, not from this call.
  async _awaitTurnEnd(): Promise<void> {
    const audioStreamEndSentAt = this._audioStreamEndSentAt;
    if (audioStreamEndSentAt === null) return;
    const remaining = DISCONNECT_TIMEOUT_MS - (Date.now() - audioStreamEndSentAt);
    if (remaining <= 0) return;
    let timeoutId;
    await Promise.race([
      new Promise<void>((resolve) => {
        this._turnEndResolve = resolve;
      }),
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(() => {
          debugLogger.debug("Gemini Live final transcript timeout, using accumulated text");
          resolve();
        }, remaining);
      }),
    ]);
    clearTimeout(timeoutId);
    this._turnEndResolve = null;
  }

  _takeTranscript(): TranscriptResult {
    const result = { text: this.getFullTranscript() };
    this.completedSegments = [];
    return result;
  }

  cleanup(): void {
    if (this.connectionTimeout) clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    this.stopKeepAlive();

    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }

    this.isConnected = false;
    this.isConnecting = false;
    this.bufferingAudio = false;
  }

  getStatus(): { isConnected: boolean; isConnecting: boolean } {
    return { isConnected: this.isConnected, isConnecting: this.isConnecting };
  }
}

module.exports = { GeminiLiveStreaming, buildGeminiLiveUrl, GEMINI_LIVE_MODEL };
