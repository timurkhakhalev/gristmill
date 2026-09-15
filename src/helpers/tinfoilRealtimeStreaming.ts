import {
  OpenAIRealtimeStreaming,
  type OpenAIRealtimeConnectOptions,
  type RealtimeSocket,
  type StreamingTranscriptResult,
} from "./openaiRealtimeStreaming.js";
import { createTinfoilRealtimeSocket } from "./tinfoilSecureClient.js";

const WebSocket: { readonly OPEN: number } = require("ws");
const debugLogger = require("./debugLogger");

type Timer = ReturnType<typeof setTimeout>;
type JsonRecord = Record<string, unknown>;

interface SocketData {
  toString(): string;
}

export interface TinfoilRealtimeConnectOptions extends OpenAIRealtimeConnectOptions {
  apiKey?: string | null;
  model?: string | null;
}

type TinfoilSocketFactory = (options: { model: string; apiKey: string }) => Promise<RealtimeSocket>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null;

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

export const TINFOIL_REALTIME_MODEL = "voxtral-mini-4b-realtime";
const COMMIT_POLL_MS = 250;
const COMMIT_IDLE_MS = 600;
const MAX_TURN_MS = 30000;
const COMMIT_ACK_TIMEOUT_MS = 20000;
const COMMIT_DRAIN_TIMEOUT_MS = 3000;
const SPEECH_RMS_THRESHOLD = 0.003;
const SPEECH_PEAK_THRESHOLD = 0.02;

const isEmptyBufferError = (error: JsonRecord): boolean => {
  const message = stringField(error, "message") || "";
  return (
    stringField(error, "code") === "input_audio_buffer_commit_empty" ||
    message.includes("buffer too small") ||
    message.includes("commit_empty")
  );
};

const hasSpeechEnergy = (pcmBuffer: Buffer): boolean => {
  if (!pcmBuffer?.length) return false;
  const samples = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    Math.floor(pcmBuffer.byteLength / 2)
  );
  let sumSquares = 0;
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] / 0x7fff;
    sumSquares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  return (
    Math.sqrt(sumSquares / samples.length) >= SPEECH_RMS_THRESHOLD && peak >= SPEECH_PEAK_THRESHOLD
  );
};

export class TinfoilRealtimeStreaming extends OpenAIRealtimeStreaming {
  declare _createSocketImpl: TinfoilSocketFactory;
  declare _commitTimer: Timer | null;
  declare _commitInFlight: boolean;
  declare _commitSentAt: number;
  declare _commitDrain: Promise<void> | null;
  declare _commitDrainResolve: (() => void) | null;
  declare _turnStartedAt: number;
  declare _lastSpeechAt: number;
  declare _turnSpeechStartedAt: number;
  declare _turnHasAudio: boolean;
  declare _recoveryRequested: boolean;

  constructor(
    // SAFETY: the attested SDK factory returns its WebSocket transport; the local SDK boundary
    // uses unknown because the package does not expose a compatible socket type.
    createSocketImpl: TinfoilSocketFactory =
      createTinfoilRealtimeSocket as TinfoilSocketFactory
  ) {
    super();
    this.providerLabel = "Tinfoil Realtime";
    this._createSocketImpl = createSocketImpl;
    this._commitTimer = null;
    this._commitInFlight = false;
    this._commitSentAt = 0;
    this._commitDrain = null;
    this._commitDrainResolve = null;
    this._turnStartedAt = 0;
    this._lastSpeechAt = 0;
    this._turnSpeechStartedAt = 0;
    this._turnHasAudio = false;
    this._recoveryRequested = false;
  }

  async connect(options: TinfoilRealtimeConnectOptions = {}): Promise<void> {
    const { apiKey } = options;
    const model = options.model || TINFOIL_REALTIME_MODEL;
    if (!apiKey) throw new Error(`${this.providerLabel} API key is required`);
    return super.connect({
      ...options,
      model,
      createSocket: () => this._createSocketImpl({ model, apiKey }),
    });
  }

  sendAudio(pcmBuffer: Buffer): boolean {
    const buffer = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer);
    const accepted = super.sendAudio(buffer);
    if ((!accepted && !this.bufferingAudio) || !buffer.length) return accepted;

    const now = Date.now();
    this._turnHasAudio = true;
    if (!this._turnStartedAt) this._turnStartedAt = now;
    if (hasSpeechEnergy(buffer)) {
      this._lastSpeechAt = now;
      if (!this._turnSpeechStartedAt) this._turnSpeechStartedAt = now;
      if (!this._commitInFlight && !this.speechStartedAt) {
        this.speechStartedAt = this._turnSpeechStartedAt;
      }
    }
    return accepted;
  }

  handleMessage(data: SocketData): void {
    let event: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(data.toString());
      if (!isRecord(parsed)) {
        super.handleMessage(data);
        return;
      }
      event = parsed;
    } catch {
      super.handleMessage(data);
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const nextTurnSpeechStartedAt = this._turnSpeechStartedAt;
      this._recoveryRequested = false;
      this._settleCommit();
      super.handleMessage(data);
      if (nextTurnSpeechStartedAt && !this.speechStartedAt) {
        this.speechStartedAt = nextTurnSpeechStartedAt;
      }
      return;
    }

    if (event.type === "error" && this._commitInFlight) {
      const error = isRecord(event.error) ? event.error : {};
      this._settleCommit();
      if (isEmptyBufferError(error)) {
        this.currentPartial = "";
        this.speechStartedAt = this._turnSpeechStartedAt || null;
        return;
      }
      super.handleMessage(data);
      this._requestRecovery(
        new Error(stringField(error, "message") || "Tinfoil commit failed"),
        false
      );
      return;
    }

    super.handleMessage(data);
  }

  _markConnected(): void {
    super._markConnected();
    this._startCommitTimer();
  }

  _startCommitTimer(): void {
    this._stopCommitTimer();
    this._commitTimer = setInterval(() => this._commitTick(), COMMIT_POLL_MS);
  }

  _stopCommitTimer(): void {
    if (!this._commitTimer) return;
    clearInterval(this._commitTimer);
    this._commitTimer = null;
  }

  _commitTick(): void {
    if (this.isDisconnecting || this.ws?.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (this._commitInFlight) {
      if (now - this._commitSentAt >= COMMIT_ACK_TIMEOUT_MS) {
        this._requestRecovery(new Error("Tinfoil did not finish the current transcript segment."));
      }
      return;
    }
    if (!this._turnHasAudio) return;

    const turnAge = now - this._turnStartedAt;
    const speechEnded = this._lastSpeechAt > 0 && now - this._lastSpeechAt >= COMMIT_IDLE_MS;
    if (!speechEnded && turnAge < MAX_TURN_MS) return;
    this._sendCommit();
  }

  _sendCommit(): boolean {
    if (this._commitInFlight || !this._turnHasAudio || this.ws?.readyState !== WebSocket.OPEN) {
      return false;
    }

    this._commitInFlight = true;
    this._commitSentAt = Date.now();
    this._commitDrain = new Promise<void>((resolve) => {
      this._commitDrainResolve = resolve;
    });
    try {
      this.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      this._resetTurn();
      return true;
    } catch (error) {
      this._settleCommit();
      debugLogger.debug(
        `${this.providerLabel} commit send failed`,
        this._logContext({ error: errorMessage(error) })
      );
      return false;
    }
  }

  _requestRecovery(error: Error, surfaceError = true): void {
    if (this._recoveryRequested) return;
    this._recoveryRequested = true;
    debugLogger.warn(
      `${this.providerLabel} connection recovery requested`,
      this._logContext({
        error: error.message,
      })
    );
    if (this.onConnectionLost) {
      this._notifyConnectionLost(error);
    } else if (surfaceError) {
      this.onError?.(error);
    }
  }

  _resetTurn(): void {
    this._turnStartedAt = 0;
    this._lastSpeechAt = 0;
    this._turnSpeechStartedAt = 0;
    this._turnHasAudio = false;
  }

  _settleCommit(): void {
    this._commitInFlight = false;
    this._commitSentAt = 0;
    this._commitDrainResolve?.();
    this._commitDrainResolve = null;
    this._commitDrain = null;
  }

  async disconnect(): Promise<StreamingTranscriptResult> {
    this._stopCommitTimer();
    const deadline = Date.now() + COMMIT_DRAIN_TIMEOUT_MS;
    if (!(await this._waitForCommitDrain(deadline))) {
      return super.disconnect({ commit: false });
    }
    if (!this._commitInFlight) this._sendCommit();
    await this._waitForCommitDrain(deadline);
    return super.disconnect({ commit: false });
  }

  async _waitForCommitDrain(deadline: number): Promise<boolean> {
    if (!this._commitInFlight || !this._commitDrain) return true;
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining === 0) return false;
    let timeout: Timer | undefined;
    const drained = await Promise.race([
      this._commitDrain.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), remaining);
      }),
    ]);
    clearTimeout(timeout);
    return drained;
  }

  cleanup(): void {
    this._stopCommitTimer();
    this._settleCommit();
    this._resetTurn();
    this._recoveryRequested = false;
    super.cleanup();
  }
}

module.exports = { TinfoilRealtimeStreaming, TINFOIL_REALTIME_MODEL };
