import { randomUUID } from "crypto";
import type {
  MeetingRecordingDto,
  MeetingIntentionalInterval,
  MeetingSource,
} from "../contracts/meetingRecording.js";
import { MEETING_ASR_GATE_MS } from "../contracts/meetingRecording.js";

const SAMPLE_RATE = 24_000;
const MAX_PACKET_FRAMES = SAMPLE_RATE / 10;

export interface MeetingCaptureDatabase {
  createMeetingRecording(
    noteId: number,
    input: { config: unknown | null; configError?: unknown },
    startedAt?: string,
    id?: string,
    groupId?: string
  ): MeetingRecordingDto;
  createMeetingRecordingEpoch(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number,
    startFrame: number
  ): unknown;
  updateMeetingRecordingEpochRecovery(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number,
    result: { frameCount: number; ignoredTrailingBytes: number; errorCode?: string | null }
  ): unknown;
  markMeetingRecordingFinalizing(recordingId: string): unknown;
  finalizeMeetingRecording(
    recordingId: string,
    input: {
      captureState: "ready" | "incomplete";
      endedAt: string;
      processingNotBefore?: string;
      sourceMetadata?: Record<string, unknown>;
      errorCode?: string | null;
    }
  ): { recording: MeetingRecordingDto; initialRun: { id: string } };
  openMeetingIntentionalInterval(recordingId: string, source: MeetingSource, startFrame: number, reason: MeetingIntentionalInterval["reason"]): MeetingIntentionalInterval;
  closeMeetingIntentionalInterval(recordingId: string, source: MeetingSource, endFrame: number, reason: MeetingIntentionalInterval["reason"]): MeetingIntentionalInterval | null;
  listMeetingIntentionalIntervals(recordingId: string): MeetingIntentionalInterval[];
}

export interface MeetingCaptureEpochStorage {
  openEpochWriter(recordingId: string, source: MeetingSource, epochIndex: number): void;
  appendEpochSamples(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number,
    samples: Buffer
  ): void;
  closeEpochWriter(recordingId: string, source: MeetingSource, epochIndex: number): void | Promise<void>;
  recoverEpoch(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number
  ): { frameCount: number; ignoredTrailingBytes: number; errorCode: string | null };
}

export interface MeetingCapturePacket {
  epochIndex: number;
  epochStartFrame: number;
  frameStart: number;
  sourceGeneration: number;
  sequence: number;
  sampleOffset: number;
}

interface CaptureEpoch {
  index: number;
  startFrame: number;
  frameCount: number;
  nextSequence: number;
  opened: boolean;
}

export interface MeetingCaptureStopInput {
  lastSequence: Partial<Record<MeetingSource, number>>;
  endedAt?: string;
  errorCode?: string | null;
}

export interface MeetingCaptureStopResult {
  success: boolean;
  recordingId: string;
  captureState: "ready" | "incomplete";
  initialRunId: string;
  errorCode: string | null;
}

/** Main-process owner for one recording's ordered audio writes and finalization. */
export class MeetingCaptureSession {
  readonly recordingId: string;
  readonly groupId: string;
  readonly originAt: string;
  private readonly epochs = new Map<MeetingSource, CaptureEpoch>();
  private readonly sourceErrors = new Map<MeetingSource, string>();
  private readonly mainOwnedSources = new Set<MeetingSource>();
  private micManualMuted = false;
  private micPlatformMuted = false;
  private micSourceGeneration = 1;
  private micControlSequence = 0;
  private allowIntentionalMicEpoch = false;
  private micUnmuteBoundaryFrame: number | null = null;
  private monotonicOriginNs: string | null = null;
  private micIntentQueue: Promise<void> = Promise.resolve();
  private stopPromise: Promise<MeetingCaptureStopResult> | null = null;
  private captureError: string | null = null;
  private readonly closingEpochs: Promise<void>[] = [];

  private constructor(
    private readonly database: MeetingCaptureDatabase,
    private readonly storage: MeetingCaptureEpochStorage,
    noteId: number,
    config: { config: unknown | null; configError?: unknown } | null,
    startedAt: Date,
    recordingId: string = randomUUID(),
    groupId: string = recordingId,
    manualMicMuted = false
  ) {
    this.recordingId = recordingId;
    this.groupId = groupId;
    this.originAt = startedAt.toISOString();
    this.database.createMeetingRecording(
      noteId,
      config ?? { config: null, configError: { code: "missing-config" } },
      this.originAt,
      recordingId,
      groupId
    );
    this.micManualMuted = manualMicMuted;
    if (manualMicMuted) this.database.openMeetingIntentionalInterval(recordingId, "mic", 0, "manual-muted");
  }

  static create(
    database: MeetingCaptureDatabase,
    storage: MeetingCaptureEpochStorage,
    noteId: number,
    config: { config: unknown | null; configError?: unknown } | null,
    startedAt = new Date(),
    recordingId?: string,
    groupId?: string,
    manualMicMuted = false
  ): MeetingCaptureSession {
    return new MeetingCaptureSession(database, storage, noteId, config, startedAt, recordingId, groupId, manualMicMuted);
  }

  get isStopping(): boolean {
    return this.stopPromise !== null;
  }

  getErrorCode(): string | null {
    return this.captureError;
  }

  getMonotonicOriginNs(): string | null {
    return this.monotonicOriginNs;
  }

  setMonotonicOriginNs(value: string): void {
    if (!/^\d{1,20}$/.test(value) || this.monotonicOriginNs !== null) {
      throw new Error("Invalid or repeated meeting clock origin");
    }
    this.monotonicOriginNs = value;
  }

  frameForMonotonicNs(value: string): number | null {
    if (!this.monotonicOriginNs || !/^\d{1,20}$/.test(value)) return null;
    const delta = BigInt(value) - BigInt(this.monotonicOriginNs);
    const frame = Number(delta) * SAMPLE_RATE / 1e9;
    return Number.isSafeInteger(Math.round(frame)) && frame >= 0 ? Math.round(frame) : null;
  }

  markSourceUnavailable(source: MeetingSource, errorCode: string): void {
    if (this.stopPromise) return;
    this.sourceErrors.set(source, errorCode);
  }

  markCaptureFailure(errorCode: string): void {
    this.captureError ??= errorCode;
  }

  async setMicIntent(input: {
    sequence: number;
    sourceGeneration: number;
    manualMuted: boolean;
    platformMuted: boolean;
    boundaryFrame: number;
  }): Promise<{ sequence: number; sourceGeneration: number; effectiveMuted: boolean; boundaryFrame: number }> {
    if (this.stopPromise) throw new Error("Meeting capture is stopping");
    const operation = this.micIntentQueue.then(() => this.applyMicIntent(input));
    this.micIntentQueue = operation.then(() => undefined, (error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      if (message !== "Stale microphone intent transition" &&
          message !== "Microphone intent boundary precedes captured audio") {
        this.captureError ??= "mic-intent-transition-failed";
      }
    });
    return operation;
  }

  private async applyMicIntent(input: {
    sequence: number;
    sourceGeneration: number;
    manualMuted: boolean;
    platformMuted: boolean;
    boundaryFrame: number;
  }): Promise<{ sequence: number; sourceGeneration: number; effectiveMuted: boolean; boundaryFrame: number }> {
    if (input.sequence !== this.micControlSequence + 1 ||
        (input.sourceGeneration !== this.micSourceGeneration && input.sourceGeneration !== this.micSourceGeneration + 1) ||
        !Number.isSafeInteger(input.boundaryFrame) || input.boundaryFrame < 0) {
      throw new Error("Stale microphone intent transition");
    }
    const previous = { manualMuted: this.micManualMuted, platformMuted: this.micPlatformMuted };
    const current = { manualMuted: input.manualMuted, platformMuted: input.platformMuted };
    const wasMuted = previous.manualMuted || previous.platformMuted;
    const isMuted = current.manualMuted || current.platformMuted;
    const epoch = this.epochs.get("mic");
    const epochEnd = epoch ? epoch.startFrame + epoch.frameCount : 0;
    if (input.boundaryFrame < epochEnd) throw new Error("Microphone intent boundary precedes captured audio");

    if (input.sourceGeneration !== this.micSourceGeneration) {
      if (epoch) this.sourceErrors.set("mic", "source-restarted");
      this.micSourceGeneration = input.sourceGeneration;
    }
    if (!wasMuted && isMuted && this.micUnmuteBoundaryFrame !== null) {
      this.sourceErrors.set("mic", "mic-source-unavailable");
      this.micUnmuteBoundaryFrame = null;
    }
    if (wasMuted !== isMuted && isMuted && epoch) {
      await this.closeEpoch("mic", epoch);
      this.allowIntentionalMicEpoch = true;
    }
    for (const [reason, before, after] of [
      ["manual-muted", previous.manualMuted, current.manualMuted],
      ["platform-muted", previous.platformMuted, current.platformMuted],
    ] as const) {
      if (before === after) continue;
      if (after) {
        this.database.openMeetingIntentionalInterval(this.recordingId, "mic", input.boundaryFrame, reason);
      } else {
        this.database.closeMeetingIntentionalInterval(this.recordingId, "mic", input.boundaryFrame, reason);
      }
    }
    if (wasMuted && !isMuted) {
      this.allowIntentionalMicEpoch = true;
      this.micUnmuteBoundaryFrame = input.boundaryFrame;
    }
    this.micManualMuted = current.manualMuted;
    this.micPlatformMuted = current.platformMuted;
    this.micControlSequence = input.sequence;
    return {
      sequence: input.sequence,
      sourceGeneration: input.sourceGeneration,
      effectiveMuted: isMuted,
      boundaryFrame: input.boundaryFrame,
    };
  }

  beginSourceEpoch(source: MeetingSource, startFrame: number): number {
    if (this.stopPromise) throw new Error("Meeting capture is stopping");
    const current = this.epochs.get(source);
    const index = current ? current.index + 1 : 0;
    const minimumStart = current ? current.startFrame + current.frameCount : 0;
    if (!Number.isSafeInteger(startFrame) || startFrame < minimumStart) {
      throw new Error("Invalid meeting capture epoch offset");
    }
    if (current) {
      this.closeEpoch(source, current);
      this.sourceErrors.set(source, "source-restarted");
    }
    this.openEpoch(source, index, startFrame);
    return index;
  }

  appendRendererSamples(source: MeetingSource, packet: MeetingCapturePacket, samples: Buffer): void {
    if (this.stopPromise) throw new Error("Meeting capture is stopping");
    if (source === "mic" && (
      packet.sourceGeneration !== this.micSourceGeneration || this.micManualMuted || this.micPlatformMuted
    )) {
      throw new Error("Microphone samples do not match the active intent generation");
    }
    try {
      if (samples.length === 0 || samples.length % 2 !== 0) {
        throw new Error("Invalid PCM16LE sample packet");
      }
      const frameCount = samples.length / 2;
      if (frameCount > MAX_PACKET_FRAMES) throw new Error("Meeting capture packet exceeds 100 ms");

      let epoch = this.epochs.get(source);
      if (!epoch || packet.epochIndex !== epoch.index) {
        const expectedIndex = epoch ? epoch.index + 1 : 0;
        if (packet.epochIndex !== expectedIndex) throw new Error("Unexpected meeting capture epoch");
        if (epoch) this.closeEpoch(source, epoch);
        const nextStart = packet.epochStartFrame;
        const minimumStart = epoch ? epoch.startFrame + epoch.frameCount : 0;
        if (!Number.isSafeInteger(nextStart) || nextStart < minimumStart || packet.frameStart !== nextStart) {
          throw new Error("Invalid meeting capture epoch offset");
        }
        if (source === "mic") {
          if (epoch && !this.allowIntentionalMicEpoch) this.sourceErrors.set(source, "source-restarted");
          this.allowIntentionalMicEpoch = false;
        } else if (epoch) this.sourceErrors.set(source, "source-restarted");
        epoch = this.openEpoch(source, packet.epochIndex, nextStart);
      } else if (packet.epochStartFrame !== epoch.startFrame) {
        throw new Error("Meeting capture epoch offset changed");
      }

      if (
        !Number.isSafeInteger(packet.sequence) ||
        packet.sequence !== epoch.nextSequence ||
        !Number.isSafeInteger(packet.sampleOffset) ||
        packet.sampleOffset !== epoch.frameCount ||
        !Number.isSafeInteger(packet.frameStart) ||
        packet.frameStart !== epoch.startFrame + epoch.frameCount
      ) {
        throw new Error("Meeting capture packet is out of order");
      }
      if (source === "mic" && this.micUnmuteBoundaryFrame !== null) {
        if (packet.frameStart < this.micUnmuteBoundaryFrame) {
          throw new Error("Microphone samples precede the acknowledged unmute boundary");
        }
        if (packet.frameStart > this.micUnmuteBoundaryFrame) {
          this.sourceErrors.set("mic", "mic-source-unavailable");
        }
        this.micUnmuteBoundaryFrame = null;
      }
      this.storage.appendEpochSamples(this.recordingId, source, epoch.index, samples);
      epoch.frameCount += frameCount;
      epoch.nextSequence += 1;
    } catch (error) {
      this.captureError ??= "audio-write-failed";
      this.sourceErrors.set(source, "audio-write-failed");
      throw error;
    }
  }

  appendNativeSamples(source: MeetingSource, samples: Buffer, frameStart: number): void {
    if (this.stopPromise) return;
    this.mainOwnedSources.add(source);
    if (samples.length === 0 || samples.length % 2 !== 0) {
      this.markCaptureFailure("audio-write-failed");
      throw new Error("Invalid PCM16LE sample packet");
    }
    if (!Number.isSafeInteger(frameStart) || frameStart < 0) throw new Error("Invalid native audio frame anchor");
    let epoch = this.epochs.get(source);
    if (!epoch) {
      const index = this.beginSourceEpoch(source, frameStart);
      epoch = this.epochs.get(source);
      if (!epoch || epoch.index !== index) throw new Error("Meeting capture epoch was not opened");
    } else if (frameStart !== epoch.startFrame + epoch.frameCount) {
      this.beginSourceEpoch(source, frameStart);
      epoch = this.epochs.get(source);
      if (!epoch) throw new Error("Meeting capture epoch was not opened");
    }
    try {
      const maxChunkBytes = MAX_PACKET_FRAMES * 2;
      for (let offset = 0; offset < samples.length; offset += maxChunkBytes) {
        const packet = {
          epochIndex: epoch.index,
          epochStartFrame: epoch.startFrame,
          frameStart: epoch.startFrame + epoch.frameCount,
          sourceGeneration: 1,
          sequence: epoch.nextSequence,
          sampleOffset: epoch.frameCount,
        };
        this.appendRendererSamples(source, packet, samples.subarray(offset, offset + maxChunkBytes));
      }
    } catch (error) {
      this.markCaptureFailure("audio-write-failed");
      throw error;
    }
  }

  async stop(input: MeetingCaptureStopInput): Promise<MeetingCaptureStopResult> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.micIntentQueue.then(() => this.finish(input));
    return this.stopPromise;
  }

  private async finish(input: MeetingCaptureStopInput): Promise<MeetingCaptureStopResult> {
    let errorCode = this.captureError ?? input.errorCode ?? null;
    let latestSavedFrame = 0;
    for (const source of ["mic", "system"] as const) {
      if (source === "mic" && this.micUnmuteBoundaryFrame !== null) {
        this.sourceErrors.set("mic", "mic-source-unavailable");
      }
      const epoch = this.epochs.get(source);
      const receivedLastSequence = input.lastSequence[source];
      if (
        epoch &&
        !this.mainOwnedSources.has(source) &&
        receivedLastSequence !== undefined &&
        receivedLastSequence !== epoch.nextSequence - 1
      ) {
        this.sourceErrors.set(source, "capture-drain-incomplete");
      }
      if (!epoch || epoch.frameCount === 0) {
        const intervals = this.database.listMeetingIntentionalIntervals(this.recordingId).filter((item) => item.source === source);
        const intentionallyCovered = source === "mic" && (this.micManualMuted || this.micPlatformMuted) &&
          intervals.some((item) => item.startFrame === 0 && item.endFrame === null);
        if (!intentionallyCovered) this.sourceErrors.set(source, this.sourceErrors.get(source) ?? "source-unavailable");
      }
      if (epoch) {
        try {
          await this.closeEpoch(source, epoch);
        } catch {
          this.sourceErrors.set(source, "audio-flush-failed");
        }
        try {
          const recovered = this.storage.recoverEpoch(this.recordingId, source, epoch.index);
          latestSavedFrame = Math.max(latestSavedFrame, epoch.startFrame + recovered.frameCount);
          const epochError = this.sourceErrors.get(source) ?? recovered.errorCode;
          this.database.updateMeetingRecordingEpochRecovery(this.recordingId, source, epoch.index, {
            frameCount: recovered.frameCount,
            ignoredTrailingBytes: recovered.ignoredTrailingBytes,
            errorCode: epochError,
          });
        } catch {
          this.sourceErrors.set(source, "audio-recovery-failed");
        }
      }
    }

    await Promise.all(this.closingEpochs);
    latestSavedFrame = Math.max(latestSavedFrame, ...this.database.listMeetingIntentionalIntervals(this.recordingId)
      .map((interval) => interval.endFrame ?? interval.startFrame));
    for (const reason of ["manual-muted", "platform-muted"] as const) {
      this.database.closeMeetingIntentionalInterval(this.recordingId, "mic", latestSavedFrame, reason);
    }
    const captureEndFrame = Math.max(latestSavedFrame, ...this.database.listMeetingIntentionalIntervals(this.recordingId)
      .map((interval) => interval.endFrame ?? interval.startFrame));
    errorCode ??= this.captureError;
    if (this.sourceErrors.size > 0) errorCode ??= this.sourceErrors.values().next().value ?? null;
    this.database.markMeetingRecordingFinalizing(this.recordingId);
    const result = this.database.finalizeMeetingRecording(this.recordingId, {
      captureState: errorCode || this.sourceErrors.size > 0 ? "incomplete" : "ready",
      endedAt: input.endedAt ?? (latestSavedFrame > 0
        ? new Date(Date.parse(this.originAt) + latestSavedFrame / SAMPLE_RATE * 1000).toISOString()
        : new Date().toISOString()),
      processingNotBefore: new Date(Date.now() + MEETING_ASR_GATE_MS).toISOString(),
      sourceMetadata: {
        captureEndFrame,
        monotonicOriginNs: this.monotonicOriginNs,
        mic: { errorCode: this.sourceErrors.get("mic") ?? null },
        system: { errorCode: this.sourceErrors.get("system") ?? null },
      },
      errorCode,
    });
    return {
      success: true,
      recordingId: this.recordingId,
      captureState: result.recording.captureState === "ready" ? "ready" : "incomplete",
      initialRunId: result.initialRun.id,
      errorCode: result.recording.captureErrorCode,
    };
  }

  private openEpoch(source: MeetingSource, index: number, startFrame: number): CaptureEpoch {
    this.database.createMeetingRecordingEpoch(this.recordingId, source, index, startFrame);
    this.storage.openEpochWriter(this.recordingId, source, index);
    const epoch = { index, startFrame, frameCount: 0, nextSequence: 0, opened: true };
    this.epochs.set(source, epoch);
    return epoch;
  }

  private closeEpoch(source: MeetingSource, epoch: CaptureEpoch): Promise<void> {
    if (!epoch.opened) return Promise.resolve();
    epoch.opened = false;
    const closing = (async () => {
      try {
        await this.storage.closeEpochWriter(this.recordingId, source, epoch.index);
      } catch {
        this.captureError ??= "audio-flush-failed";
        this.sourceErrors.set(source, "audio-flush-failed");
      }
      try {
        const recovered = this.storage.recoverEpoch(this.recordingId, source, epoch.index);
        this.database.updateMeetingRecordingEpochRecovery(this.recordingId, source, epoch.index, recovered);
        if (recovered.errorCode) this.sourceErrors.set(source, recovered.errorCode);
      } catch {
        this.captureError ??= "audio-recovery-failed";
        this.sourceErrors.set(source, "audio-recovery-failed");
      }
    })();
    this.closingEpochs.push(closing);
    return closing;
  }

}
