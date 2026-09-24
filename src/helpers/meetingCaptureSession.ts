import { randomUUID } from "crypto";
import type {
  MeetingRecordingDto,
  MeetingSource,
} from "../contracts/meetingRecording.js";

const SAMPLE_RATE = 24_000;
const MAX_PACKET_FRAMES = SAMPLE_RATE / 10;

export interface MeetingCaptureDatabase {
  createMeetingRecording(
    noteId: number,
    input: { config: unknown | null; configError?: unknown },
    startedAt?: string,
    id?: string
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
    result: { frameCount: number; ignoredTrailingBytes: 0 | 1; errorCode?: string | null }
  ): unknown;
  markMeetingRecordingFinalizing(recordingId: string): unknown;
  finalizeMeetingRecording(
    recordingId: string,
    input: {
      captureState: "ready" | "incomplete";
      endedAt: string;
      sourceMetadata?: Record<string, unknown>;
      errorCode?: string | null;
    }
  ): { recording: MeetingRecordingDto; initialRun: { id: string } };
}

export interface MeetingCaptureEpochStorage {
  openEpochWriter(recordingId: string, source: MeetingSource, epochIndex: number): void;
  appendEpochSamples(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number,
    samples: Buffer
  ): void;
  closeEpochWriter(recordingId: string, source: MeetingSource, epochIndex: number): void;
  recoverEpoch(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number
  ): { frameCount: number; ignoredTrailingBytes: 0 | 1; errorCode: string | null };
}

export interface MeetingCapturePacket {
  epochIndex: number;
  epochStartFrame: number;
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

/** Main-process owner for one recording's ordered raw PCM writes and finalization. */
export class MeetingCaptureSession {
  readonly recordingId: string;
  readonly originAt: string;
  private readonly epochs = new Map<MeetingSource, CaptureEpoch>();
  private readonly sourceErrors = new Map<MeetingSource, string>();
  private readonly mainOwnedSources = new Set<MeetingSource>();
  private stopPromise: Promise<MeetingCaptureStopResult> | null = null;
  private captureError: string | null = null;

  private constructor(
    private readonly database: MeetingCaptureDatabase,
    private readonly storage: MeetingCaptureEpochStorage,
    noteId: number,
    config: { config: unknown | null; configError?: unknown } | null,
    startedAt: Date,
    recordingId: string = randomUUID()
  ) {
    this.recordingId = recordingId;
    this.originAt = startedAt.toISOString();
    this.database.createMeetingRecording(
      noteId,
      config ?? { config: null, configError: { code: "missing-config" } },
      this.originAt,
      recordingId
    );
  }

  static create(
    database: MeetingCaptureDatabase,
    storage: MeetingCaptureEpochStorage,
    noteId: number,
    config: { config: unknown | null; configError?: unknown } | null,
    startedAt = new Date(),
    recordingId?: string
  ): MeetingCaptureSession {
    return new MeetingCaptureSession(database, storage, noteId, config, startedAt, recordingId);
  }

  get isStopping(): boolean {
    return this.stopPromise !== null;
  }

  getErrorCode(): string | null {
    return this.captureError;
  }

  markSourceUnavailable(source: MeetingSource, errorCode: string): void {
    if (this.stopPromise) return;
    this.sourceErrors.set(source, errorCode);
  }

  markCaptureFailure(errorCode: string): void {
    this.captureError ??= errorCode;
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
        if (!Number.isSafeInteger(nextStart) || nextStart < minimumStart) {
          throw new Error("Invalid meeting capture epoch offset");
        }
        if (epoch) this.sourceErrors.set(source, "source-restarted");
        epoch = this.openEpoch(source, packet.epochIndex, nextStart);
      } else if (packet.epochStartFrame !== epoch.startFrame) {
        throw new Error("Meeting capture epoch offset changed");
      }

      if (
        !Number.isSafeInteger(packet.sequence) ||
        packet.sequence !== epoch.nextSequence ||
        !Number.isSafeInteger(packet.sampleOffset) ||
        packet.sampleOffset !== epoch.frameCount
      ) {
        throw new Error("Meeting capture packet is out of order");
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

  appendNativeSamples(source: MeetingSource, samples: Buffer, startedAt = new Date()): void {
    if (this.stopPromise) return;
    this.mainOwnedSources.add(source);
    if (samples.length === 0 || samples.length % 2 !== 0) {
      this.markCaptureFailure("audio-write-failed");
      throw new Error("Invalid PCM16LE sample packet");
    }
    let epoch = this.epochs.get(source);
    if (!epoch) {
      const index = this.beginSourceEpoch(source, this.toFrame(startedAt));
      epoch = this.epochs.get(source);
      if (!epoch || epoch.index !== index) throw new Error("Meeting capture epoch was not opened");
    }
    try {
      const maxChunkBytes = MAX_PACKET_FRAMES * 2;
      for (let offset = 0; offset < samples.length; offset += maxChunkBytes) {
        const packet = {
          epochIndex: epoch.index,
          epochStartFrame: epoch.startFrame,
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
    this.stopPromise = this.finish(input);
    return this.stopPromise;
  }

  private async finish(input: MeetingCaptureStopInput): Promise<MeetingCaptureStopResult> {
    let errorCode = this.captureError ?? input.errorCode ?? null;
    for (const source of ["mic", "system"] as const) {
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
        this.sourceErrors.set(source, this.sourceErrors.get(source) ?? "source-unavailable");
      }
      if (epoch) {
        try {
          this.closeEpoch(source, epoch);
        } catch {
          this.sourceErrors.set(source, "audio-flush-failed");
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
          this.sourceErrors.set(source, "audio-recovery-failed");
        }
      }
    }

    if (this.sourceErrors.size > 0) errorCode ??= this.sourceErrors.values().next().value ?? null;
    this.database.markMeetingRecordingFinalizing(this.recordingId);
    const result = this.database.finalizeMeetingRecording(this.recordingId, {
      captureState: errorCode || this.sourceErrors.size > 0 ? "incomplete" : "ready",
      endedAt: input.endedAt ?? new Date().toISOString(),
      sourceMetadata: {
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

  private closeEpoch(source: MeetingSource, epoch: CaptureEpoch): void {
    if (!epoch.opened) return;
    this.storage.closeEpochWriter(this.recordingId, source, epoch.index);
    epoch.opened = false;
  }

  private toFrame(at: Date): number {
    return Math.max(0, Math.round((at.getTime() - Date.parse(this.originAt)) * SAMPLE_RATE / 1000));
  }
}
