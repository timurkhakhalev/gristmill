const fs = require("fs");
const debugLogger = require("./debugLogger.js");
import type { SpeakerEmbeddings as SpeakerEmbeddingsClass } from "./speakerEmbeddings.js";
import { MAX_EMBEDDING_SECONDS } from "./speakerEmbeddings.js";
const speakerEmbeddings = require("./speakerEmbeddings.js") as SpeakerEmbeddingsClass;
const { downsample24kTo16k, pcm16ToFloat32 } = require("../utils/audioUtils.js") as {
  downsample24kTo16k: (buffer: Buffer) => Buffer;
  pcm16ToFloat32: (buffer: Buffer) => Float32Array;
};
const { MAX_SPEAKER_COUNT } = require("../constants/speakerDetection.json") as {
  MAX_SPEAKER_COUNT: number;
};

export interface IdentifiedSpeakerEvent {
  speakerId: string;
  displayName: string | null;
  startTime: number;
  endTime: number;
}

export interface SpeakerProfileLike {
  id: number;
  display_name: string | null;
  embedding: Float32Array | number[] | Buffer;
  [key: string]: unknown;
}

export interface TransientSpeakerState {
  embedding: number[];
  displayName: string | null;
  profileId: number | null;
  noteId: number | null;
}

export interface SpeakerReclusterMerge {
  keep: string;
  remove: string;
  displayName: string | null;
  similarity: number;
}

export interface StartOptions {
  onSpeakerIdentified?: ((event: IdentifiedSpeakerEvent) => void) | null;
  getSpeakerProfiles?: (() => SpeakerProfileLike[]) | null;
  maxSpeakers?: number;
  enabled?: boolean;
}

// The VAD session surface the identifier uses; onnxruntime-node is optional
// at runtime, so its types never enter this module's graph.
interface VadSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  inputMetadata?: Record<string, { dimensions?: unknown; shape?: unknown } | undefined>;
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>>;
}

interface OrtRuntime {
  InferenceSession: {
    create(modelPath: string, options: Record<string, unknown>): Promise<VadSession>;
  };
  Tensor: new (
    type: "float32" | "int64",
    data: Float32Array | BigInt64Array,
    dims: number[]
  ) => unknown;
}

interface VadManagerLike {
  isVadModelDownloaded(): boolean;
  getVadModelPath(): string;
}

function clampMaxSpeakers(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return MAX_SPEAKER_COUNT;
  return Math.max(1, Math.min(MAX_SPEAKER_COUNT, Math.floor(n)));
}

// onnxruntime-node ships no darwin/x64 prebuilt binding since 1.24, so the
// require throws on Intel Macs (#1500). A missing binding must degrade live
// speaker identification, never fail the meeting start that triggers it.
let ortLoadFailed = false;

function loadOnnxRuntime(): OrtRuntime | null {
  if (ortLoadFailed) return null;
  try {
    return require("onnxruntime-node") as OrtRuntime;
  } catch (error) {
    ortLoadFailed = true;
    debugLogger.warn(
      "onnxruntime-node binding failed to load — live speaker identification disabled",
      { error: (error as Error).message, platform: process.platform, arch: process.arch }
    );
    return null;
  }
}

const SAMPLE_RATE = 16000;
const VAD_WINDOW_SIZE = 512;
const MIN_SEGMENT_SECONDS = 1.5;
const MIN_SEGMENT_SAMPLES = Math.round(SAMPLE_RATE * MIN_SEGMENT_SECONDS);
const LIVE_IDENTIFICATION_MIN_SECONDS = 1.6;
const LIVE_IDENTIFICATION_MIN_SAMPLES = Math.round(SAMPLE_RATE * LIVE_IDENTIFICATION_MIN_SECONDS);
const LIVE_IDENTIFICATION_INTERVAL_SECONDS = 1.0;
const LIVE_IDENTIFICATION_INTERVAL_SAMPLES = Math.round(
  SAMPLE_RATE * LIVE_IDENTIFICATION_INTERVAL_SECONDS
);
const MAX_EMBEDDING_SAMPLES = SAMPLE_RATE * MAX_EMBEDDING_SECONDS;
const SPEECH_CHUNKS_MAX_SAMPLES = MAX_EMBEDDING_SAMPLES * 4;
const SPEECH_THRESHOLD = 0.15;
const SILENCE_THRESHOLD = 0.08;
const SILENCE_WINDOWS_TO_END = 24;
const MATCH_THRESHOLD = 0.65;
const MATCH_MARGIN = 0.03;
const LIVE_WINDOW_PADDING_SECONDS = 0.75;
const DEFAULT_VAD_STATE_SHAPE = [2, 1, 64];
// The VAD graph is tiny (~64 ops per 512-sample window at ~31 Hz); ORT's
// default thread pool spins one worker per core for no throughput gain.
const VAD_SESSION_OPTIONS = {
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
  executionMode: "sequential",
};

function appendFloat32(existing: Float32Array, next: Float32Array): Float32Array {
  if (!existing.length) return next;
  if (!next.length) return existing;

  const merged = new Float32Array(existing.length + next.length);
  merged.set(existing, 0);
  merged.set(next, existing.length);
  return merged;
}

function totalSampleCount(chunks: Float32Array[]): number {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  return total;
}

function concatFloat32Arrays(chunks: Float32Array[]): Float32Array {
  if (chunks.length === 0) return new Float32Array(0);
  if (chunks.length === 1) return chunks[0];

  const merged = new Float32Array(totalSampleCount(chunks));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

function trimChunksToMaxSamples(chunks: Float32Array[], maxSamples: number): void {
  let total = totalSampleCount(chunks);
  while (total > maxSamples && chunks.length > 0) {
    total -= chunks[0].length;
    chunks.shift();
  }
}

function selectBestEmbeddingWindow(samples: Float32Array): Float32Array {
  if (samples.length <= MAX_EMBEDDING_SAMPLES) return samples;

  const stride = SAMPLE_RATE;
  let bestStart = 0;
  let bestEnergy = -Infinity;

  for (let start = 0; start + MAX_EMBEDDING_SAMPLES <= samples.length; start += stride) {
    let energy = 0;
    for (let i = start; i < start + MAX_EMBEDDING_SAMPLES; i++) {
      energy += Math.abs(samples[i]);
    }
    if (energy > bestEnergy) {
      bestEnergy = energy;
      bestStart = start;
    }
  }

  return samples.subarray(bestStart, bestStart + MAX_EMBEDDING_SAMPLES);
}

function cloneFloat32Array(value: Float32Array): Float32Array {
  return new Float32Array(value);
}

function normalizeVadShape(shape: unknown): number[] {
  if (!Array.isArray(shape) || shape.length === 0) {
    return DEFAULT_VAD_STATE_SHAPE;
  }

  return shape.map((dim) => (typeof dim === "number" && dim > 0 ? dim : 1));
}

function normalizeVadStateName(name: unknown): string {
  return String(name || "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function getBufferFloat32View(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

export class LiveSpeakerIdentifier {
  session: VadSession | null;
  running: boolean;
  queue: Promise<unknown>;
  onSpeakerIdentified: ((event: IdentifiedSpeakerEvent) => void) | null;
  getSpeakerProfiles: (() => SpeakerProfileLike[]) | null;
  audioRemainder: Float32Array;
  vadStateInputs: string[];
  vadStateOutputs: string[];
  vadStates: Map<string, Float32Array>;
  speechChunks: Float32Array[];
  speechActive: boolean;
  silenceWindows: number;
  sampleCursor: number;
  segmentStartSample: number;
  segmentEndSample: number;
  transientEmbeddings: Map<string, Float32Array>;
  transientCounts: Map<string, number>;
  transientDisplayNames: Map<string, string | null>;
  transientProfileIds: Map<string, number | null>;
  transientNoteIds: Map<string, number | null>;
  nextLiveIndex: number;
  currentSegmentSpeakerId: string | null;
  currentSegmentSpeakerName: string | null;
  lastLiveIdentificationSample: number;
  _diarizationManager: VadManagerLike | null;
  maxSpeakers: number;
  enabled: boolean;

  constructor() {
    this.session = null;
    this.running = false;
    this.queue = Promise.resolve();
    this.onSpeakerIdentified = null;
    this.getSpeakerProfiles = null;
    this.audioRemainder = new Float32Array(0);
    this.vadStateInputs = [];
    this.vadStateOutputs = [];
    this.vadStates = new Map();
    this.speechChunks = [];
    this.speechActive = false;
    this.silenceWindows = 0;
    this.sampleCursor = 0;
    this.segmentStartSample = 0;
    this.segmentEndSample = 0;
    this.transientEmbeddings = new Map();
    this.transientCounts = new Map();
    this.transientDisplayNames = new Map();
    this.transientProfileIds = new Map();
    this.transientNoteIds = new Map();
    this.nextLiveIndex = 0;
    this.currentSegmentSpeakerId = null;
    this.currentSegmentSpeakerName = null;
    this.lastLiveIdentificationSample = 0;
    this._diarizationManager = null;
    this.maxSpeakers = MAX_SPEAKER_COUNT;
    this.enabled = true;
  }

  setDiarizationManager(manager: VadManagerLike | null): void {
    this._diarizationManager = manager;
  }

  isAvailable(): boolean {
    return (
      this._diarizationManager?.isVadModelDownloaded() === true &&
      speakerEmbeddings.isAvailable() === true &&
      loadOnnxRuntime() !== null
    );
  }

  getTransientState(): Record<string, TransientSpeakerState> {
    const state: Record<string, TransientSpeakerState> = {};

    for (const [speakerId, embedding] of this.transientEmbeddings.entries()) {
      state[speakerId] = {
        embedding: Array.from(embedding),
        displayName: this.transientDisplayNames.get(speakerId) || null,
        profileId: this.transientProfileIds.get(speakerId) ?? null,
        noteId: this.transientNoteIds.get(speakerId) ?? null,
      };
    }

    return state;
  }

  getSpeakerEmbedding(speakerId: string): Float32Array | null {
    const embedding = this.transientEmbeddings.get(speakerId);
    return embedding ? cloneFloat32Array(embedding) : null;
  }

  async start(
    optionsOrCallback: StartOptions | ((event: IdentifiedSpeakerEvent) => void),
    extraOptions: Omit<StartOptions, "onSpeakerIdentified"> = {}
  ): Promise<boolean> {
    const resolvedOptions: StartOptions =
      typeof optionsOrCallback === "function"
        ? { onSpeakerIdentified: optionsOrCallback, ...extraOptions }
        : optionsOrCallback;
    const {
      onSpeakerIdentified = null,
      getSpeakerProfiles = null,
      maxSpeakers = MAX_SPEAKER_COUNT,
      enabled = true,
    } = resolvedOptions;

    this.onSpeakerIdentified =
      typeof onSpeakerIdentified === "function" ? onSpeakerIdentified : null;
    this.getSpeakerProfiles = typeof getSpeakerProfiles === "function" ? getSpeakerProfiles : null;
    this.maxSpeakers = clampMaxSpeakers(maxSpeakers);
    this.enabled = enabled !== false;
    this._resetMeetingState();

    if (!this.isAvailable()) {
      debugLogger.warn("Live speaker identifier unavailable", {
        vadModelPath: this._diarizationManager?.getVadModelPath(),
        embeddingModelAvailable: speakerEmbeddings.isAvailable(),
      });
      return false;
    }

    await this._ensureLoaded();
    this.running = !!this.session;
    return this.running;
  }

  async stop(): Promise<Record<string, TransientSpeakerState>> {
    this.running = false;
    await this.queue;

    if (this.speechActive && this.audioRemainder.length > 0) {
      this.speechChunks.push(this.audioRemainder);
      this.audioRemainder = new Float32Array(0);
    }

    if (this.speechActive) {
      await this._finalizeSpeechSegment();
    }

    const transientState = this.getTransientState();
    this._resetMeetingState();
    this.onSpeakerIdentified = null;
    this.getSpeakerProfiles = null;
    return transientState;
  }

  recluster(): Promise<SpeakerReclusterMerge[]> {
    return new Promise<SpeakerReclusterMerge[]>((resolve) => {
      this.queue = this.queue
        .then(() => resolve(this._performRecluster()))
        .catch(() => resolve([]));
    });
  }

  _performRecluster(): SpeakerReclusterMerge[] {
    const speakers = [...this.transientEmbeddings.entries()];
    if (speakers.length < 2) return [];

    const merges = [];
    const removed = new Set();

    for (let i = 0; i < speakers.length; i += 1) {
      if (removed.has(speakers[i][0])) continue;
      for (let j = i + 1; j < speakers.length; j += 1) {
        if (removed.has(speakers[j][0])) continue;

        const similarity = speakerEmbeddings.cosineSimilarity(speakers[i][1], speakers[j][1]);
        if (similarity < MATCH_THRESHOLD) continue;

        // Confirmed-distinct identities (different profiles, or different
        // user-set names) must never merge on embedding similarity alone.
        const profileI = this.transientProfileIds.get(speakers[i][0]);
        const profileJ = this.transientProfileIds.get(speakers[j][0]);
        if (profileI != null && profileJ != null && profileI !== profileJ) continue;
        const nameI = this.transientDisplayNames.get(speakers[i][0]);
        const nameJ = this.transientDisplayNames.get(speakers[j][0]);
        if (nameI && nameJ && nameI !== nameJ) continue;

        const countI = this.transientCounts.get(speakers[i][0]) || 1;
        const countJ = this.transientCounts.get(speakers[j][0]) || 1;
        const hasNameI = !!this.transientDisplayNames.get(speakers[i][0]);
        const hasNameJ = !!this.transientDisplayNames.get(speakers[j][0]);
        const keepFirst =
          hasNameI && !hasNameJ ? true : hasNameJ && !hasNameI ? false : countI >= countJ;
        const [keepId, removeId] = keepFirst
          ? [speakers[i][0], speakers[j][0]]
          : [speakers[j][0], speakers[i][0]];
        const keepCount = this.transientCounts.get(keepId) || 1;
        const removeCount = this.transientCounts.get(removeId) || 1;
        // Invariant: both ids are live map entries in this loop.
        const keepEmb = this.transientEmbeddings.get(keepId) as Float32Array;
        const removeEmb = this.transientEmbeddings.get(removeId) as Float32Array;
        const totalCount = keepCount + removeCount;

        const merged = new Float32Array(keepEmb.length);
        for (let k = 0; k < keepEmb.length; k += 1) {
          merged[k] = (keepEmb[k] * keepCount + removeEmb[k] * removeCount) / totalCount;
        }

        this.transientEmbeddings.set(keepId, merged);
        this.transientCounts.set(keepId, totalCount);
        this.transientEmbeddings.delete(removeId);
        this.transientCounts.delete(removeId);

        if (!this.transientDisplayNames.get(keepId) && this.transientDisplayNames.get(removeId)) {
          this.transientDisplayNames.set(keepId, this.transientDisplayNames.get(removeId) ?? null);
        }
        this.transientDisplayNames.delete(removeId);

        if (!this.transientProfileIds.get(keepId) && this.transientProfileIds.get(removeId)) {
          this.transientProfileIds.set(keepId, this.transientProfileIds.get(removeId) ?? null);
        }
        this.transientProfileIds.delete(removeId);

        if (!this.transientNoteIds.get(keepId) && this.transientNoteIds.get(removeId)) {
          this.transientNoteIds.set(keepId, this.transientNoteIds.get(removeId) ?? null);
        }
        this.transientNoteIds.delete(removeId);

        if (this.currentSegmentSpeakerId === removeId) {
          this.currentSegmentSpeakerId = keepId;
        }

        removed.add(removeId);
        merges.push({
          keep: keepId,
          remove: removeId,
          displayName: this.transientDisplayNames.get(keepId) || null,
          similarity,
        });

        debugLogger.info("Speaker recluster merge", {
          keep: keepId,
          remove: removeId,
          similarity: similarity.toFixed(3),
          keepCount,
          removeCount,
        });
      }
    }

    return merges;
  }

  feedAudio(pcmBuffer: Buffer): Promise<unknown> {
    if (!this.running || !pcmBuffer?.length) {
      return Promise.resolve();
    }

    this.queue = this.queue
      .then(() => this._processAudio(pcmBuffer))
      .catch((error: Error) => {
        debugLogger.warn("Live speaker identification failed", { error: error.message });
      });

    return this.queue;
  }

  setMaxSpeakers(n: number): void {
    this.maxSpeakers = clampMaxSpeakers(n);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled !== false;
  }

  mapSpeaker(
    liveId: string,
    profileId: number | null,
    displayName: string | null,
    noteId?: number | null
  ): boolean {
    if (!liveId || !this.transientEmbeddings.has(liveId)) {
      // Labeling a speaker in a past note routes here with no live session, so
      // only an active session losing a mapping is worth flagging.
      if (this.running) {
        debugLogger.warn("Live speaker mapping dropped: unknown speaker id", {
          liveId,
          hasDisplayName: !!displayName,
          knownSpeakers: [...this.transientEmbeddings.keys()],
        });
      }
      return false;
    }

    if (profileId != null) {
      this.transientProfileIds.set(liveId, profileId);
    }

    if (displayName) {
      this.transientDisplayNames.set(liveId, displayName);
    }

    if (noteId != null) {
      this.transientNoteIds.set(liveId, noteId);
    }

    return true;
  }

  async _ensureLoaded(): Promise<void> {
    if (this.session) return;

    const vadModelPath = this._diarizationManager?.getVadModelPath();
    if (!vadModelPath || !fs.existsSync(vadModelPath)) {
      return;
    }

    const ort = loadOnnxRuntime();
    if (!ort) return;

    this.session = await ort.InferenceSession.create(vadModelPath, VAD_SESSION_OPTIONS);
    this.vadStateInputs = (this.session.inputNames || []).filter((name) => /state|h|c/i.test(name));
    this.vadStateOutputs = (this.session.outputNames || []).filter((name) =>
      /state|h|c/i.test(name)
    );
    this._resetVadRuntimeState();
  }

  _resetMeetingState(): void {
    this.queue = Promise.resolve();
    this.audioRemainder = new Float32Array(0);
    this.speechChunks = [];
    this.speechActive = false;
    this.silenceWindows = 0;
    this.sampleCursor = 0;
    this.segmentStartSample = 0;
    this.segmentEndSample = 0;
    this.transientEmbeddings = new Map();
    this.transientCounts = new Map();
    this.transientDisplayNames = new Map();
    this.transientProfileIds = new Map();
    this.transientNoteIds = new Map();
    this.nextLiveIndex = 0;
    this.currentSegmentSpeakerId = null;
    this.currentSegmentSpeakerName = null;
    this.lastLiveIdentificationSample = 0;
    this._resetVadRuntimeState();
  }

  _resetVadRuntimeState(): void {
    this.vadStates = new Map();

    if (!this.session) {
      return;
    }

    for (const name of this.vadStateInputs) {
      const metadata = this.session.inputMetadata?.[name];
      const shape = normalizeVadShape(metadata?.dimensions || metadata?.shape);
      const size = shape.reduce((total, dim) => total * dim, 1);
      this.vadStates.set(name, new Float32Array(size));
    }
  }

  async _processAudio(pcmBuffer: Buffer): Promise<void> {
    await this._ensureLoaded();
    if (!this.session) return;

    const downsampled = downsample24kTo16k(
      Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer)
    );
    if (!downsampled.length) return;

    this.audioRemainder = appendFloat32(this.audioRemainder, pcm16ToFloat32(downsampled));

    while (this.audioRemainder.length >= VAD_WINDOW_SIZE) {
      const window = this.audioRemainder.subarray(0, VAD_WINDOW_SIZE);
      this.audioRemainder = this.audioRemainder.slice(VAD_WINDOW_SIZE);

      const windowStartSample = this.sampleCursor;
      this.sampleCursor += window.length;

      await this._processWindow(window, windowStartSample, this.sampleCursor);
    }
  }

  async _processWindow(window: Float32Array, windowStartSample: number, windowEndSample: number): Promise<void> {
    const probability = await this._getVadProbability(window);

    if (this.speechActive) {
      this.speechChunks.push(cloneFloat32Array(window));
      trimChunksToMaxSamples(this.speechChunks, SPEECH_CHUNKS_MAX_SAMPLES);
      this.segmentEndSample = windowEndSample;

      if (probability >= SILENCE_THRESHOLD) {
        this.silenceWindows = 0;
        await this._identifyActiveSpeechSegment();
        return;
      }

      this.silenceWindows += 1;
      if (this.silenceWindows >= SILENCE_WINDOWS_TO_END) {
        await this._finalizeSpeechSegment();
      }
      return;
    }

    if (probability < SPEECH_THRESHOLD) {
      return;
    }

    this.speechActive = true;
    this.segmentStartSample = windowStartSample;
    this.segmentEndSample = windowEndSample;
    this.speechChunks = [cloneFloat32Array(window)];
    this.silenceWindows = 0;
    this.currentSegmentSpeakerId = null;
    this.currentSegmentSpeakerName = null;
    this.lastLiveIdentificationSample = 0;
  }

  async _getVadProbability(window: Float32Array): Promise<number> {
    if (!this.session) return 0;

    const ort = loadOnnxRuntime();
    if (!ort) return 0;
    const feeds: Record<string, unknown> = {};
    const audioInputName = (this.session.inputNames || []).find(
      (name) => !this.vadStateInputs.includes(name) && !/sr|sample.?rate/i.test(name)
    );

    if (!audioInputName) {
      return 0;
    }

    feeds[audioInputName] = new ort.Tensor("float32", window, [1, window.length]);

    const sampleRateInputName = (this.session.inputNames || []).find((name) =>
      /sr|sample.?rate/i.test(name)
    );
    if (sampleRateInputName) {
      feeds[sampleRateInputName] = new ort.Tensor(
        "int64",
        BigInt64Array.from([BigInt(SAMPLE_RATE)]),
        [1]
      );
    }

    for (const stateName of this.vadStateInputs) {
      const metadata = this.session.inputMetadata?.[stateName];
      const shape = normalizeVadShape(metadata?.dimensions || metadata?.shape);
      const state =
        this.vadStates.get(stateName) || new Float32Array(shape.reduce((a, b) => a * b, 1));

      this.vadStates.set(stateName, state);
      feeds[stateName] = new ort.Tensor("float32", state, shape);
    }

    const results = await this.session.run(feeds);
    this._updateVadState(results);

    const outputName = (this.session.outputNames || []).find(
      (name) => !this.vadStateOutputs.includes(name)
    );
    const output = (outputName && results[outputName]) || Object.values(results)[0];
    const value = output?.data?.[0];
    return typeof value === "number" ? value : 0;
  }

  _updateVadState(results: Record<string, { data: ArrayLike<number> }> | null): void {
    if (!results) {
      return;
    }

    for (const inputName of this.vadStateInputs) {
      const expectedName = normalizeVadStateName(inputName);
      const matchingOutput = this.vadStateOutputs.find((outputName) =>
        normalizeVadStateName(outputName).startsWith(expectedName)
      );
      const output = (matchingOutput && results[matchingOutput]) || results[inputName];

      if (output?.data) {
        this.vadStates.set(inputName, new Float32Array(output.data));
      }
    }
  }

  async _identifyActiveSpeechSegment(force = false): Promise<void> {
    // Runs on every speech window (~31x/sec), so the cheap gates must come
    // first — concatenating up to 32s of float32 per window is ~64 MB/s of
    // wasted main-thread memcpy during continuous speech.
    if (totalSampleCount(this.speechChunks) < LIVE_IDENTIFICATION_MIN_SAMPLES) {
      return;
    }

    if (
      !force &&
      this.lastLiveIdentificationSample > 0 &&
      this.segmentEndSample - this.lastLiveIdentificationSample <
        LIVE_IDENTIFICATION_INTERVAL_SAMPLES
    ) {
      return;
    }

    const allSamples = concatFloat32Arrays(this.speechChunks);
    const currentSamples =
      allSamples.length > MAX_EMBEDDING_SAMPLES
        ? allSamples.subarray(allSamples.length - MAX_EMBEDDING_SAMPLES)
        : allSamples;

    const embedding = await speakerEmbeddings.extractEmbeddingFromSamples(currentSamples);
    if (!embedding) {
      return;
    }

    const resolved = this._resolveSpeakerForEmbedding(embedding, { updateCentroid: false });
    if (!resolved?.speakerId) {
      return;
    }

    this.currentSegmentSpeakerId = resolved.speakerId;
    this.currentSegmentSpeakerName = resolved.displayName || null;
    this.lastLiveIdentificationSample = this.segmentEndSample;

    if (!this.enabled) return;

    this.onSpeakerIdentified?.({
      speakerId: resolved.speakerId,
      displayName: resolved.displayName || null,
      startTime: Math.max(0, this.segmentStartSample / SAMPLE_RATE - LIVE_WINDOW_PADDING_SECONDS),
      endTime: this.segmentEndSample / SAMPLE_RATE + LIVE_WINDOW_PADDING_SECONDS,
    });
  }

  async _finalizeSpeechSegment(): Promise<void> {
    const samples = concatFloat32Arrays(this.speechChunks);
    this.speechChunks = [];
    this.speechActive = false;
    this.silenceWindows = 0;

    if (samples.length < MIN_SEGMENT_SAMPLES) {
      return;
    }

    const embedding = await speakerEmbeddings.extractEmbeddingFromSamples(
      selectBestEmbeddingWindow(samples)
    );
    if (!embedding) {
      return;
    }

    const resolved = this._resolveSpeakerForEmbedding(embedding, { updateCentroid: true });
    if (!resolved?.speakerId) {
      return;
    }

    const speakerId = resolved.speakerId;
    const displayName =
      resolved.displayName ||
      this.currentSegmentSpeakerName ||
      this.transientDisplayNames.get(speakerId) ||
      null;

    if (this.enabled) {
      this.onSpeakerIdentified?.({
        speakerId,
        displayName,
        startTime: Math.max(0, this.segmentStartSample / SAMPLE_RATE - LIVE_WINDOW_PADDING_SECONDS),
        endTime: this.segmentEndSample / SAMPLE_RATE + LIVE_WINDOW_PADDING_SECONDS,
      });
    }

    this.currentSegmentSpeakerId = null;
    this.currentSegmentSpeakerName = null;
    this.lastLiveIdentificationSample = 0;
  }

  _findTransientMatch(embedding: Float32Array): string | null {
    let bestSpeakerId = null;
    let bestSimilarity = 0;
    let secondBestSimilarity = 0;

    for (const [speakerId, centroid] of this.transientEmbeddings.entries()) {
      const similarity = speakerEmbeddings.cosineSimilarity(embedding, centroid);
      if (similarity > bestSimilarity) {
        secondBestSimilarity = bestSimilarity;
        bestSimilarity = similarity;
        bestSpeakerId = speakerId;
      } else if (similarity > secondBestSimilarity) {
        secondBestSimilarity = similarity;
      }
    }

    return bestSimilarity >= MATCH_THRESHOLD &&
      bestSimilarity - secondBestSimilarity >= MATCH_MARGIN
      ? bestSpeakerId
      : null;
  }

  _findStoredProfileMatch(embedding: Float32Array): SpeakerProfileLike | null {
    let profiles: SpeakerProfileLike[] = [];

    try {
      profiles = this.getSpeakerProfiles?.() || [];
    } catch (error) {
      debugLogger.debug("Live speaker profile lookup failed", { error: (error as Error).message });
      return null;
    }

    let bestProfile: SpeakerProfileLike | null = null;
    let bestSimilarity = 0;
    let secondBestSimilarity = 0;

    for (const profile of profiles) {
      if (!profile?.embedding) continue;

      const profileEmbedding =
        profile.embedding instanceof Float32Array
          ? profile.embedding
          : Array.isArray(profile.embedding)
            ? new Float32Array(profile.embedding)
            : getBufferFloat32View(profile.embedding);

      if (!profileEmbedding.length) continue;

      const similarity = speakerEmbeddings.cosineSimilarity(embedding, profileEmbedding);
      if (similarity > bestSimilarity) {
        secondBestSimilarity = bestSimilarity;
        bestSimilarity = similarity;
        bestProfile = profile;
      } else if (similarity > secondBestSimilarity) {
        secondBestSimilarity = similarity;
      }
    }

    return bestSimilarity >= MATCH_THRESHOLD &&
      bestSimilarity - secondBestSimilarity >= MATCH_MARGIN
      ? bestProfile
      : null;
  }

  _resolveSpeakerForEmbedding(
    embedding: Float32Array,
    options: { updateCentroid?: boolean } = {}
  ): { speakerId: string | null; displayName: string | null } {
    const { updateCentroid = false } = options;

    let speakerId: string | null = this.currentSegmentSpeakerId || this._findTransientMatch(embedding);
    let displayName = this.currentSegmentSpeakerName || null;

    if (speakerId) {
      if (updateCentroid) {
        this._updateCentroid(speakerId, embedding);
      }

      return {
        speakerId,
        displayName: displayName || this.transientDisplayNames.get(speakerId) || null,
      };
    }

    const matchedProfile = this._findStoredProfileMatch(embedding);
    if (matchedProfile) {
      speakerId = this._findTransientSpeakerForProfile(matchedProfile.id);
      let forced = false;
      if (!speakerId) {
        ({ speakerId, forced } = this._assignOrForceCluster(embedding));
      } else if (updateCentroid) {
        this._updateCentroid(speakerId, embedding);
      }

      // A forced at-cap fold lands on someone else's cluster — retagging it
      // with the overflow speaker's profile would erase the original identity
      // and keep capturing this voice via the profile lookup even after the
      // cap rises.
      if (forced) {
        return {
          speakerId,
          displayName: this.transientDisplayNames.get(speakerId) || null,
        };
      }

      this.transientProfileIds.set(speakerId, matchedProfile.id);
      this.transientDisplayNames.set(speakerId, matchedProfile.display_name);
      return {
        speakerId,
        displayName: matchedProfile.display_name,
      };
    }

    speakerId = this.currentSegmentSpeakerId;
    if (speakerId) {
      if (updateCentroid) {
        this._updateCentroid(speakerId, embedding);
      }
    } else {
      ({ speakerId } = this._assignOrForceCluster(embedding));
    }

    return {
      speakerId,
      displayName: this.transientDisplayNames.get(speakerId) || null,
    };
  }

  // Always yields a usable cluster id: at-cap overflow folds onto the nearest
  // existing cluster, and the under-cap path mints a fresh one.
  _assignOrForceCluster(embedding: Float32Array): { speakerId: string; forced: boolean } {
    if (this.transientEmbeddings.size >= this.maxSpeakers) {
      const nearest = this._findNearestTransient(embedding);
      if (nearest) {
        // Label only — never fold the embedding into the centroid. At-cap
        // overflow is usually a different voice, and a polluted centroid would
        // keep capturing it even after the cap rises (participants added
        // mid-meeting).
        return { speakerId: nearest, forced: true };
      }
    }
    return { speakerId: this._assignSpeakerId(embedding), forced: false };
  }

  _findNearestTransient(embedding: Float32Array): string | null {
    let bestSpeakerId = null;
    let bestSimilarity = -Infinity;
    for (const [speakerId, centroid] of this.transientEmbeddings.entries()) {
      const similarity = speakerEmbeddings.cosineSimilarity(embedding, centroid);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestSpeakerId = speakerId;
      }
    }
    return bestSpeakerId;
  }

  _findTransientSpeakerForProfile(profileId: number | null): string | null {
    for (const [speakerId, candidateProfileId] of this.transientProfileIds.entries()) {
      if (candidateProfileId === profileId) {
        return speakerId;
      }
    }

    return null;
  }

  // Cluster ids double as the transcript's speaker labels. Ids freed by a
  // recluster merge are never reused: durable state (note speaker mappings,
  // the renderer's name map) may still reference them, and a recycled id would
  // let a new voice inherit the previous person's identity.
  _assignSpeakerId(embedding: Float32Array): string {
    const speakerId = `speaker_${this.nextLiveIndex}`;
    this.nextLiveIndex += 1;
    this.transientEmbeddings.set(speakerId, cloneFloat32Array(embedding));
    this.transientCounts.set(speakerId, 1);
    return speakerId;
  }

  _updateCentroid(speakerId: string | null, embedding: Float32Array): void {
    if (!speakerId) return;
    const centroid = this.transientEmbeddings.get(speakerId);
    if (!centroid) {
      return;
    }

    const count = this.transientCounts.get(speakerId) || 1;
    const nextCentroid = new Float32Array(embedding.length);

    for (let i = 0; i < embedding.length; i += 1) {
      nextCentroid[i] = (centroid[i] * count + embedding[i]) / (count + 1);
    }

    this.transientEmbeddings.set(speakerId, nextCentroid);
    this.transientCounts.set(speakerId, count + 1);
  }
}

const instance = new LiveSpeakerIdentifier();
export default instance;
module.exports = instance;
module.exports.LiveSpeakerIdentifier = LiveSpeakerIdentifier;
