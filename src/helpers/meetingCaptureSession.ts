import { randomUUID } from "crypto";
import type {
  MeetingRecordingDto,
  MeetingRecordingEpochDto,
  MeetingIntentionalInterval,
  MeetingFrameAlignmentPoint,
  MeetingFrameAlignmentSegment,
  MeetingSource,
} from "../contracts/meetingRecording.js";
import { MEETING_ASR_GATE_MS } from "../contracts/meetingRecording.js";

const SAMPLE_RATE = 24_000;

const MAX_PACKET_FRAMES = SAMPLE_RATE / 10;

export interface MicIntent {
  manualMuted: boolean;
  platformMuted: boolean;
}

export interface MeetingCaptureDatabase {
  createMeetingRecording(
    noteId: number,
    input: { config: unknown; configError?: unknown },
    startedAt?: string,
    id?: string,
    groupId?: string
  ): MeetingRecordingDto;
  setMeetingRecordingMicIntentionallyEmpty(recordingId: string, intentionallyEmpty: boolean): void;
  createMeetingRecordingEpoch(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number,
    sourceGeneration: number,
    sourceStartFrame: number,
    timelineStartFrame?: number | null
  ): MeetingRecordingEpochDto;
  addMeetingRecordingEpochAlignment(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number,
    segment: MeetingFrameAlignmentSegment
  ): MeetingRecordingEpochDto;
  markMeetingRecordingEpochAlignmentUnknown(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number,
    errorCode: string
  ): void;
  updateMeetingRecordingEpochRecovery(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number,
    result: { frameCount: number; ignoredTrailingBytes: number; errorCode?: string | null }
  ): MeetingRecordingEpochDto;
  markMeetingRecordingFinalizing(recordingId: string): MeetingRecordingDto;
  finalizeMeetingRecording(
    recordingId: string,
    input: {
      captureState: "ready" | "incomplete";
      endedAt: string;
      processingNotBefore?: string;
      // Free-form pipeline metadata (captureEndFrame, mic intent, per-source
      // health); the manager parses it back via parseJsonObject.
      sourceMetadata?: {
        captureEndFrame?: number;
        monotonicOriginNs?: string | null;
        sourceGenerations?: Record<string, number>;
        mic?: { intentionallyEmpty?: boolean; errorCode?: string | null };
        system?: { intentionallyEmpty?: boolean; errorCode?: string | null };
      };
      errorCode?: string | null;
    }
  ): { recording: MeetingRecordingDto; initialRun: { id: string } };
  openMeetingIntentionalInterval(
    recordingId: string,
    source: MeetingSource,
    sourceGeneration: number,
    startFrame: number,
    reason: MeetingIntentionalInterval["reason"],
    alignment?: MeetingFrameAlignmentPoint | null
  ): MeetingIntentionalInterval;
  closeMeetingIntentionalInterval(
    recordingId: string,
    source: MeetingSource,
    sourceGeneration: number,
    endFrame: number,
    reason: MeetingIntentionalInterval["reason"],
    alignment?: MeetingFrameAlignmentPoint | null
  ): MeetingIntentionalInterval | null;
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
  closeEpochWriter(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number
  ): void | Promise<void>;
  recoverEpoch(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number
  ): { frameCount: number; ignoredTrailingBytes: number; errorCode: string | null };
}

export interface MeetingCapturePacket {
  epochIndex: number;
  epochSourceStartFrame: number;
  sourceFrameStart: number;
  sourceGeneration: number;
  sequence: number;
  sampleOffset: number;
  alignment: MeetingFrameAlignmentSegment | null;
  alignmentErrorCode: string;
}

interface CaptureEpoch {
  index: number;
  sourceStartFrame: number;
  sourceGeneration: number;
  timelineStartFrame: number | null;
  frameCount: number;
  nextSequence: number;
  opened: boolean;
}

export interface MeetingCaptureStopInput {
  lastSequence: Partial<Record<MeetingSource, number>>;
  microphoneBoundary?: {
    sourceGeneration: number;
    sourceFrame: number;
    alignment: MeetingFrameAlignmentPoint | null;
  };
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
  private micAlwaysMuted = false;
  private micPlatformMuted = false;
  private micSourceGeneration = 1;
  private micControlSequence = 0;
  private allowIntentionalMicEpoch = false;
  private micUnmuteBoundary: { sourceGeneration: number; frame: number } | null = null;
  private readonly sourceGenerations = new Map<MeetingSource, number>([
    ["mic", 1],
    ["system", 1],
  ]);
  private monotonicOriginNs: string | null = null;
  private micIntentQueue: Promise<void> = Promise.resolve();
  private stopPromise: Promise<MeetingCaptureStopResult> | null = null;
  private captureError: string | null = null;
  private readonly closingEpochs: Promise<void>[] = [];

  private constructor(
    private readonly database: MeetingCaptureDatabase,
    private readonly storage: MeetingCaptureEpochStorage,
    noteId: number,
    config: { config: unknown; configError?: unknown } | null,
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
    this.micAlwaysMuted = manualMicMuted;

    if (manualMicMuted) this.database.setMeetingRecordingMicIntentionallyEmpty(recordingId, true);

    if (manualMicMuted)
      this.database.openMeetingIntentionalInterval(recordingId, "mic", 1, 0, "manual-muted", null);
  }

  static create(
    database: MeetingCaptureDatabase,
    storage: MeetingCaptureEpochStorage,
    noteId: number,
    config: { config: unknown; configError?: unknown } | null,
    startedAt = new Date(),
    recordingId?: string,
    groupId?: string,
    manualMicMuted = false
  ): MeetingCaptureSession {
    return new MeetingCaptureSession(
      database,
      storage,
      noteId,
      config,
      startedAt,
      recordingId,
      groupId,
      manualMicMuted
    );
  }

  getMicIntent(): MicIntent {
    return { manualMuted: this.micManualMuted, platformMuted: this.micPlatformMuted };
  }

  initializePlatformMute(muted: boolean): void {
    if (this.epochs.size || this.micControlSequence || this.stopPromise)
      throw new Error("Capture already started");
    this.micPlatformMuted = muted;
    this.micAlwaysMuted = (this.micManualMuted || muted) && !this.sourceErrors.has("mic");
    this.database.setMeetingRecordingMicIntentionallyEmpty(this.recordingId, this.micAlwaysMuted);

    if (muted)
      this.database.openMeetingIntentionalInterval(
        this.recordingId,
        "mic",
        1,
        0,
        "platform-muted",
        null
      );
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
    const frame = (Number(delta) * SAMPLE_RATE) / 1e9;

    return Number.isSafeInteger(Math.round(frame)) && frame >= 0 ? Math.round(frame) : null;
  }

  private invalidateMicEmptyProof(): void {
    if (!this.micAlwaysMuted) return;
    this.database.setMeetingRecordingMicIntentionallyEmpty(this.recordingId, false);
    this.micAlwaysMuted = false;
  }

  private setSourceError(source: MeetingSource, errorCode: string): void {
    if (source === "mic") this.invalidateMicEmptyProof();
    this.sourceErrors.set(source, errorCode);
  }

  markSourceUnavailable(source: MeetingSource, errorCode: string): void {
    if (this.stopPromise) return;
    this.setSourceError(source, errorCode);
  }

  markCaptureFailure(errorCode: string): void {
    this.invalidateMicEmptyProof();
    this.captureError ??= errorCode;
  }

  async setMicIntent(input: {
    sequence: number;
    sourceGeneration: number;
    manualMuted: boolean;
    platformMuted: boolean;
    boundaryFrame: number;
    boundaryAlignment: MeetingFrameAlignmentPoint | null;
  }): Promise<{
    sequence: number;
    sourceGeneration: number;
    effectiveMuted: boolean;
    boundaryFrame: number;
  }> {
    if (this.stopPromise) throw new Error("Meeting capture is stopping");
    const operation = this.micIntentQueue.then(() => this.applyMicIntent(input));
    this.micIntentQueue = operation.then(
      async () => {
        try {
          await operation;
        } catch (error) {
          const message = error instanceof Error ? error.message : "";

          if (
            message !== "Stale microphone intent transition" &&
            message !== "Microphone intent boundary precedes captured audio"
          ) {
            this.invalidateMicEmptyProof();
            this.captureError ??= "mic-intent-transition-failed";
          }
        }
      },
      () => undefined
    );

    return operation;
  }

  private async applyMicIntent(input: {
    sequence: number;
    sourceGeneration: number;
    manualMuted: boolean;
    platformMuted: boolean;
    boundaryFrame: number;
    boundaryAlignment: MeetingFrameAlignmentPoint | null;
  }): Promise<{
    sequence: number;
    sourceGeneration: number;
    effectiveMuted: boolean;
    boundaryFrame: number;
  }> {
    if (
      input.sequence !== this.micControlSequence + 1 ||
      (input.sourceGeneration !== this.micSourceGeneration &&
        input.sourceGeneration !== this.micSourceGeneration + 1) ||
      !Number.isSafeInteger(input.boundaryFrame) ||
      input.boundaryFrame < 0
    ) {
      throw new Error("Stale microphone intent transition");
    }

    const previous = { manualMuted: this.micManualMuted, platformMuted: this.micPlatformMuted };
    const current = { manualMuted: input.manualMuted, platformMuted: input.platformMuted };
    const wasMuted = previous.manualMuted || previous.platformMuted;
    const isMuted = current.manualMuted || current.platformMuted;
    const epoch = this.epochs.get("mic");
    const generationChanged = input.sourceGeneration !== this.micSourceGeneration;

    const epochEnd =
      epoch && epoch.sourceGeneration === this.micSourceGeneration
        ? epoch.sourceStartFrame + epoch.frameCount
        : 0;

    if (!generationChanged && input.boundaryFrame < epochEnd)
      throw new Error("Microphone intent boundary precedes captured audio");

    if (!isMuted) this.invalidateMicEmptyProof();

    if (generationChanged) {
      if (epoch) {
        await this.closeEpoch("mic", epoch);
        this.setSourceError("mic", "source-restarted");
      }

      for (const [reason, active] of [
        ["manual-muted", previous.manualMuted],
        ["platform-muted", previous.platformMuted],
      ] as const) {
        if (!active) continue;
        // A reopened source has its own frame origin. Its boundary cannot close
        // the previous generation or prove alignment for that generation.
        this.database.closeMeetingIntentionalInterval(
          this.recordingId,
          "mic",
          this.micSourceGeneration,
          epochEnd,
          reason,
          null
        );
      }

      this.micSourceGeneration = input.sourceGeneration;
      this.sourceGenerations.set("mic", input.sourceGeneration);

      for (const [reason, active] of [
        ["manual-muted", current.manualMuted],
        ["platform-muted", current.platformMuted],
      ] as const) {
        if (active)
          this.database.openMeetingIntentionalInterval(
            this.recordingId,
            "mic",
            input.sourceGeneration,
            input.boundaryFrame,
            reason,
            input.boundaryAlignment
          );
      }

      this.allowIntentionalMicEpoch = isMuted;
    }

    if (!wasMuted && isMuted && this.micUnmuteBoundary !== null) {
      this.setSourceError("mic", "mic-source-unavailable");
      this.micUnmuteBoundary = null;
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

      if (generationChanged) continue;

      if (after) {
        this.database.openMeetingIntentionalInterval(
          this.recordingId,
          "mic",
          input.sourceGeneration,
          input.boundaryFrame,
          reason,
          input.boundaryAlignment
        );
      } else {
        this.database.closeMeetingIntentionalInterval(
          this.recordingId,
          "mic",
          input.sourceGeneration,
          input.boundaryFrame,
          reason,
          input.boundaryAlignment
        );
      }
    }

    if (wasMuted && !isMuted) {
      this.allowIntentionalMicEpoch = true;
      this.micUnmuteBoundary = {
        sourceGeneration: input.sourceGeneration,
        frame: input.boundaryFrame,
      };
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

  beginSourceEpoch(
    source: MeetingSource,
    sourceGeneration: number,
    sourceStartFrame: number,
    timelineStartFrame: number | null = null
  ): number {
    if (this.stopPromise) throw new Error("Meeting capture is stopping");
    const current = this.epochs.get(source);
    const index = current ? current.index + 1 : 0;
    const previousGeneration = this.sourceGenerations.get(source) ?? 1;

    const minimumStart =
      current && current.sourceGeneration === sourceGeneration
        ? current.sourceStartFrame + current.frameCount
        : 0;

    if (
      !Number.isSafeInteger(sourceGeneration) ||
      sourceGeneration < previousGeneration ||
      sourceGeneration > previousGeneration + 1 ||
      !Number.isSafeInteger(sourceStartFrame) ||
      sourceStartFrame < minimumStart ||
      (timelineStartFrame !== null &&
        (!Number.isSafeInteger(timelineStartFrame) || timelineStartFrame < 0))
    ) {
      throw new Error("Invalid meeting capture epoch offset");
    }

    if (current) {
      // Fire-and-forget close; closeEpoch already routes its own failures
      // into captureError, so the outer rejection cannot occur.
      this.closeEpoch(source, current).catch(() => undefined);
      this.setSourceError(source, "source-restarted");
    }

    this.sourceGenerations.set(source, sourceGeneration);
    this.openEpoch(source, index, sourceGeneration, sourceStartFrame, timelineStartFrame);

    return index;
  }

  appendRendererSamples(
    source: MeetingSource,
    packet: MeetingCapturePacket,
    samples: Buffer
  ): void {
    if (this.stopPromise) throw new Error("Meeting capture is stopping");

    if (
      source === "mic" &&
      (packet.sourceGeneration !== this.micSourceGeneration ||
        this.micManualMuted ||
        this.micPlatformMuted)
    ) {
      throw new Error("Microphone samples do not match the active intent generation");
    }

    try {
      if (samples.length === 0 || samples.length % 2 !== 0) {
        throw new Error("Invalid PCM16LE sample packet");
      }

      const frameCount = samples.length / 2;

      if (frameCount > MAX_PACKET_FRAMES) throw new Error("Meeting capture packet exceeds 100 ms");

      if (
        !Number.isSafeInteger(packet.sourceFrameStart) ||
        packet.sourceFrameStart < 0 ||
        !Number.isSafeInteger(packet.epochSourceStartFrame) ||
        packet.epochSourceStartFrame < 0 ||
        !Number.isSafeInteger(packet.sourceGeneration) ||
        packet.sourceGeneration < 1 ||
        !/^[a-z0-9-]{1,80}$/.test(packet.alignmentErrorCode)
      ) {
        throw new Error("Invalid source-frame capture metadata");
      }

      let epoch = this.epochs.get(source);

      if (!epoch || packet.epochIndex !== epoch.index) {
        const expectedIndex = epoch ? epoch.index + 1 : 0;

        if (packet.epochIndex !== expectedIndex)
          throw new Error("Unexpected meeting capture epoch");

        if (epoch) this.closeEpoch(source, epoch).catch(() => undefined);
        const sameGeneration = epoch?.sourceGeneration === packet.sourceGeneration;

        const minimumStart =
          sameGeneration && epoch ? epoch.sourceStartFrame + epoch.frameCount : 0;

        if (
          packet.epochSourceStartFrame !== packet.sourceFrameStart ||
          packet.sourceFrameStart < minimumStart ||
          packet.sourceGeneration < (this.sourceGenerations.get(source) ?? 1) ||
          packet.sourceGeneration > (this.sourceGenerations.get(source) ?? 1) + 1
        ) {
          throw new Error("Invalid source-frame epoch start");
        }

        if (source === "mic") {
          if (packet.sourceGeneration !== this.micSourceGeneration)
            throw new Error("Microphone packet has a stale source generation");

          if (epoch && !this.allowIntentionalMicEpoch)
            this.setSourceError(source, "source-restarted");
          this.allowIntentionalMicEpoch = false;
        } else if (epoch) this.setSourceError(source, "source-restarted");

        if (packet.sourceGeneration !== (this.sourceGenerations.get(source) ?? 1))
          this.sourceGenerations.set(source, packet.sourceGeneration);
        epoch = this.openEpoch(
          source,
          packet.epochIndex,
          packet.sourceGeneration,
          packet.sourceFrameStart,
          null
        );
      } else if (
        packet.epochSourceStartFrame !== epoch.sourceStartFrame ||
        packet.sourceGeneration !== epoch.sourceGeneration
      ) {
        throw new Error("Meeting capture epoch offset changed");
      }

      if (
        !Number.isSafeInteger(packet.sequence) ||
        packet.sequence !== epoch.nextSequence ||
        !Number.isSafeInteger(packet.sampleOffset) ||
        packet.sampleOffset !== epoch.frameCount ||
        packet.sourceFrameStart !== epoch.sourceStartFrame + epoch.frameCount
      ) {
        throw new Error("Meeting capture packet is out of order");
      }

      if (
        packet.alignment &&
        (packet.alignment.sourceGeneration !== packet.sourceGeneration ||
          packet.alignment.sourceStartFrame > packet.sourceFrameStart ||
          packet.alignment.sourceEndFrame < packet.sourceFrameStart + frameCount)
      )
        throw new Error("Audio alignment does not match its raw source frames");

      if (source === "mic" && this.micUnmuteBoundary !== null) {
        if (packet.sourceGeneration !== this.micUnmuteBoundary.sourceGeneration)
          throw new Error("Microphone samples use a stale unmute generation");

        if (packet.sourceFrameStart < this.micUnmuteBoundary.frame) {
          throw new Error("Microphone samples precede the acknowledged unmute boundary");
        }

        if (packet.sourceFrameStart > this.micUnmuteBoundary.frame) {
          this.setSourceError("mic", "mic-source-unavailable");
        }

        this.micUnmuteBoundary = null;
      }

      this.storage.appendEpochSamples(this.recordingId, source, epoch.index, samples);
      epoch.frameCount += frameCount;
      epoch.nextSequence += 1;

      try {
        if (packet.alignment)
          this.database.addMeetingRecordingEpochAlignment(
            this.recordingId,
            source,
            epoch.index,
            packet.alignment
          );
        else if (!this.mainOwnedSources.has(source))
          this.database.markMeetingRecordingEpochAlignmentUnknown(
            this.recordingId,
            source,
            epoch.index,
            packet.alignmentErrorCode
          );
      } catch {
        this.database.markMeetingRecordingEpochAlignmentUnknown(
          this.recordingId,
          source,
          epoch.index,
          "alignment-persistence-failed"
        );
      }
    } catch (error) {
      this.captureError ??= "audio-write-failed";
      this.setSourceError(source, "audio-write-failed");
      throw error;
    }
  }

  appendNativeSamples(
    source: MeetingSource,
    sourceGeneration: number,
    samples: Buffer,
    sourceFrameStart: number,
    timelineStartFrame: number
  ): void {
    if (this.stopPromise) return;
    this.mainOwnedSources.add(source);

    if (samples.length === 0 || samples.length % 2 !== 0) {
      this.markCaptureFailure("audio-write-failed");
      throw new Error("Invalid PCM16LE sample packet");
    }

    if (!Number.isSafeInteger(sourceFrameStart) || sourceFrameStart < 0)
      throw new Error("Invalid native source frame anchor");
    let epoch = this.epochs.get(source);

    if (
      !epoch ||
      epoch.sourceGeneration !== sourceGeneration ||
      sourceFrameStart !== epoch.sourceStartFrame + epoch.frameCount
    ) {
      const index = this.beginSourceEpoch(
        source,
        sourceGeneration,
        sourceFrameStart,
        timelineStartFrame
      );

      epoch = this.epochs.get(source);

      if (!epoch || epoch.index !== index) throw new Error("Meeting capture epoch was not opened");
    }

    try {
      const maxChunkBytes = MAX_PACKET_FRAMES * 2;

      for (let offset = 0; offset < samples.length; offset += maxChunkBytes) {
        const packet = {
          epochIndex: epoch.index,
          epochSourceStartFrame: epoch.sourceStartFrame,
          sourceFrameStart: epoch.sourceStartFrame + epoch.frameCount,
          sourceGeneration,
          sequence: epoch.nextSequence,
          sampleOffset: epoch.frameCount,
          alignment: null,
          alignmentErrorCode: "native-frame-anchor",
        };

        this.appendRendererSamples(
          source,
          packet,
          samples.subarray(offset, offset + maxChunkBytes)
        );
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

    for (const source of ["mic", "system"] as const) {
      if (source === "mic" && this.micUnmuteBoundary !== null) {
        this.setSourceError("mic", "mic-source-unavailable");
      }

      const epoch = this.epochs.get(source);
      const receivedLastSequence = input.lastSequence[source];

      if (
        epoch &&
        !this.mainOwnedSources.has(source) &&
        receivedLastSequence !== undefined &&
        receivedLastSequence !== epoch.nextSequence - 1
      ) {
        this.setSourceError(source, "capture-drain-incomplete");
      }

      if (!epoch || epoch.frameCount === 0) {
        const intervals = this.database
          .listMeetingIntentionalIntervals(this.recordingId)
          .filter((item) => item.source === source);

        const intentionallyCovered =
          source === "mic" &&
          (this.micManualMuted || this.micPlatformMuted) &&
          intervals.some(
            (item) =>
              item.sourceGeneration === this.micSourceGeneration &&
              item.sourceStartFrame === 0 &&
              item.sourceEndFrame === null
          );

        if (!intentionallyCovered)
          this.setSourceError(source, this.sourceErrors.get(source) ?? "source-unavailable");
      }

      if (epoch) {
        try {
          await this.closeEpoch(source, epoch);
        } catch {
          this.setSourceError(source, "audio-flush-failed");
        }

        try {
          const recovered = this.storage.recoverEpoch(this.recordingId, source, epoch.index);
          const epochError = this.sourceErrors.get(source) ?? recovered.errorCode;
          this.database.updateMeetingRecordingEpochRecovery(this.recordingId, source, epoch.index, {
            frameCount: recovered.frameCount,
            ignoredTrailingBytes: recovered.ignoredTrailingBytes,
            errorCode: epochError,
          });
        } catch {
          this.setSourceError(source, "audio-recovery-failed");
        }
      }
    }

    await Promise.all(this.closingEpochs);
    const micEpoch = this.epochs.get("mic");
    const boundary = input.microphoneBoundary;
    const boundaryGeneration = boundary?.sourceGeneration ?? this.micSourceGeneration;

    const boundaryFrame =
      boundary?.sourceFrame ??
      (micEpoch?.sourceGeneration === boundaryGeneration
        ? micEpoch.sourceStartFrame + micEpoch.frameCount
        : 0);

    for (const reason of ["manual-muted", "platform-muted"] as const) {
      this.database.closeMeetingIntentionalInterval(
        this.recordingId,
        "mic",
        boundaryGeneration,
        boundaryFrame,
        reason,
        boundary?.alignment ?? null
      );
    }

    errorCode ??= this.captureError;

    if (this.sourceErrors.size > 0) errorCode ??= this.sourceErrors.values().next().value ?? null;

    const captureEndFrame = Math.max(
      0,
      ...[...this.epochs.values()].map((epoch) =>
        epoch.timelineStartFrame === null ? 0 : epoch.timelineStartFrame + epoch.frameCount
      ),
      boundary?.alignment?.timelineFrame ?? 0
    );

    this.database.markMeetingRecordingFinalizing(this.recordingId);

    const result = this.database.finalizeMeetingRecording(this.recordingId, {
      captureState: errorCode || this.sourceErrors.size > 0 ? "incomplete" : "ready",
      endedAt:
        input.endedAt ??
        (this.captureError && captureEndFrame > 0
          ? new Date(Date.parse(this.originAt) + captureEndFrame / 24).toISOString()
          : new Date().toISOString()),
      processingNotBefore: new Date(Date.now() + MEETING_ASR_GATE_MS).toISOString(),
      sourceMetadata: {
        monotonicOriginNs: this.monotonicOriginNs,
        sourceGenerations: Object.fromEntries(this.sourceGenerations),
        captureEndFrame,
        mic: {
          errorCode: this.sourceErrors.get("mic") ?? null,
          intentionallyEmpty: this.micAlwaysMuted && !this.sourceErrors.has("mic"),
        },
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

  private openEpoch(
    source: MeetingSource,
    index: number,
    sourceGeneration: number,
    sourceStartFrame: number,
    timelineStartFrame: number | null
  ): CaptureEpoch {
    this.database.createMeetingRecordingEpoch(
      this.recordingId,
      source,
      index,
      sourceGeneration,
      sourceStartFrame,
      timelineStartFrame
    );
    this.storage.openEpochWriter(this.recordingId, source, index);

    const epoch = {
      index,
      sourceStartFrame,
      sourceGeneration,
      timelineStartFrame,
      frameCount: 0,
      nextSequence: 0,
      opened: true,
    };

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
        this.setSourceError(source, "audio-flush-failed");
      }

      try {
        const recovered = this.storage.recoverEpoch(this.recordingId, source, epoch.index);
        this.database.updateMeetingRecordingEpochRecovery(
          this.recordingId,
          source,
          epoch.index,
          recovered
        );

        if (recovered.errorCode) this.setSourceError(source, recovered.errorCode);
      } catch {
        this.captureError ??= "audio-recovery-failed";
        this.setSourceError(source, "audio-recovery-failed");
      }
    })();

    this.closingEpochs.push(closing);

    return closing;
  }
}
