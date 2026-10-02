import { create } from "zustand";
import { getSettings, useSettingsStore } from "./settingsStore";
import { snapshotMeetingRecordingConfig } from "../helpers/meetingRecordingConfigSnapshot";
import {
  MeetingCaptureWriteQueue,
  MAX_UNACKNOWLEDGED_CAPTURE_FRAMES,
  MAX_CAPTURE_ACK_AGE_MS,
} from "../helpers/meetingCaptureWriteQueue";
import { followsSystemDefaultMic } from "../helpers/micSelectionRecovery";
import { resolvePreferredMicrophone } from "../helpers/microphoneSelection";
import { ActiveMicRecoveryController } from "../helpers/activeMicRecovery";
import { MeetingClockSync } from "../helpers/meetingClockSync";
import type { MeetingPlatform, MeetingFrameAlignmentPoint, MeetingFrameAlignmentSegment } from "../contracts/meetingRecording";
import {
  resolveInitialSpeakerCountOverride,
  resolveParticipantSpeakerCountSync,
} from "../utils/participants";
import type {
  SystemAudioAccessResult,
  SystemAudioStrategy,
} from "../types/electron";
import type { MeetingSystemAudioInterruption } from "../contracts/meetingCoordinator";
import type { NoteItem } from "../contracts/notes";
import type { CalendarAttendee } from "../contracts/calendar";
import {
  DEFAULT_SYSTEM_AUDIO_ACCESS,
  getDisplayCaptureModeForStrategy,
  getFallbackSystemAudioAccess,
  isRendererSystemAudioStrategy,
} from "../utils/systemAudioAccess";
import {
  DEFAULT_EXPECTED_SPEAKER_COUNT,
  MAX_SPEAKER_COUNT,
} from "../constants/speakerDetection.json";
import logger from "../utils/logger";
import {
  lockTranscriptSpeaker,
  mergeTranscriptSegments,
  serializeTranscriptSegments,
  type TranscriptSpeakerLockSource,
  type TranscriptSpeakerStatus,
} from "../utils/transcriptSpeakerState";
import { parseTranscriptSegments } from "../utils/parseTranscriptSegments";
import { resolveDiarizationTarget, selectBaseSegments } from "../utils/diarizationCompletion";
import { createSerialQueue } from "../utils/serialQueue";
import {
  canStopMeetingRecordingSession,
  createMeetingRecordingStartCoordinator,
  createMeetingRecordingStopBarrier,
  createMeetingRecordingSessionId,
  teardownFailedMeetingRecordingSetup,
} from "../helpers/meetingRecordingSession";

export interface TranscriptSegment {
  id: string;
  text: string;
  source?: "mic" | "system";
  timestamp?: number;
  endTimestamp?: number;
  speaker?: string;
  speakerName?: string;
  speakerIsPlaceholder?: boolean;
  suggestedName?: string;
  suggestedProfileId?: number;
  speakerStatus?: TranscriptSpeakerStatus;
  speakerLocked?: boolean;
  speakerLockSource?: TranscriptSpeakerLockSource;
  speakerPlatform?: MeetingPlatform;
}

export const SIDE_PANEL_BREAKPOINT_PX = 1024;

interface MeetingRecordingState {
  isRecording: boolean;
  isTranscribing: boolean;
  capturePhase: "idle" | "preparing" | "recording" | "paused" | "saving" | "saved" | "incomplete" | "failed";
  recordingId: string | null;
  meetingGroupId: string | null;
  captureErrorCode: string | null;
  captureStartedAt: number | null;
  recordingNoteId: number | null;
  recordingNoteTitle: string | null;
  recordingFolderId: number | null;
  micCaptureDeviceLabel: string | null;
  systemAudioOutputDeviceLabel: string | null;
  segments: TranscriptSegment[];
  transcript: string;
  micPartial: string;
  systemPartial: string;
  systemPartialSpeakerId: string | null;
  systemPartialSpeakerName: string | null;
  diarizationSessionId: string | null;
  /** Latest diarization result published for UI mirroring; consumed (nulled) by the editor that applies it. */
  completedDiarization: { noteId: number; segments: TranscriptSegment[] } | null;
  sessionDiarizationEnabled: boolean;
  sessionExpectedCount: number;
  userTouchedStepper: boolean;
  error: string | null;
  /** Bumped on every error report so identical repeated errors still re-notify. */
  errorNonce: number;
  /** Latched once per recording when main reports the system-audio tap has produced only silence. */
  systemAudioSilentWarning: boolean;
  /** Most recent interruption; quiet warnings clear when audible system audio resumes. */
  systemAudioInterrupted: { recovering: boolean; reason: string } | null;
  /** Bumped on every interruption report so a repeated one still re-notifies. */
  systemAudioInterruptedNonce: number;
  systemAudioInterruptedDeliveredNonce: number;
  currentAudioLevel: number;
  micCaptureStatus: "inactive" | "active" | "reconnecting" | "unavailable";
  manualMicMuted: boolean;
  platformMicMuted: boolean;
  systemCaptureStatus: "inactive" | "active" | "reconnecting" | "unavailable";
  windowWidth: number;
}

const MEETING_AUDIO_BUFFER_SIZE = 2400;
const MEETING_CAPTURE_DRAIN_TIMEOUT_MS = 15000;
const MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
} as const;

const buildTranscriptText = (segments: TranscriptSegment[]) =>
  segments
    .map((segment) => segment.text)
    .join(" ")
    .trim();

const getMeetingRecordingConfig = () => snapshotMeetingRecordingConfig();

const stopMediaStream = (stream: MediaStream | null) => {
  try {
    stream?.getTracks().forEach((track) => {
      if (track.readyState !== "ended") track.stop();
    });
  } catch {}
};

const createMeetingCaptureAudioContext = (): AudioContext => {
  const context = new AudioContext({ sampleRate: 24_000 });
  if (context.sampleRate !== 24_000) {
    void context.close();
    throw new Error("Meeting capture requires a 24 kHz audio context");
  }
  return context;
};

const getDisplayCaptureOptions = (mode: "loopback" | "portal") => {
  if (mode === "loopback") {
    return { video: true, audio: true };
  }

  return {
    video: true,
    audio: true,
    systemAudio: "include",
    windowAudio: "system",
    selfBrowserSurface: "exclude",
  } as DisplayMediaStreamOptions & {
    systemAudio?: "include";
    windowAudio?: "system";
    selfBrowserSurface?: "exclude";
  };
};

const requestSystemAudioDisplayStream = async (mode: "loopback" | "portal") => {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia(getDisplayCaptureOptions(mode));
    const audioTrack = stream.getAudioTracks()[0];

    if (!audioTrack) {
      stopMediaStream(stream);
      return { stream: null, error: new Error("No system-audio track was returned.") };
    }

    stream.getVideoTracks().forEach((track) => track.stop());
    return { stream, error: null };
  } catch (error) {
    return { stream: null, error: error as Error };
  }
};

const prepareMeetingSystemAudioCapture = (initialSystemAudioAccess: SystemAudioAccessResult) => {
  const initialSystemAudioStrategy = initialSystemAudioAccess.strategy ?? "unsupported";
  const initialDisplayCaptureStrategy = isRendererSystemAudioStrategy(initialSystemAudioStrategy)
    ? initialSystemAudioStrategy
    : null;
  const systemCapturePromise = initialDisplayCaptureStrategy
    ? requestSystemAudioDisplayStream(
        getDisplayCaptureModeForStrategy(initialDisplayCaptureStrategy)
      )
    : Promise.resolve({ stream: null, error: null });

  return {
    initialSystemAudioStrategy,
    initialDisplayCaptureStrategy,
    systemCapturePromise,
  };
};

const ensureRendererSystemAudioCapture = async ({
  initialDisplayCaptureStrategy,
  systemAudioStrategy,
  systemCaptureResult,
}: {
  initialDisplayCaptureStrategy: "loopback" | null;
  systemAudioStrategy: SystemAudioStrategy;
  systemCaptureResult: { stream: MediaStream | null; error: Error | null };
}) => {
  if (
    systemCaptureResult.stream ||
    systemCaptureResult.error ||
    !isRendererSystemAudioStrategy(systemAudioStrategy) ||
    initialDisplayCaptureStrategy
  ) {
    return systemCaptureResult;
  }

  return requestSystemAudioDisplayStream(getDisplayCaptureModeForStrategy(systemAudioStrategy));
};

const getMeetingWorkletBlobUrl = (() => {
  let blobUrl: string | null = null;

  return () => {
    if (blobUrl) return blobUrl;

    const code = `
const BUFFER_SIZE = ${MEETING_AUDIO_BUFFER_SIZE};
const SAMPLE_RATE = 24000;
const MAX_PENDING_FRAMES = ${MAX_UNACKNOWLEDGED_CAPTURE_FRAMES};
const MAX_ACK_AGE_FRAMES = SAMPLE_RATE * ${MAX_CAPTURE_ACK_AGE_MS} / 1000;
class MeetingPCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._buffer = new Int16Array(BUFFER_SIZE);
    this._offset = 0;
    this._sequence = 0;
    this._sampleOffset = 0;
    this._bufferStartFrame = null;
    this._gateClosed = options.processorOptions?.gateClosed === true;
    this._epochIndex = options.processorOptions?.epochIndex ?? 0;
    this._sourceGeneration = options.processorOptions?.sourceGeneration ?? 1;
    this._inputSeen = false;
    this._pendingFrames = 0;
    this._unacked = new Map();
    this._stopped = false;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message?.type === "ack") {
        const pending = this._unacked.get(message.sequence);
        if (pending) {
          this._pendingFrames -= pending.frames;
          this._unacked.delete(message.sequence);
        }
      } else if (message?.type === "flush") {
        if (this._stopped) return;
        if (this._offset > 0) {
          const partial = this._buffer.slice(0, this._offset);
          this._offset = 0;
          if (!this._send(partial)) return;
        }
        this._stopped = true;
        this.port.postMessage({ type: "flush-complete", lastSequence: this._sequence - 1, boundaryRenderFrame: currentFrame });
      } else if (message?.type === "set-gate") {
        if (this._stopped) return;
        if (message.effectiveMuted && !this._gateClosed && this._offset > 0) {
          const partial = this._buffer.slice(0, this._offset);
          this._offset = 0;
          if (!this._send(partial)) return;
        }
        const wasClosed = this._gateClosed;
        this._gateClosed = message.effectiveMuted === true;
        if (wasClosed && !this._gateClosed) {
          this._epochIndex = message.epochIndex;
          this._sourceGeneration = message.sourceGeneration;
          this._sequence = 0;
          this._sampleOffset = 0;
          this._buffer = new Int16Array(BUFFER_SIZE);
          this._offset = 0;
          this._bufferStartFrame = null;
        }
        this.port.postMessage({
          type: "gate-ack",
          commandId: message.commandId,
          sourceGeneration: this._sourceGeneration,
          effectiveMuted: this._gateClosed,
          boundaryRenderFrame: currentFrame,
          lastSequence: this._sequence - 1,
        });
      }
    };
  }
  _fail(code) {
    if (this._stopped) return;
    this._stopped = true;
    this.port.postMessage({ type: "error", code });
  }
  _send(buffer) {
    if (this._pendingFrames + buffer.length > MAX_PENDING_FRAMES) {
      this._fail("capture-queue-overflow");
      return false;
    }
    const sequence = this._sequence++;
    const frames = buffer.length;
    const renderStartFrame = this._bufferStartFrame;
    if (!Number.isSafeInteger(renderStartFrame)) {
      this._fail("capture-frame-anchor-missing");
      return false;
    }
    this._unacked.set(sequence, { frames, frame: currentFrame });
    this._pendingFrames += frames;
    const sampleOffset = this._sampleOffset;
    this._sampleOffset += frames;
    this.port.postMessage({
      type: "chunk", buffer: buffer.buffer, sequence, sampleOffset,
      renderStartFrame, epochIndex: this._epochIndex, sourceGeneration: this._sourceGeneration,
    }, [buffer.buffer]);
    this._bufferStartFrame = null;
    return true;
  }
  process(inputs, outputs) {
    if (this._stopped) return false;
    const output = outputs[0]?.[0];
    if (output) output.fill(0);
    const firstPending = this._unacked.keys().next().value;
    if (firstPending !== undefined && currentFrame - this._unacked.get(firstPending).frame >= MAX_ACK_AGE_FRAMES) {
      this._fail("capture-ack-timeout");
      return false;
    }
    const input = inputs[0]?.[0];
    if (this._gateClosed) return true;
    if (!input) {
      if (this._inputSeen) this._fail("mic-input-gap");
      return !this._stopped;
    }
    this._inputSeen = true;
    if (this._pendingFrames + this._offset + input.length > MAX_PENDING_FRAMES) {
      this._fail("capture-queue-overflow");
      return false;
    }
    for (let i = 0; i < input.length; i++) {
      if (output) output[i] = input[i];
      if (this._offset === 0) this._bufferStartFrame = currentFrame + i;
      const s = Math.max(-1, Math.min(1, input[i]));
      this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this._offset >= BUFFER_SIZE) {
        const full = this._buffer;
        this._buffer = new Int16Array(BUFFER_SIZE);
        this._offset = 0;
        if (!this._send(full)) return false;
      }
    }
    return true;
  }
}
registerProcessor("meeting-pcm-processor", MeetingPCMProcessor);
`;

    blobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
    return blobUrl;
  };
})();

export const primeMeetingWorklet = () => {
  getMeetingWorkletBlobUrl();
};

const getMeetingMicConstraints = async (
  refreshSystemDefault = false
): Promise<MediaStreamConstraints> => {
  try {
    const resolution = await resolvePreferredMicrophone({
      settings: getSettings(),
      refreshSystemDefault,
    });
    if (resolution.device?.deviceId) {
      logger.debug(
        "Resolved meeting microphone input",
        { mode: resolution.mode, status: resolution.status, label: resolution.device.label },
        "meeting"
      );
      return {
        audio: {
          deviceId: { exact: resolution.device.deviceId },
          ...MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS,
        },
      };
    }
  } catch (err) {
    logger.debug(
      "Failed to resolve microphone for meeting transcription",
      { error: (err as Error).message },
      "meeting"
    );
  }

  return { audio: MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS };
};

interface MeetingCapturePacketMessage {
  type: "chunk";
  buffer: ArrayBuffer;
  sequence: number;
  sampleOffset: number;
  renderStartFrame: number;
  epochIndex: number;
  sourceGeneration: number;
}

interface AudioPipelineOptions {
  stream: MediaStream;
  context: AudioContext;
  source: "mic" | "system";
  sessionId: string;
  epochIndex: number;
  renderOriginFrame: number;
  sourceGeneration: number;
  gateClosed?: boolean;
  alignmentAtRenderFrame?: (frame: number) => MeetingFrameAlignmentPoint | null;
  reserveEpoch?: () => number;
  onAck: (sequence: number) => void;
  onFailure: (error: Error) => void;
}

const processorDrainers = new WeakMap<AudioWorkletNode, () => Promise<number>>();
interface MeetingMicGateAck {
  boundaryRenderFrame: number;
  boundaryFrame: number;
  boundaryAlignment: MeetingFrameAlignmentPoint | null;
  sourceGeneration: number;
  effectiveMuted: boolean;
  lastSequence: number;
}
const processorGateControls = new WeakMap<
  AudioWorkletNode,
  (effectiveMuted: boolean, sequence: number) => Promise<{ ack: MeetingMicGateAck; commit(): void }>
>();

const createAudioPipeline = async ({
  stream,
  context,
  source,
  sessionId,
  epochIndex,
  renderOriginFrame,
  sourceGeneration,
  gateClosed = false,
  alignmentAtRenderFrame = () => null,
  reserveEpoch = () => epochIndex + 1,
  onAck,
  onFailure,
}: AudioPipelineOptions) => {
  if (context.state === "suspended") await context.resume();
  await context.audioWorklet.addModule(getMeetingWorkletBlobUrl());

  const sourceNode = context.createMediaStreamSource(stream);
  const processor = new AudioWorkletNode(context, "meeting-pcm-processor", {
    processorOptions: { gateClosed, epochIndex, sourceGeneration },
  });
  const silentGain = context.createGain();
  silentGain.gain.value = 0;
  let pipelineGateClosed = gateClosed;
  let gateOpening: Promise<void> | null = null;
  let releaseGateOpening: (() => void) | null = null;
  const queue = new MeetingCaptureWriteQueue<{
    buffer: ArrayBuffer;
    packet: { epochIndex: number; epochSourceStartFrame: number; sourceFrameStart: number; sourceGeneration: number; sequence: number; sampleOffset: number; alignment: MeetingFrameAlignmentSegment | null; alignmentErrorCode: string };
  }>({
    write: async ({ buffer, packet }) => {
      if (gateOpening) await gateOpening;
      const send = window.electronAPI?.meetingTranscriptionSend;
      if (!send) throw new Error("Meeting recording bridge is unavailable");
      const ack = await send(buffer, source, sessionId, packet);
      if (!ack.success || ack.sequence !== packet.sequence) {
        throw new Error("Meeting recording write was not acknowledged");
      }
      onAck(packet.sequence);
      processor.port.postMessage({ type: "ack", sequence: packet.sequence });
      return ack;
    },
    onFailure: (error) => {
      processor.port.postMessage({ type: "failed" });
      onFailure(error);
    },
  });

  let flushSequence: number | null = null;
  let drainPromise: Promise<number> | null = null;
  let terminalError: Error | null = null;
  let flushReject: ((error: Error) => void) | null = null;
  let resolveDrain: ((sequence: number) => void) | null = null;
  let activeEpochIndex = epochIndex;
  let activeSourceGeneration = sourceGeneration;
  let hasSentInEpoch = false;
  const epochStarts = new Map<number, number>();
  const gateWaiters = new Map<string, { resolve(ack: MeetingMicGateAck): void; reject(error: Error): void }>();
  const checkDrain = () => {
    if (flushSequence === null || !drainPromise) return;
    void queue.drain().then(
      () => {
        resolveDrain?.(flushSequence as number);
      },
      (error: unknown) => flushReject?.(error instanceof Error ? error : new Error(String(error)))
    );
  };

  processor.port.onmessage = (event) => {
    const message = event.data as MeetingCapturePacketMessage | { type: "flush-complete"; lastSequence: number; boundaryRenderFrame: number } | { type: "gate-ack"; commandId: string; sourceGeneration: number; effectiveMuted: boolean; boundaryRenderFrame: number; lastSequence: number } | { type: "error"; code?: string };
    if (message?.type === "chunk") {
      const frames = message.buffer.byteLength / 2;
      if (!Number.isSafeInteger(message.renderStartFrame) || message.sourceGeneration !== activeSourceGeneration || message.epochIndex !== activeEpochIndex) {
        onFailure(new Error("Meeting capture frame anchor is stale"));
        return;
      }
      const sourceFrameStart = message.renderStartFrame - renderOriginFrame;
      const packetEpochSourceStartFrame = epochStarts.get(message.epochIndex) ?? sourceFrameStart;
      epochStarts.set(message.epochIndex, packetEpochSourceStartFrame);
      const coverageStart = Math.max(packetEpochSourceStartFrame, sourceFrameStart - 4 * 24_000);
      const start = alignmentAtRenderFrame(renderOriginFrame + coverageStart);
      const end = alignmentAtRenderFrame(message.renderStartFrame + frames);
      const alignment: MeetingFrameAlignmentSegment | null = start && end && start.helperGeneration === end.helperGeneration ? {
        sourceGeneration, sourceStartFrame: coverageStart, sourceEndFrame: sourceFrameStart + frames,
        timelineStartFrame: start.timelineFrame,
        rate: start.rate,
        uncertaintyStartFrames: start.uncertaintyFrames, uncertaintyEndFrames: end.uncertaintyFrames,
        helperGeneration: start.helperGeneration,
        sourceStartNs: start.sourceNs, sourceEndNs: end.sourceNs,
        helperStartNs: start.helperNs, helperEndNs: end.helperNs,
        sampledSourceStartNs: start.sampledSourceStartNs, sampledSourceEndNs: start.sampledSourceEndNs,
        freshnessSourceNs: start.freshnessSourceNs,
      } : null;
      const packet = {
        epochIndex: message.epochIndex,
        epochSourceStartFrame: packetEpochSourceStartFrame,
        sourceFrameStart, sourceGeneration: message.sourceGeneration,
        sequence: message.sequence, sampleOffset: message.sampleOffset, alignment,
        alignmentErrorCode: alignment ? "alignment-confirmed" : "clock-unavailable",
      };
      hasSentInEpoch = true;
      void queue.write({ buffer: message.buffer, packet }, frames).catch(() => {});
    } else if (message?.type === "flush-complete") {
      flushSequence = message.lastSequence;
      if (source === "mic") captureMicrophoneBoundary = {
        sourceGeneration, sourceFrame: message.boundaryRenderFrame - renderOriginFrame,
        alignment: alignmentAtRenderFrame(message.boundaryRenderFrame),
      };
      checkDrain();
    } else if (message?.type === "gate-ack") {
      const waiter = gateWaiters.get(message.commandId);
      if (!waiter || message.sourceGeneration !== activeSourceGeneration) return;
      gateWaiters.delete(message.commandId);
      try {
        const boundaryAlignment = alignmentAtRenderFrame(message.boundaryRenderFrame);
        waiter.resolve({
          boundaryRenderFrame: message.boundaryRenderFrame,
          boundaryFrame: message.boundaryRenderFrame - renderOriginFrame,
          boundaryAlignment,
          sourceGeneration: message.sourceGeneration,
          effectiveMuted: message.effectiveMuted,
          lastSequence: message.lastSequence,
        });
      } catch (error) {
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
    } else if (message?.type === "error") {
      const error = new Error(message.code ?? "Meeting capture buffer limit was reached");
      terminalError = error;
      onFailure(error);
      flushReject?.(error);
    }
  };

  sourceNode.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(context.destination);

  processorDrainers.set(processor, () => {
    if (drainPromise) return drainPromise;
    if (terminalError) return Promise.reject(terminalError);
    let resolvePromise: (sequence: number) => void = () => {};
    let rejectPromise: (error: Error) => void = () => {};
    drainPromise = new Promise<number>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    // Store the resolver for the ordered flush-complete + write-ack barrier.
    resolveDrain = resolvePromise!;
    flushReject = rejectPromise!;
    const timeout = window.setTimeout(() => {
      const error = new Error("Meeting audio flush did not complete");
      onFailure(error);
      rejectPromise!(error);
    }, MEETING_CAPTURE_DRAIN_TIMEOUT_MS);
    void drainPromise.then(
      () => window.clearTimeout(timeout),
      () => window.clearTimeout(timeout)
    );
    processor.port.postMessage({ type: "flush" });
    return drainPromise.then(async (result) => {
      await queue.drain();
      return result;
    });
  });

  processorGateControls.set(processor, async (effectiveMuted, sequence) => {
    const commandId = crypto.randomUUID();
    if (!effectiveMuted && pipelineGateClosed) {
      gateOpening = new Promise<void>((resolve) => { releaseGateOpening = resolve; });
      if (hasSentInEpoch) activeEpochIndex = reserveEpoch();
      activeSourceGeneration = sourceGeneration;
      hasSentInEpoch = false;
    }
    const acknowledgement = new Promise<MeetingMicGateAck>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        gateWaiters.delete(commandId);
        reject(new Error("Microphone gate transition did not reach an audio frame boundary"));
      }, MEETING_CAPTURE_DRAIN_TIMEOUT_MS);
      gateWaiters.set(commandId, {
        resolve: (ack) => {
          window.clearTimeout(timeout);
          resolve(ack);
        },
        reject: (error) => {
          window.clearTimeout(timeout);
          reject(error);
        },
      });
    });
    processor.port.postMessage({
      type: "set-gate", commandId, sequence, effectiveMuted,
      epochIndex: activeEpochIndex, sourceGeneration: activeSourceGeneration,
    });
    const ack = await acknowledgement;
    pipelineGateClosed = effectiveMuted;
    if (effectiveMuted) await queue.waitForWrites();
    return {
      ack,
      commit: () => {
        releaseGateOpening?.();
        releaseGateOpening = null;
        gateOpening = null;
      },
    };
  });

  return { source: sourceNode, processor };
};

async function setAudioPipelineGate(
  processor: AudioWorkletNode | null,
  effectiveMuted: boolean,
  sequence: number
): Promise<{ ack: MeetingMicGateAck; commit(): void }> {
  const setGate = processor ? processorGateControls.get(processor) : null;
  if (!setGate) throw new Error("Meeting microphone gate is unavailable");
  return setGate(effectiveMuted, sequence);
}

const flushAndDisconnectProcessor = async (processor: AudioWorkletNode | null): Promise<number> => {
  if (!processor) return -1;
  const drain = processorDrainers.get(processor);
  if (!drain) {
    processor.disconnect();
    return -1;
  }
  try {
    const lastSequence = await drain();
    processor.port.onmessage = null;
    processor.disconnect();
    processorDrainers.delete(processor);
    return lastSequence;
  } catch (error) {
    processor.port.onmessage = null;
    processor.disconnect();
    processorDrainers.delete(processor);
    throw error;
  }
};

// Pipeline lives in module scope — not on React refs — so it survives
// view changes and re-mounts of the consumer view.
let micContext: AudioContext | null = null;
let micSource: MediaStreamAudioSourceNode | null = null;
let micProcessor: AudioWorkletNode | null = null;
let micStream: MediaStream | null = null;
let micAnalyser: AnalyserNode | null = null;
// Native system audio is captured in main, which streams its RMS here.
let systemAudioLevel = 0;
let systemAudioLevelAt = 0;
const SYSTEM_AUDIO_LEVEL_STALE_MS = 250;
let micRecovery: ActiveMicRecoveryController | null = null;
let systemContext: AudioContext | null = null;
let systemSource: MediaStreamAudioSourceNode | null = null;
let systemProcessor: AudioWorkletNode | null = null;
let systemStream: MediaStream | null = null;
let isRecordingFlag = false;
let isStartingFlag = false;
let activeRecordingSessionId: string | null = null;
const meetingRecordingStartCoordinator = createMeetingRecordingStartCoordinator();
const meetingRecordingStopBarrier = createMeetingRecordingStopBarrier();
let isPrepared = false;
let preparePromise: Promise<void> | null = null;
let ipcCleanups: Array<() => void> = [];
let pushConfigTimeout: ReturnType<typeof setTimeout> | null = null;
let sessionSystemAudioActive = false;
let captureEpochIndices: Record<"mic" | "system", number> = { mic: 0, system: 0 };
let captureSourceGenerations: Record<"mic" | "system", number> = { mic: 1, system: 1 };
let captureLastSequences: Record<"mic" | "system", number> = { mic: -1, system: -1 };
let micIntentSequence = 0;
let meetMicMuted = false;
let deviceMicMuted = false;
let requestedManualMicMuted = false;
let requestedPlatformMicMuted = false;
let micIntentQueue: Promise<boolean> = Promise.resolve(true);
let micIntentClosing = false;
let captureDrainErrorCode: string | null = null;
let suppressInitialProcessingForStop = false;
const PAUSED_MEETING_KEY = "gristmill.paused-meeting";
function readPausedMeeting(): { groupId: string; noteId: number; manualMicMuted: boolean; restartSessionId?: string } | null {
  try {
    const value = JSON.parse(localStorage.getItem(PAUSED_MEETING_KEY) ?? "null");
    return typeof value?.groupId === "string" && Number.isSafeInteger(value?.noteId)
      ? { groupId: value.groupId, noteId: value.noteId, manualMicMuted: value.manualMicMuted === true, restartSessionId: typeof value.restartSessionId === "string" ? value.restartSessionId : undefined }
      : null;
  } catch { return null; }
}
const pausedMeeting = typeof window === "undefined" ? null : readPausedMeeting();
let captureMicrophoneBoundary: { sourceGeneration: number; sourceFrame: number; alignment: MeetingFrameAlignmentPoint | null } | undefined;
let captureClockSync: MeetingClockSync | null = null;
let captureClockOriginNs: string | null = null;
let captureClockGeneration: string | null = null;
let captureClockProbeTimer: ReturnType<typeof setInterval> | null = null;
let captureRendererOrigins: Partial<Record<"mic" | "system", { context: AudioContext; frame: number }>> = {};

const performanceNs = (): string => Math.round(performance.now() * 1_000_000).toString();

async function probeMeetingCaptureClock(sessionId: string, recordingId: string): Promise<boolean> {
  const sync = captureClockSync;
  if (!sync) return false;
  const probe = sync.createProbe(performanceNs());
  try {
    const response = await window.electronAPI?.meetingTranscriptionProbeClock?.({
      sessionId,
      recordingId,
      nonce: probe.nonce,
      sourceSendNs: probe.sourceSendNs,
    });
    const sourceReceiveNs = performanceNs();
    if (!response?.success || response.nonce !== probe.nonce || !response.helperGeneration ||
        !response.helperReceiveNs || !response.helperSendNs) return false;
    if (activeRecordingSessionId !== sessionId || captureClockSync !== sync) return false;
    if (captureClockGeneration !== response.helperGeneration) {
      captureClockSync?.reset(response.helperGeneration);
      captureClockGeneration = response.helperGeneration;
      sync.createProbe(probe.sourceSendNs, probe.nonce);
    }
    return Boolean(sync.accept({
      type: "probe",
      nonce: response.nonce,
      helperReceiveNs: response.helperReceiveNs,
      helperSendNs: response.helperSendNs,
      helperGeneration: response.helperGeneration,
      helperFrame: response.helperFrame ?? 0,
    }, sourceReceiveNs));
  } catch {
    return false;
  }
}

export const useMeetingRecordingStore = create<MeetingRecordingState>()(() => ({
  isRecording: false,
  isTranscribing: false,
  capturePhase: pausedMeeting ? "paused" : "idle",
  recordingId: null,
  meetingGroupId: pausedMeeting?.groupId ?? null,
  captureErrorCode: null,
  captureStartedAt: null,
  recordingNoteId: pausedMeeting?.noteId ?? null,
  recordingNoteTitle: null,
  recordingFolderId: null,
  micCaptureDeviceLabel: null,
  systemAudioOutputDeviceLabel: null,
  segments: [],
  transcript: "",
  micPartial: "",
  systemPartial: "",
  systemPartialSpeakerId: null,
  systemPartialSpeakerName: null,
  diarizationSessionId: null,
  completedDiarization: null,
  sessionDiarizationEnabled:
    (getSettings() as { speakerDiarizationEnabled?: boolean }).speakerDiarizationEnabled ?? true,
  sessionExpectedCount: DEFAULT_EXPECTED_SPEAKER_COUNT,
  userTouchedStepper: false,
  error: null,
  errorNonce: 0,
  systemAudioSilentWarning: false,
  systemAudioInterrupted: null,
  systemAudioInterruptedNonce: 0,
  systemAudioInterruptedDeliveredNonce: 0,
  currentAudioLevel: 0,
  micCaptureStatus: "inactive",
  manualMicMuted: pausedMeeting?.manualMicMuted ?? false,
  platformMicMuted: false,
  systemCaptureStatus: "inactive",
  windowWidth: typeof window !== "undefined" ? window.innerWidth : SIDE_PANEL_BREAKPOINT_PX,
}));

function reportMeetingError(error: string, extra: Partial<MeetingRecordingState> = {}): void {
  useMeetingRecordingStore.setState((state) => ({
    ...extra,
    error,
    errorNonce: state.errorNonce + 1,
  }));
}

export const getMicAnalyser = (): AnalyserNode | null => micAnalyser;
export const getSystemAudioLevel = (): number =>
  Date.now() - systemAudioLevelAt > SYSTEM_AUDIO_LEVEL_STALE_MS ? 0 : systemAudioLevel;

export const getActiveRecordingSessionId = (): string | null => activeRecordingSessionId;

function queueMicIntent(manualMuted: boolean, platformMuted: boolean): Promise<boolean> {
  if (!isRecordingFlag || micIntentClosing || !activeRecordingSessionId || !micProcessor) return Promise.resolve(false);
  const sessionId = activeRecordingSessionId;
  const recordingId = useMeetingRecordingStore.getState().recordingId;
  if (!recordingId) return Promise.resolve(false);
  const operation = micIntentQueue.then(async () => {
    if (activeRecordingSessionId !== sessionId || !isRecordingFlag || !micProcessor) return false;
    const sequence = micIntentSequence + 1;
    const effectiveMuted = manualMuted || platformMuted;
    let gate: Awaited<ReturnType<typeof setAudioPipelineGate>> | null = null;
    try {
      gate = await setAudioPipelineGate(micProcessor, effectiveMuted, sequence);
      if (activeRecordingSessionId !== sessionId) throw new Error("Microphone intent belongs to a stale recording");
      const response = await window.electronAPI?.meetingTranscriptionSetMicIntent?.({
        sessionId,
        recordingId,
        sequence,
        sourceGeneration: captureSourceGenerations.mic,
        manualMuted,
        platformMuted,
        boundaryFrame: gate.ack.boundaryFrame,
        boundaryAlignment: gate.ack.boundaryAlignment,
      });
      if (!response?.success || response.sequence !== sequence || response.sourceGeneration !== captureSourceGenerations.mic || response.effectiveMuted !== effectiveMuted) {
        throw new Error(response?.error || "Microphone intent was not acknowledged");
      }
      micIntentSequence = sequence;
      useMeetingRecordingStore.setState({ manualMicMuted: manualMuted, platformMicMuted: platformMuted });
      micRecovery?.setIntentionalMute(effectiveMuted);
      gate.commit();
      return true;
    } catch (error) {
      gate?.commit();
      captureDrainErrorCode ??= "mic-intent-transition-failed";
      reportMeetingError((error as Error).message, { captureErrorCode: captureDrainErrorCode });
      if (isRecordingFlag) void stopRecording(sessionId);
      return false;
    }
  });
  micIntentQueue = operation;
  return operation;
}

export function setManualMicMuted(muted: boolean): Promise<boolean> {
  const state = useMeetingRecordingStore.getState();
  if (state.capturePhase === "paused") {
    const paused = readPausedMeeting();
    if (!paused) return Promise.resolve(false);
    localStorage.setItem(PAUSED_MEETING_KEY, JSON.stringify({ ...paused, manualMicMuted: muted }));
    useMeetingRecordingStore.setState({ manualMicMuted: muted });
    return Promise.resolve(true);
  }
  requestedManualMicMuted = muted;
  return queueMicIntent(requestedManualMicMuted, requestedPlatformMicMuted);
}

export function setPlatformMicMuted(muted: boolean): Promise<boolean> {
  requestedPlatformMicMuted = muted;
  return queueMicIntent(requestedManualMicMuted, requestedPlatformMicMuted);
}

function pushConfig(enabled: boolean, expectedCount: number, countIsExplicit: boolean) {
  if (pushConfigTimeout) clearTimeout(pushConfigTimeout);
  pushConfigTimeout = setTimeout(() => {
    (
      window.electronAPI as unknown as {
        setMeetingSessionSpeakerConfig?: (config: {
          enabled: boolean;
          expectedCount: number;
          countIsExplicit: boolean;
        }) => void;
      }
    )?.setMeetingSessionSpeakerConfig?.({ enabled, expectedCount, countIsExplicit });
  }, 150);
}

export function setSessionDiarizationEnabled(enabled: boolean): void {
  useMeetingRecordingStore.setState({ sessionDiarizationEnabled: enabled });
  // The toggle only carries the count along — it is explicit solely when the
  // user has actually touched the stepper, so roster refreshes stay possible.
  const state = useMeetingRecordingStore.getState();
  pushConfig(enabled, state.sessionExpectedCount, state.userTouchedStepper);
  const noteId = useMeetingRecordingStore.getState().recordingNoteId;
  if (noteId != null) {
    window.electronAPI?.updateNote?.(noteId, { diarization_enabled: enabled ? 1 : 0 });
  }
}

export function setSessionExpectedCount(count: number): void {
  const clamped = Math.max(1, Math.min(MAX_SPEAKER_COUNT, count));
  useMeetingRecordingStore.setState({
    sessionExpectedCount: clamped,
    userTouchedStepper: true,
  });
  pushConfig(useMeetingRecordingStore.getState().sessionDiarizationEnabled, clamped, true);
  const noteId = useMeetingRecordingStore.getState().recordingNoteId;
  if (noteId != null) {
    window.electronAPI?.updateNote?.(noteId, { expected_speaker_count: clamped });
  }
}

// Instant stepper feedback when the roster changes mid-recording. The
// authoritative cap update happens in main (db-update-note →
// _refreshMeetingSpeakerConfigFromNote), which broadcasts
// meeting-session-speaker-config-updated back to this store — so no pushConfig
// here, or the config would be marked as an explicit stepper choice.
export function syncSessionExpectedCountFromParticipants(
  noteId: number,
  participants: readonly CalendarAttendee[]
): void {
  const state = useMeetingRecordingStore.getState();
  const expectedCount = resolveParticipantSpeakerCountSync({
    recordingNoteId: state.recordingNoteId,
    noteId,
    userTouchedStepper: state.userTouchedStepper,
    currentExpectedCount: state.sessionExpectedCount,
    participants,
  });
  if (expectedCount == null) return;

  const clamped = Math.max(1, Math.min(MAX_SPEAKER_COUNT, expectedCount));
  if (clamped === state.sessionExpectedCount) return;

  useMeetingRecordingStore.setState({ sessionExpectedCount: clamped });
}

async function cleanup(): Promise<void> {
  if (captureClockProbeTimer) clearInterval(captureClockProbeTimer);
  captureClockProbeTimer = null;
  captureClockSync = null;
  captureClockOriginNs = null;
  captureClockGeneration = null;
  micRecovery?.stop();
  micRecovery = null;
  const micDrain = flushAndDisconnectProcessor(micProcessor);
  const systemDrain = flushAndDisconnectProcessor(systemProcessor);
  const [micResult, systemResult] = await Promise.allSettled([micDrain, systemDrain]);
  captureLastSequences.mic = micResult.status === "fulfilled" ? micResult.value : -1;
  captureLastSequences.system = systemResult.status === "fulfilled" ? systemResult.value : -1;
  if (micResult.status === "rejected" || systemResult.status === "rejected") {
    captureDrainErrorCode ??= "capture-drain-incomplete";
    reportMeetingError("Meeting audio could not finish saving its last samples.");
  }
  micProcessor = null;

  micSource?.disconnect();
  micSource = null;

  micAnalyser?.disconnect();
  micAnalyser = null;

  stopMediaStream(micStream);
  micStream = null;

  try {
    await micContext?.close();
  } catch {}
  micContext = null;

  systemProcessor = null;

  systemSource?.disconnect();
  systemSource = null;

  stopMediaStream(systemStream);
  systemStream = null;

  try {
    await systemContext?.close();
  } catch {}
  systemContext = null;
  captureRendererOrigins = {};

  ipcCleanups.forEach((fn) => fn());
  ipcCleanups = [];
  // A debounced config push firing after stop would repopulate the session
  // config main just cleared, leaking this session's count into the next one.
  if (pushConfigTimeout) {
    clearTimeout(pushConfigTimeout);
    pushConfigTimeout = null;
  }
  isPrepared = false;
  isRecordingFlag = false;
  isStartingFlag = false;
  sessionSystemAudioActive = false;
}

export async function prepareTranscription(noteId?: number | null): Promise<boolean> {
  if (isPrepared) return true;
  if (isRecordingFlag || isStartingFlag) return false;
  if (preparePromise) {
    await preparePromise;
    return isPrepared;
  }
  const promise = (async () => {
    try {
      const result = await window.electronAPI?.meetingTranscriptionPrepare?.({ noteId });

      if (result?.success) {
        isPrepared = true;
        logger.info("Local meeting capture is ready", {}, "meeting");
      } else {
        logger.error("Local meeting capture prepare failed", { error: result?.error }, "meeting");
      }
    } catch (err) {
      logger.error(
        "Meeting transcription prepare error",
        { error: (err as Error).message },
        "meeting"
      );
    } finally {
      preparePromise = null;
    }
  })();

  preparePromise = promise;
  await promise;
  return isPrepared;
}

export interface StartRecordingArgs {
  noteId: number | null;
  noteTitle: string | null;
  folderId: number | null;
  seedSegments?: TranscriptSegment[];
  diarizationEnabled?: boolean | null;
  expectedCount?: number | null;
  expectedCountIsExplicit?: boolean;
  autoEndEligible: boolean;
  groupId?: string;
  manualMicMuted?: boolean;
  restartSessionId?: string;
}

// Resolves false only when setup cannot start the recording; setup failures are
// reported through the store so callers do not roll back UI they do not own.
export async function startRecording(args: StartRecordingArgs): Promise<boolean> {
  if (isRecordingFlag || isStartingFlag) return true;
  const paused = readPausedMeeting();
  if (paused && (paused.noteId !== args.noteId || paused.groupId !== args.groupId)) {
    reportMeetingError("Finish or resume the paused call before starting another.");
    return false;
  }

  const sessionId = createMeetingRecordingSessionId();
  const previous = useMeetingRecordingStore.getState();
  const groupId = args.groupId ?? (
    previous.recordingNoteId === args.noteId &&
    (previous.capturePhase === "saved" || previous.capturePhase === "incomplete")
      ? previous.meetingGroupId
      : null
  ) ?? crypto.randomUUID();
  let started = false;
  await meetingRecordingStartCoordinator.runStart(sessionId, async (startOperation) => {
    if (isRecordingFlag || isStartingFlag) {
      started = true;
      return;
    }

    await meetingRecordingStopBarrier.waitForPendingStop();
    if (!startOperation.isCurrent() || isRecordingFlag || isStartingFlag) return;
    isStartingFlag = true;
    activeRecordingSessionId = sessionId;
    const isCurrentStart = () =>
      startOperation.isCurrent() && activeRecordingSessionId === sessionId;

    const initialEnabled =
      args.diarizationEnabled ??
      (getSettings() as { speakerDiarizationEnabled?: boolean }).speakerDiarizationEnabled ??
      true;
    const initialCount = Math.max(
      1,
      Math.min(MAX_SPEAKER_COUNT, args.expectedCount ?? DEFAULT_EXPECTED_SPEAKER_COUNT)
    );

    logger.info("Meeting transcription starting...", {}, "meeting");
    const seed = args.seedSegments ?? [];
    sessionSystemAudioActive = false;

    useMeetingRecordingStore.setState({
      isRecording: false,
      isTranscribing: false,
      capturePhase: "preparing",
      recordingId: null,
      meetingGroupId: groupId,
      captureErrorCode: null,
      captureStartedAt: null,
      recordingNoteId: args.noteId,
      recordingNoteTitle: args.noteTitle,
      recordingFolderId: args.folderId,
      micCaptureDeviceLabel: null,
      systemAudioOutputDeviceLabel: null,
      sessionDiarizationEnabled: initialEnabled,
      sessionExpectedCount: initialCount,
      userTouchedStepper: resolveInitialSpeakerCountOverride(
        args.expectedCount,
        args.expectedCountIsExplicit
      ),
      segments: seed,
      transcript: buildTranscriptText(seed),
      micPartial: "",
      systemPartial: "",
      systemPartialSpeakerId: null,
      systemPartialSpeakerName: null,
      diarizationSessionId: null,
      completedDiarization: null,
      error: null,
      systemAudioSilentWarning: false,
      systemAudioInterrupted: null,
      micCaptureStatus: "inactive",
      manualMicMuted: args.manualMicMuted === true,
      platformMicMuted: false,
      systemCaptureStatus: "inactive",
    });

    isRecordingFlag = true;
    captureLastSequences = { mic: -1, system: -1 };
    captureMicrophoneBoundary = undefined;
    captureDrainErrorCode = null;
    captureEpochIndices = { mic: 0, system: 0 };
    captureSourceGenerations = { mic: 1, system: 1 };
    micIntentSequence = 0;
    requestedManualMicMuted = args.manualMicMuted === true;
    meetMicMuted = false; deviceMicMuted = false;
    requestedPlatformMicMuted = false;
    micIntentQueue = Promise.resolve(true);
    micIntentClosing = false;
    let systemAudioAvailabilityResolved = false;
    let pendingSystemAudioInterruption: MeetingSystemAudioInterruption | null = null;
    const publishSystemAudioInterruption = (data: MeetingSystemAudioInterruption): void => {
      logger.warn("Meeting system audio was interrupted", data, "meeting");
      useMeetingRecordingStore.setState((state) => ({
        systemAudioInterrupted: {
          recovering: data.recovering === true,
          reason: data.reason,
        },
        systemAudioInterruptedNonce: state.systemAudioInterruptedNonce + 1,
      }));
    };
    let setupMicResult: MediaStream | null = null;
    let setupSystemCaptureResult: { stream: MediaStream | null; error: Error | null } = {
      stream: null,
      error: null,
    };
    const releaseSession = () => {
      if (activeRecordingSessionId === sessionId) activeRecordingSessionId = null;
    };
    const stopScopedMainOnce = () =>
      startOperation.stopMainOnce(async () => {
        const result = await window.electronAPI?.meetingTranscriptionStop?.({
          sessionId,
          lastSequence: captureLastSequences,
        microphoneBoundary: captureMicrophoneBoundary,
          incomplete: true,
          errorCode: captureDrainErrorCode ?? "capture-start-canceled",
          suppressProcessing: suppressInitialProcessingForStop,
        }).catch(() => undefined);
        if (result?.success) {
          useMeetingRecordingStore.setState({
            recordingId: result.recordingId ?? useMeetingRecordingStore.getState().recordingId,
            capturePhase: result.captureState === "ready" ? "saved" : "incomplete",
            captureErrorCode: result.errorCode ?? captureDrainErrorCode ?? "capture-start-canceled",
          });
        }
      });
    const teardownStart = async () => {
      stopMediaStream(setupMicResult);
      stopMediaStream(setupSystemCaptureResult.stream);
      setupMicResult = null;
      setupSystemCaptureResult = { stream: null, error: null };
      isRecordingFlag = false;
      isStartingFlag = false;
      await teardownFailedMeetingRecordingSetup({
        stopBarrier: meetingRecordingStopBarrier,
        cleanup,
        stopMain: stopScopedMainOnce,
        releaseSession,
      });
    };

    try {
      // Main capture can fail while microphone permission is still pending.
      // Keep its latest report until setup establishes whether this session
      // actually has system audio, including a possible mic-only fallback.
      const interruptedCleanup = window.electronAPI?.onMeetingSystemAudioInterrupted?.((data) => {
        if (activeRecordingSessionId !== sessionId || !isRecordingFlag) return;
        useMeetingRecordingStore.setState({
          systemCaptureStatus: data.recovering ? "reconnecting" : "unavailable",
        });
        if (!systemAudioAvailabilityResolved) {
          pendingSystemAudioInterruption = data;
        } else if (sessionSystemAudioActive) {
          publishSystemAudioInterruption(data);
        }
      });
      const stopRequestedCleanup = window.electronAPI?.onMeetingTranscriptionStopRequested?.((request) => {
        if (request.reason === "platform-leave" || request.sessionId !== sessionId || activeRecordingSessionId !== sessionId) return;
        void stopRecording(sessionId, { suppressProcessing: request.suppressProcessing === true });
      });
      const manualMuteCleanup = window.electronAPI?.onMeetManualMute?.((request) => {
        if (request.sessionId !== activeRecordingSessionId || request.recordingId !== useMeetingRecordingStore.getState().recordingId) return;
        void setManualMicMuted(request.muted);
      });
      const platformMuteCleanup = window.electronAPI?.onMeetPlatformMute?.((request) => {
        if (request.sessionId !== activeRecordingSessionId || request.recordingId !== useMeetingRecordingStore.getState().recordingId) return;
        meetMicMuted = request.muted;
        requestedPlatformMicMuted = meetMicMuted || deviceMicMuted;
        useMeetingRecordingStore.setState({ platformMicMuted: requestedPlatformMicMuted });
        if (micProcessor) void setPlatformMicMuted(requestedPlatformMicMuted);
      });
      const resumedCleanup = window.electronAPI?.onMeetingSystemAudioResumed?.(() => {
        if (activeRecordingSessionId !== sessionId || !isRecordingFlag) return;
        useMeetingRecordingStore.setState({ systemCaptureStatus: "active" });
        pendingSystemAudioInterruption = null;
        useMeetingRecordingStore.setState({ systemAudioInterrupted: null });
      });
      ipcCleanups.push(() => {
        pendingSystemAudioInterruption = null;
        interruptedCleanup?.();
        resumedCleanup?.();
        stopRequestedCleanup?.();
        platformMuteCleanup?.();
        manualMuteCleanup?.();
      });

      if (preparePromise) {
        logger.debug("Waiting for in-flight prepare to finish...", {}, "meeting");
        await preparePromise;
        if (!isCurrentStart()) {
          await teardownStart();
          return;
        }
      }

      const startTime = performance.now();
      const initialSystemAudioAccess =
        (await (window.electronAPI?.checkSystemAudioAccess?.() ??
          Promise.resolve(DEFAULT_SYSTEM_AUDIO_ACCESS))) ?? getFallbackSystemAudioAccess();
      if (!isCurrentStart()) {
        await teardownStart();
        return;
      }
      const { initialSystemAudioStrategy, initialDisplayCaptureStrategy, systemCapturePromise } =
        prepareMeetingSystemAudioCapture(initialSystemAudioAccess);

      startOperation.markMainStartAttempted();
      const mainStartPromise = window.electronAPI?.meetingTranscriptionStart?.({
        noteId: args.noteId ?? null,
        sessionId,
        groupId,
        autoEndEligible: args.autoEndEligible,
        restartSessionId: args.restartSessionId,
        manualMicMuted: args.manualMicMuted === true,
        recordingConfig: getMeetingRecordingConfig(),
      });
      const micCapturePromise = getMeetingMicConstraints().then(async (constraints) => {
        if (!isCurrentStart()) return null;
        try {
          return await navigator.mediaDevices.getUserMedia(constraints);
        } catch (err) {
          const hasExactDevice =
            typeof constraints.audio === "object" &&
            constraints.audio !== null &&
            "deviceId" in constraints.audio;
          if (hasExactDevice && isCurrentStart()) {
            try {
              const fallbackStream = await navigator.mediaDevices.getUserMedia({
                audio: MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS,
              });
              logger.info(
                "Meeting mic capture recovered using default device",
                { error: (err as Error).message },
                "meeting"
              );
              return fallbackStream;
            } catch (fallbackErr) {
              logger.error(
                "Meeting mic capture failed, continuing with system audio only",
                { error: (fallbackErr as Error).message },
                "meeting"
              );
              return null;
            }
          }
          logger.error(
            "Meeting mic capture failed, continuing with system audio only",
            { error: (err as Error).message, constraints },
            "meeting"
          );
          return null;
        }
      });
      const [startOutcome, micOutcome, systemCaptureOutcome] = await Promise.allSettled([
        mainStartPromise,
        micCapturePromise,
        systemCapturePromise,
      ] as const);

      if (micOutcome.status === "fulfilled") setupMicResult = micOutcome.value;
      if (systemCaptureOutcome.status === "fulfilled") {
        setupSystemCaptureResult = systemCaptureOutcome.value;
      }
      if (startOutcome.status === "rejected") throw startOutcome.reason;
      if (micOutcome.status === "rejected") throw micOutcome.reason;
      if (systemCaptureOutcome.status === "rejected") throw systemCaptureOutcome.reason;

      const startResult = startOutcome.value;
      const micResult = setupMicResult;
      const initialSystemCaptureResult = setupSystemCaptureResult;
      let systemCaptureResult = initialSystemCaptureResult;

      const streamsMs = performance.now() - startTime;
      if (!isCurrentStart()) {
        logger.info("Meeting transcription aborted during setup (stop called)", {}, "meeting");
        await teardownStart();
        return;
      }

      if (!startResult?.success) {
        logger.error(
          "Meeting transcription IPC start failed",
          { error: startResult?.error },
          "meeting"
        );
        reportMeetingError(startResult?.error || "Failed to start meeting transcription", {
          isRecording: false,
          isTranscribing: false,
          capturePhase: "failed",
          captureErrorCode: startResult?.code ?? "capture-start-failed",
        });
        stopMediaStream(micResult);
        stopMediaStream(systemCaptureResult.stream);
        setupMicResult = null;
        setupSystemCaptureResult = { stream: null, error: null };
        isRecordingFlag = false;
        isStartingFlag = false;
        await cleanup();
        releaseSession();
        return;
      }
      const systemAudioMode = startResult.systemAudioMode || initialSystemAudioAccess.mode;
      const systemAudioStrategy = startResult.systemAudioStrategy || initialSystemAudioStrategy;
      systemCaptureResult = await ensureRendererSystemAudioCapture({
        initialDisplayCaptureStrategy,
        systemAudioStrategy,
        systemCaptureResult,
      });
      setupSystemCaptureResult = systemCaptureResult;
      if (!isCurrentStart()) {
        await teardownStart();
        return;
      }
      const systemAudioHandledInMain =
        systemAudioMode !== "unsupported" && !isRendererSystemAudioStrategy(systemAudioStrategy);
      if (systemAudioHandledInMain && systemCaptureResult.stream) {
        stopMediaStream(systemCaptureResult.stream);
        systemCaptureResult = { stream: null, error: null };
        setupSystemCaptureResult = systemCaptureResult;
      }
      const systemCaptureError = systemAudioHandledInMain ? null : systemCaptureResult.error;

      if (!micResult && !systemCaptureResult.stream && !systemAudioHandledInMain) {
        const message =
          systemAudioMode === "unsupported"
            ? "No microphone is available and system audio capture is unsupported on this device."
            : systemCaptureError?.message ||
              "No microphone is available and system audio capture could not be started.";
        logger.error("Meeting capture has no available audio source", { message }, "meeting");
        reportMeetingError(
          message,
          { isRecording: false, isTranscribing: false, captureErrorCode: "no-audio-source" }
        );
        await teardownStart();
        useMeetingRecordingStore.setState({ capturePhase: "failed" });
        return;
      }

      const errorCleanup = window.electronAPI?.onMeetingTranscriptionError?.((err) => {
        if (activeRecordingSessionId !== sessionId) return;
        useMeetingRecordingStore.setState({ systemCaptureStatus: "unavailable" });
        reportMeetingError(err, { captureErrorCode: "system-audio-interrupted" });
        logger.error("Meeting audio capture reported an error", { error: err }, "meeting");
      });
      if (errorCleanup) ipcCleanups.push(errorCleanup);

      const fatalErrorCleanup = window.electronAPI?.onMeetingTranscriptionFatalError?.((err) => {
        if (activeRecordingSessionId !== sessionId) return;
        captureDrainErrorCode = "capture-write-failed";
        reportMeetingError(err, { captureErrorCode: captureDrainErrorCode });
        logger.error("Meeting audio capture stopped after a write failure", { error: err }, "meeting");
        if (isRecordingFlag) void stopRecording(sessionId);
      });
      if (fatalErrorCleanup) ipcCleanups.push(fatalErrorCleanup);

      const systemAudioSilentCleanup = window.electronAPI?.onMeetingSystemAudioSilent?.((data) => {
        if (activeRecordingSessionId !== sessionId || !isRecordingFlag) return;
        if (!sessionSystemAudioActive) return;
        if (useMeetingRecordingStore.getState().systemAudioSilentWarning) return;
        logger.warn("Meeting system audio has produced only silence", {
          systemAudioStrategy: data?.systemAudioStrategy,
        }, "meeting");
        useMeetingRecordingStore.setState({ systemAudioSilentWarning: true });
      });
      if (systemAudioSilentCleanup) ipcCleanups.push(systemAudioSilentCleanup);

      const systemAudioLevelCleanup = window.electronAPI?.onMeetingSystemAudioLevel?.((level) => {
        if (activeRecordingSessionId !== sessionId) return;
        systemAudioLevel = level;
        systemAudioLevelAt = Date.now();
      });
      if (systemAudioLevelCleanup) ipcCleanups.push(systemAudioLevelCleanup);

      if (!startResult.recordingId || !startResult.originAt) {
        throw new Error("Meeting capture did not return its durable recording origin");
      }
      meetMicMuted = startResult.platformMicMuted === true;
      requestedPlatformMicMuted = meetMicMuted || deviceMicMuted;
      useMeetingRecordingStore.setState({ recordingId: startResult.recordingId, platformMicMuted: requestedPlatformMicMuted });
      const recordingOrigin = Date.parse(startResult.originAt);
      if (!Number.isFinite(recordingOrigin)) {
        throw new Error("Meeting capture returned an invalid session origin");
      }
      captureClockSync = null;
      captureClockOriginNs = null;
      captureClockGeneration = null;
      captureRendererOrigins = {};
      if (startResult.helperGeneration && startResult.monotonicOriginNs) {
        captureClockSync = new MeetingClockSync();
        captureClockSync.reset(startResult.helperGeneration);
        captureClockOriginNs = startResult.monotonicOriginNs;
        captureClockGeneration = startResult.helperGeneration;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (await probeMeetingCaptureClock(sessionId, startResult.recordingId)) break;
        }
        captureClockProbeTimer = setInterval(() => {
          void probeMeetingCaptureClock(sessionId, startResult.recordingId as string);
        }, 500);
      }
      const nextEpoch = (source: "mic" | "system") => captureEpochIndices[source]++;
      const createCapturePipeline = (
        stream: MediaStream,
        context: AudioContext,
        source: "mic" | "system",
        holdMicGate = false
      ) => {
        const clockSync = captureClockSync;
        const clockOriginNs = captureClockOriginNs;
        let renderOrigin = captureRendererOrigins[source];
        if (renderOrigin && renderOrigin.context !== context) renderOrigin = undefined;
        if (!renderOrigin) {
          renderOrigin = { context, frame: Math.round(context.currentTime * context.sampleRate) };
          captureRendererOrigins[source] = renderOrigin;
        }
        const localOriginFrame = renderOrigin.frame;
        const sourceGeneration = captureSourceGenerations[source];
        return createAudioPipeline({
          stream,
          context,
          source,
          sessionId,
          epochIndex: nextEpoch(source),
          renderOriginFrame: localOriginFrame,
          sourceGeneration,
          gateClosed: source === "mic" && (holdMicGate || useMeetingRecordingStore.getState().manualMicMuted || useMeetingRecordingStore.getState().platformMicMuted),
          alignmentAtRenderFrame: (frame) => {
            if (!clockSync || !clockOriginNs) return null;
            try {
              const anchor = context.getOutputTimestamp();
              if (anchor.contextTime === undefined || anchor.performanceTime === undefined || !Number.isFinite(anchor.contextTime) || !Number.isFinite(anchor.performanceTime) ||
                  anchor.performanceTime <= 0 || context.state !== "running") return null;
              const sourceNs = Math.round((anchor.performanceTime + (frame / context.sampleRate - anchor.contextTime) * 1000) * 1_000_000).toString();
              const freshness = performanceNs();
              const position = clockSync.frameMappingAt(sourceNs, clockOriginNs, 24_000, freshness);
              if (!position || position.uncertaintyFrames > 600) return null;
              const mapping = position.mapping;
              return {
                sourceGeneration, sourceFrame: frame - localOriginFrame,
                timelineFrame: position.frame, rate: mapping.rate, uncertaintyFrames: position.uncertaintyFrames,
                helperGeneration: mapping.generation, sourceNs, helperNs: mapping.helperEstimateNs,
                sampledSourceStartNs: mapping.sourceStartNs, sampledSourceEndNs: mapping.sourceEndNs,
                freshnessSourceNs: freshness,
              };
            } catch { return null; }
          },
          reserveEpoch: () => nextEpoch(source),
          onAck: (sequence) => {
            captureLastSequences[source] = sequence;
          },
          onFailure: (error) => {
            captureDrainErrorCode ??= error.message.toLowerCase().includes("clock")
              ? "audio-clock-unavailable"
              : "capture-write-failed";
            logger.error("Meeting capture failed", {
              source,
              reason: error.message,
              lastAckSequence: captureLastSequences[source],
              recordingId: useMeetingRecordingStore.getState().recordingId,
            }, "meeting-capture");
            reportMeetingError(error.message, { captureErrorCode: captureDrainErrorCode });
            if (isRecordingFlag) void stopRecording(sessionId);
          },
        });
      };

      let micPipelinePromise: Promise<void> | null = null;
      if (micResult) {
        micStream = micResult;
        setupMicResult = null;
        if (micResult.getAudioTracks()[0]?.muted) {
          deviceMicMuted = true;
          requestedPlatformMicMuted = true;
          useMeetingRecordingStore.setState({ platformMicMuted: true });
        }
        const ctx = createMeetingCaptureAudioContext();
        micContext = ctx;
        if (!isCurrentStart()) {
          await teardownStart();
          return;
        }

        micPipelinePromise = createCapturePipeline(micResult, ctx, "mic").then(async ({ source, processor }) => {
          if (!isCurrentStart()) {
            source.disconnect();
            await flushAndDisconnectProcessor(processor);
            return;
          }
          micSource = source;
          micProcessor = processor;

          // AnalyserNode must reach the destination for Chrome's pull-based
          // renderer to update its internal buffer; route through a muted gain.
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0.4;
          const analyserSink = ctx.createGain();
          analyserSink.gain.value = 0;
          processor.connect(analyser);
          analyser.connect(analyserSink);
          analyserSink.connect(ctx.destination);
          micAnalyser = analyser;
          if (useMeetingRecordingStore.getState().platformMicMuted) {
            if (!await queueMicIntent(useMeetingRecordingStore.getState().manualMicMuted, true)) {
              throw new Error("Platform microphone mute was not acknowledged");
            }
          }

          const micTrack = micResult.getAudioTracks()[0];
          useMeetingRecordingStore.setState({ micCaptureDeviceLabel: micTrack?.label?.trim() || null });
          logger.info(
            "Mic capture started for meeting transcription",
            {
              label: micTrack?.label,
              settings: micTrack?.getSettings(),
            },
            "meeting"
          );
        });
      }

      if (micPipelinePromise) {
        await micPipelinePromise;
        if (!isCurrentStart()) {
          await teardownStart();
          return;
        }
        micRecovery = new ActiveMicRecoveryController({
          mediaDevices: navigator.mediaDevices,
          onPlatformMuteChange: (deviceMuted) => {
            if (activeRecordingSessionId !== sessionId) return;
            deviceMicMuted = deviceMuted;
            const muted = deviceMicMuted || meetMicMuted;
            const previousPlatformMute = useMeetingRecordingStore.getState().platformMicMuted;
            useMeetingRecordingStore.setState({ platformMicMuted: muted });
            requestedPlatformMicMuted = muted;
            const manualMuted = requestedManualMicMuted;
            micRecovery?.setIntentionalMute(manualMuted || muted);
            if (previousPlatformMute !== muted && micProcessor) void setPlatformMicMuted(muted);
          },
          acquire: async (reason) => {
            try {
              return await navigator.mediaDevices.getUserMedia(
                await getMeetingMicConstraints(
                  reason === "devicechange" || reason === "devicechange-ended"
                )
              );
            } catch {
              return navigator.mediaDevices.getUserMedia({
                audio: MEETING_MIC_PRIMARY_AUDIO_CONSTRAINTS,
              });
            }
          },
          onStatusChange: (status) => {
            if (activeRecordingSessionId !== sessionId) return;
            useMeetingRecordingStore.setState({
              micCaptureStatus: status,
              ...(status === "active" ? {} : { currentAudioLevel: 0 }),
            });
            if (status === "unavailable") {
              captureDrainErrorCode ??= "mic-source-unavailable";
              useMeetingRecordingStore.setState({ captureErrorCode: captureDrainErrorCode });
            }
          },
          onRecovered: async (replacement, previous) => {
            if (
              !isRecordingFlag ||
              activeRecordingSessionId !== sessionId ||
              !micContext ||
              !micProcessor
            ) {
              throw new Error("Meeting recording is no longer active");
            }
            const previousProcessor = micProcessor;
            const context = micContext;
            const lastSequence = await flushAndDisconnectProcessor(previousProcessor);
            if (!isRecordingFlag || activeRecordingSessionId !== sessionId || micContext !== context) {
              throw new Error("Meeting recording stopped while switching microphones");
            }
            captureLastSequences.mic = lastSequence;
            micSource?.disconnect();
            captureSourceGenerations.mic += 1;
            const nextPipeline = await createCapturePipeline(replacement, context, "mic", true);
            if (!isRecordingFlag || activeRecordingSessionId !== sessionId || micContext !== context) {
              nextPipeline.source.disconnect();
              await flushAndDisconnectProcessor(nextPipeline.processor);
              throw new Error("Meeting recording stopped while switching microphones");
            }
            const nextSource = nextPipeline.source;
            micProcessor = nextPipeline.processor;
            if (micAnalyser) nextSource.connect(micAnalyser);
            previous?.getTracks().forEach((track) => track.stop());
            micSource = nextSource;
            micStream = replacement;
            if (!await queueMicIntent(requestedManualMicMuted, requestedPlatformMicMuted)) {
              throw new Error("Recovered microphone intent was not acknowledged");
            }
            useMeetingRecordingStore.setState({ micCaptureDeviceLabel: replacement.getAudioTracks()[0]?.label?.trim() || null });
            logger.info("Meeting microphone capture recovered", {}, "meeting");
          },
        });
        // The recovery callback always supplies a fresh replacement stream.
        micRecovery.setIntentionalMute(
          useMeetingRecordingStore.getState().manualMicMuted || useMeetingRecordingStore.getState().platformMicMuted
        );
        await micRecovery.start(micStream as MediaStream, {
          followDefault: followsSystemDefaultMic(getSettings()),
        });
        if (!isCurrentStart()) {
          await teardownStart();
          return;
        }
      }

      // Build the renderer-side graph only for a selected renderer capture source.
      const attachRendererSystemAudio = async (stream: MediaStream) => {
        systemStream = stream;
        const systemTrack = stream.getAudioTracks()[0];
        const onSystemTrackEnded = () => {
          if (!isRecordingFlag || activeRecordingSessionId !== sessionId) return;
          captureDrainErrorCode ??= "system-source-unavailable";
          useMeetingRecordingStore.setState({
            systemCaptureStatus: "unavailable",
            captureErrorCode: captureDrainErrorCode,
          });
          void stopRecording(sessionId);
        };
        systemTrack?.addEventListener("ended", onSystemTrackEnded, { once: true });
        ipcCleanups.push(() => systemTrack?.removeEventListener("ended", onSystemTrackEnded));
        const ctx = createMeetingCaptureAudioContext();
        systemContext = ctx;
        const { source, processor } = await createCapturePipeline(stream, ctx, "system");
        systemSource = source;
        systemProcessor = processor;
      };

      if (systemCaptureResult.stream) {
        setupSystemCaptureResult = { stream: null, error: null };
        await attachRendererSystemAudio(systemCaptureResult.stream);
        if (!isCurrentStart()) {
          await teardownStart();
          return;
        }
      }

      if (!isCurrentStart()) {
        logger.info(
          "Meeting transcription aborted during pipeline setup (stop called)",
          {},
          "meeting"
        );
        await teardownStart();
        return;
      }

      const systemAudioAvailable = systemAudioHandledInMain || systemStream !== null;
      sessionSystemAudioActive = systemAudioAvailable;
      const captureErrorCode = !micResult
        ? "mic-source-unavailable"
        : systemAudioAvailable
          ? null
          : "system-source-unavailable";
      useMeetingRecordingStore.setState({
        micCaptureStatus: micResult ? "active" : "unavailable",
        systemCaptureStatus: systemAudioAvailable ? "active" : "unavailable",
        captureErrorCode,
      });
      if (captureErrorCode) captureDrainErrorCode = captureErrorCode;
      systemAudioAvailabilityResolved = true;
      if (systemAudioAvailable && pendingSystemAudioInterruption) {
        publishSystemAudioInterruption(pendingSystemAudioInterruption);
      }
      pendingSystemAudioInterruption = null;
      try {
        const availabilityResult =
          await window.electronAPI?.meetingTranscriptionSetSystemAudioAvailable?.(
            sessionId,
            systemAudioAvailable
          );
        if (availabilityResult && !availabilityResult.success) {
          logger.warn(
            "Meeting auto-end system-audio confirmation was rejected",
            { sessionId, reason: availabilityResult.reason },
            "meeting"
          );
        }
      } catch (error) {
        // Recording remains usable; auto-end stays disabled for this session.
        logger.warn(
          "Meeting auto-end system-audio confirmation failed",
          { sessionId, error: (error as Error).message },
          "meeting"
        );
      }

      if (!isCurrentStart()) {
        await teardownStart();
        return;
      }

      startOperation.markCommitted();
      started = true;
      isStartingFlag = false;
      const recovery = micRecovery;
      let outputLookup = 0;
      const refreshOutputDevice = async () => {
        const lookup = ++outputLookup;
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          if (activeRecordingSessionId !== sessionId || !isRecordingFlag || lookup !== outputLookup) return;
          const output = devices.find((device) => device.kind === "audiooutput" && device.deviceId === "default");
          useMeetingRecordingStore.setState({ systemAudioOutputDeviceLabel: output?.label?.trim() || null });
        } catch {
          if (activeRecordingSessionId === sessionId && lookup === outputLookup) {
            useMeetingRecordingStore.setState({ systemAudioOutputDeviceLabel: null });
          }
        }
      };
      void refreshOutputDevice();
      navigator.mediaDevices?.addEventListener?.("devicechange", refreshOutputDevice);
      ipcCleanups.push(() => {
        outputLookup += 1;
        navigator.mediaDevices?.removeEventListener?.("devicechange", refreshOutputDevice);
      });
      if (recovery) ipcCleanups.push(useSettingsStore.subscribe((settings, previousSettings) => {
        if (activeRecordingSessionId !== sessionId || !isRecordingFlag) return;
        if (
          settings.microphoneSelectionMode === previousSettings.microphoneSelectionMode &&
          settings.selectedMicDeviceId === previousSettings.selectedMicDeviceId &&
          settings.preferBuiltInMic === previousSettings.preferBuiltInMic
        ) return;
        void recovery.changeSelection(followsSystemDefaultMic(settings));
      }));
      useMeetingRecordingStore.setState({
        isRecording: true,
        isTranscribing: false,
        capturePhase: "recording",
        recordingId: startResult.recordingId,
        captureStartedAt: recordingOrigin,
      });

      const totalMs = performance.now() - startTime;
      logger.info(
        "Meeting transcription started successfully",
        {
          systemAudioMode,
          systemAudioStrategy,
          streamsMs: Math.round(streamsMs),
          totalMs: Math.round(totalMs),
          wasPrepared: isPrepared,
        },
        "meeting"
      );
    } catch (err) {
      logger.error(
        "Meeting transcription setup failed",
        { error: (err as Error).message },
        "meeting"
      );
      reportMeetingError((err as Error).message, { isRecording: false, isTranscribing: false });
      isRecordingFlag = false;
      isStartingFlag = false;
      await teardownStart();
      useMeetingRecordingStore.setState({
        capturePhase: "failed",
        captureErrorCode: "capture-start-failed",
      });
    }
  });
  return started;
}

export interface StopRecordingResult {
  diarizationSessionId: string | null;
  // True only when this call ended a live recording — false for a no-op stop
  // (nothing recording, or a scoped stop for a session that is not active).
  stopped: boolean;
}

export async function stopRecording(
  expectedSessionId?: string,
  options: { suppressProcessing?: boolean; pause?: boolean } = {}
): Promise<StopRecordingResult> {
  const canceledStart = meetingRecordingStartCoordinator.cancelActiveStart(expectedSessionId);
  if (canceledStart) {
    suppressInitialProcessingForStop = options.suppressProcessing === true;
    isRecordingFlag = false;
    isStartingFlag = false;
    useMeetingRecordingStore.setState({
      isRecording: false,
      isTranscribing: false,
      capturePhase: "saving",
    });
    await canceledStart;
    suppressInitialProcessingForStop = false;
    useMeetingRecordingStore.setState({
      micPartial: "",
      systemPartial: "",
      systemPartialSpeakerId: null,
      systemPartialSpeakerName: null,
      systemAudioSilentWarning: false,
      systemAudioInterrupted: null,
      currentAudioLevel: 0,
    });
    return { diarizationSessionId: null, stopped: false };
  }

  await meetingRecordingStopBarrier.waitForPendingStop();
  if (!canStopMeetingRecordingSession(activeRecordingSessionId, expectedSessionId) || !isRecordingFlag) {
    return { diarizationSessionId: null, stopped: false };
  }

  return meetingRecordingStopBarrier.runStop(async () => {
    if (!canStopMeetingRecordingSession(activeRecordingSessionId, expectedSessionId) || !isRecordingFlag) {
      return { diarizationSessionId: null, stopped: false };
    }

    const sessionId = activeRecordingSessionId;
    if (!sessionId) return { diarizationSessionId: null, stopped: false };
    micIntentClosing = true;
    await micIntentQueue;
    useMeetingRecordingStore.setState({
      isRecording: false,
      isTranscribing: false,
      capturePhase: "saving",
    });
    isRecordingFlag = false;
    isStartingFlag = false;

    // Stop accepts no new samples after cleanup has drained and disconnected both
    // capture graphs. Main closes native stdout and the file writers before finalize.
    await cleanup();
    activeRecordingSessionId = null;

    let stopped = false;
    let finalErrorCode = captureDrainErrorCode;
    try {
      const result = await window.electronAPI?.meetingTranscriptionStop?.({
        sessionId,
        lastSequence: captureLastSequences,
        microphoneBoundary: captureMicrophoneBoundary,
        incomplete: finalErrorCode !== null,
        suppressProcessing: options.suppressProcessing === true,
        pause: options.pause === true,
        ...(finalErrorCode ? { errorCode: finalErrorCode } : {}),
      });
      if (result?.success) {
        stopped = true;
        finalErrorCode = result.errorCode ?? finalErrorCode;
        useMeetingRecordingStore.setState({
          recordingId: result.recordingId ?? useMeetingRecordingStore.getState().recordingId,
          capturePhase: result.captureState === "ready" ? "saved" : "incomplete",
          captureErrorCode: finalErrorCode,
        });
      } else {
        finalErrorCode = result?.error ? "capture-finalize-failed" : "capture-stop-failed";
        reportMeetingError(result?.error ?? "Meeting recording could not be finalized", {
          capturePhase: "incomplete",
          captureErrorCode: finalErrorCode,
        });
      }
    } catch (error) {
      finalErrorCode = "capture-finalize-failed";
      reportMeetingError((error as Error).message, {
        capturePhase: "incomplete",
        captureErrorCode: finalErrorCode,
      });
      logger.error("Meeting capture stop failed", {
        error: (error as Error).message,
        recordingId: useMeetingRecordingStore.getState().recordingId,
      }, "meeting");
    }

    useMeetingRecordingStore.setState({
      micPartial: "",
      systemPartial: "",
      systemPartialSpeakerId: null,
      systemPartialSpeakerName: null,
      systemAudioSilentWarning: false,
      systemAudioInterrupted: null,
      currentAudioLevel: 0,
      ...(options.suppressProcessing ? {} : { manualMicMuted: false }),
      platformMicMuted: false,
    });
    ipcCleanups.forEach((cleanupListener) => cleanupListener());
    ipcCleanups = [];
    if (pushConfigTimeout) {
      clearTimeout(pushConfigTimeout);
      pushConfigTimeout = null;
    }
    isPrepared = false;
    sessionSystemAudioActive = false;

    logger.info("Meeting recording stopped", {
      capturePhase: useMeetingRecordingStore.getState().capturePhase,
      errorCode: finalErrorCode,
    }, "meeting");
    return { diarizationSessionId: null, stopped };
  });
}

export async function pauseMeeting(): Promise<boolean> {
  const state = useMeetingRecordingStore.getState();
  if (!state.isRecording || !state.meetingGroupId || !state.recordingNoteId) return false;
  localStorage.setItem(PAUSED_MEETING_KEY, JSON.stringify({
    groupId: state.meetingGroupId,
    noteId: state.recordingNoteId,
    manualMicMuted: state.manualMicMuted,
    restartSessionId: activeRecordingSessionId,
  }));
  const result = await stopRecording(undefined, { suppressProcessing: true, pause: true });
  if (!result.stopped) {
    localStorage.removeItem(PAUSED_MEETING_KEY);
    return false;
  }
  useMeetingRecordingStore.setState({ capturePhase: "paused", meetingGroupId: state.meetingGroupId, recordingNoteId: state.recordingNoteId });
  return true;
}

export async function resumeMeeting(args: StartRecordingArgs): Promise<boolean> {
  const paused = readPausedMeeting();
  if (!paused || paused.noteId !== args.noteId || useMeetingRecordingStore.getState().capturePhase !== "paused") return false;
  const recordings = await window.electronAPI.meetingProcessingListForNote(paused.noteId);
  if (!recordings.success || !recordings.recordings?.some((item) => item.recording.groupId === paused.groupId && item.recording.audioState === "available")) {
    localStorage.removeItem(PAUSED_MEETING_KEY);
    useMeetingRecordingStore.setState({ capturePhase: "saved", meetingGroupId: null });
    return false;
  }
  const started = await startRecording({ ...args, groupId: paused.groupId, manualMicMuted: paused.manualMicMuted, restartSessionId: paused.restartSessionId });
  if (started) localStorage.removeItem(PAUSED_MEETING_KEY);
  else useMeetingRecordingStore.setState({ capturePhase: "paused", meetingGroupId: paused.groupId, recordingNoteId: paused.noteId });
  return started;
}

export async function queueMeetingNoteProcessing(noteId: number): Promise<void> {
  const listed = await window.electronAPI.meetingProcessingListForNote(noteId);
  if (!listed.success) throw new Error(listed.error || "Meeting parts could not be loaded");
  const parts = (listed.recordings ?? [])
    .filter((item) => item.recording.audioState === "available" && ["ready", "incomplete"].includes(item.recording.captureState))
    .sort((a, b) => a.recording.startedAt.localeCompare(b.recording.startedAt));
  const usable = parts.filter((part) => part.runs.some((result) => result.run.errorCode !== "recording-audio-unavailable"));
  if (!usable.length) return;
  const sourceIds = usable.map((part) => part.recording.id);
  const existing = usable.flatMap((part) => part.runs).find((result) =>
    result.run.kind === "reprocess" && result.run.sourceRecordingIds.length === sourceIds.length &&
    result.run.status !== "cancelled" &&
    result.run.sourceRecordingIds.every((id, index) => id === sourceIds[index])
  );
  if (existing) return;
  const first = usable[0];
  const initial = usable.at(-1)?.runs.find((result) => result.run.kind === "initial");
  const created = await window.electronAPI.meetingProcessingCreateRun({
    recordingId: first.recording.id,
    sourceRecordingIds: sourceIds,
    kind: "reprocess",
    gateAfterStop: true,
    config: initial?.run.config ?? null,
    configError: initial?.run.configError ?? null,
  });
  if (!created.success) throw new Error(created.error || "Meeting processing could not start");
}

export async function finishMeeting(): Promise<boolean> {
  const state = useMeetingRecordingStore.getState();
  const groupId = state.meetingGroupId;
  const noteId = state.recordingNoteId;
  if (!groupId || !noteId || (state.capturePhase !== "paused" && !state.isRecording)) return false;
  localStorage.setItem(PAUSED_MEETING_KEY, JSON.stringify({ groupId, noteId, manualMicMuted: state.manualMicMuted }));
  if (state.isRecording && !(await stopRecording(undefined, { suppressProcessing: true })).stopped) return false;
  try {
    await queueMeetingNoteProcessing(noteId);
  } catch (error) {
    localStorage.setItem(PAUSED_MEETING_KEY, JSON.stringify({ groupId, noteId, manualMicMuted: state.manualMicMuted }));
    useMeetingRecordingStore.setState({ capturePhase: "paused", meetingGroupId: groupId, recordingNoteId: noteId });
    reportMeetingError(error instanceof Error ? error.message : String(error));
    return false;
  }
  if (state.capturePhase === "paused" && state.recordingId) await window.electronAPI?.finishPausedMeetRecording?.(state.recordingId);
  localStorage.removeItem(PAUSED_MEETING_KEY);
  useMeetingRecordingStore.setState({ capturePhase: "saved", meetingGroupId: null });
  return true;
}

export function lockSpeaker(speakerId: string, displayName: string): void {
  if (!speakerId || !displayName) return;
  const next = useMeetingRecordingStore.getState().segments.map((s) =>
    s.speaker === speakerId
      ? lockTranscriptSpeaker(s, {
          speakerName: displayName,
          speakerIsPlaceholder: false,
          suggestedName: undefined,
          suggestedProfileId: undefined,
        })
      : s
  );
  useMeetingRecordingStore.setState({ segments: next });
}

export function cancelPreparedTranscription(): void {
  window.electronAPI?.meetingTranscriptionCancel?.();
}

// Persists delayed diarization results to the note that owns the recording
// session (#1495). Registered once at module load so results survive the
// notes view unmounting; NoteEditor only mirrors `completedDiarization`.
if (typeof window !== "undefined") {
  // Serialized so rapid re-record completions can't interleave around the
  // getNote await and overwrite each other's speaker labels — the later
  // result merges on top of the earlier one's persisted transcript.
  const enqueueDiarizationCompletion = createSerialQueue();
  window.electronAPI?.onMeetingDiarizationComplete?.((data) => {
    enqueueDiarizationCompletion(async () => {
      const {
        diarizationSessionId,
        isRecording,
        recordingNoteId,
        segments: liveSegments,
      } = useMeetingRecordingStore.getState();
      const { targetNoteId, isCurrentSession } = resolveDiarizationTarget({
        payloadNoteId: data?.noteId,
        payloadSessionId: data?.sessionId,
        currentSessionId: diarizationSessionId,
        activeRecordingNoteId: isRecording ? recordingNoteId : null,
      });
      if (targetNoteId == null) return;

      // Publishing an empty result clears a waiting editor's spinner without
      // painting an overlay; anything non-empty is already persisted.
      const publish = (segments: TranscriptSegment[]) => {
        if (isCurrentSession) {
          useMeetingRecordingStore.setState({
            completedDiarization: { noteId: targetNoteId, segments },
          });
        }
      };

      if (!data?.segments?.length) {
        publish([]);
        return;
      }

      let persisted: NoteItem | null | undefined;
      try {
        persisted = await window.electronAPI?.getNote?.(targetNoteId);
      } catch (error) {
        logger.error(
          "Diarization completion could not read its note",
          { noteId: targetNoteId, error: (error as Error).message },
          "meeting"
        );
      }
      // No note means no safe base to merge into; a deleted note reads back
      // as null, so it can't be written behind the user's back either.
      if (!persisted) {
        publish([]);
        return;
      }

      const existing = selectBaseSegments({
        persistedSegments: persisted.transcript
          ? parseTranscriptSegments(persisted.transcript)
          : null,
        liveSegments,
        recordingNoteId,
        targetNoteId,
      });
      const enriched = mergeTranscriptSegments(
        existing,
        data.segments.map((segment, index) => ({
          ...segment,
          id: segment.id || `diarized-${index}`,
        }))
      );

      try {
        // Awaited so the next queued completion's getNote is guaranteed to
        // read this write — without it the ordering depends on db-update-note
        // staying synchronous ahead of its first await.
        await window.electronAPI?.updateNote?.(targetNoteId, {
          transcript: serializeTranscriptSegments(enriched),
        });
      } catch (error) {
        publish([]);
        throw error;
      }
      publish(enriched);

      if (data.speakerEmbeddings) {
        await window.electronAPI?.saveNoteSpeakerEmbeddings?.(targetNoteId, data.speakerEmbeddings);
      }
    }).catch((error) => {
      logger.error(
        "Diarization completion handling failed",
        { error: (error as Error).message },
        "meeting"
      );
    });
  });
}

// Throttled resize listener — keeps layout reflows during drag from thrashing
// React. Registered once at module load; the store outlives any view.
if (typeof window !== "undefined") {
  let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener("resize", () => {
    if (resizeTimeout) return;
    resizeTimeout = setTimeout(() => {
      resizeTimeout = null;
      useMeetingRecordingStore.setState({ windowWidth: window.innerWidth });
    }, 60);
  });
}

export function useIsNarrowWindow(): boolean {
  const windowWidth = useMeetingRecordingStore((s) => s.windowWidth);
  return windowWidth < SIDE_PANEL_BREAKPOINT_PX;
}

export function useIsMeetingMode(): boolean {
  const isRecording = useMeetingRecordingStore((s) => s.isRecording);
  const isNarrow = useIsNarrowWindow();
  return isRecording && isNarrow;
}
