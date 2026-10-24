import {
  MeetingCaptureWriteQueue,
  MAX_UNACKNOWLEDGED_CAPTURE_FRAMES,
  MAX_CAPTURE_ACK_AGE_MS,
} from "./meetingCaptureWriteQueue";
import type {
  MeetingFrameAlignmentPoint,
  MeetingFrameAlignmentSegment,
} from "../contracts/meetingRecording";
import type { MeetingCaptureStopRequest } from "../contracts/meetingCoordinator";

import workletSource from "../worklets/meetingPcmProcessor.js?raw";

const MEETING_AUDIO_BUFFER_SIZE = 2400;

const MEETING_CAPTURE_DRAIN_TIMEOUT_MS = 15000;

// Each processor owns its write queue, frame epochs, gate and drain callbacks.
// The recording store owns contexts, streams, recovery and the session stop barrier.
export const createMeetingCaptureAudioContext = (): AudioContext => {
  const context = new AudioContext({ sampleRate: 24_000 });

  if (context.sampleRate !== 24_000) {
    // Close is fire-and-forget on the failure path; the error rethrows below.
    context.close().catch(() => undefined);
    throw new Error("Meeting capture requires a 24 kHz audio context");
  }

  return context;
};

const getMeetingWorkletBlobUrl = (() => {
  let blobUrl: string | null = null;

  return () => {
    if (blobUrl) return blobUrl;

    const code = workletSource
      .replaceAll("__MEETING_AUDIO_BUFFER_SIZE__", String(MEETING_AUDIO_BUFFER_SIZE))
      .replaceAll("__MAX_UNACKNOWLEDGED_CAPTURE_FRAMES__", String(MAX_UNACKNOWLEDGED_CAPTURE_FRAMES))
      .replaceAll("__MAX_CAPTURE_ACK_AGE_MS__", String(MAX_CAPTURE_ACK_AGE_MS));

    blobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));

    return blobUrl;
  };
})();

export const primeMeetingWorklet = () => {
  getMeetingWorkletBlobUrl();
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
  onMicrophoneBoundary: (
    boundary: NonNullable<MeetingCaptureStopRequest["microphoneBoundary"]>
  ) => void;
  onAck: (sequence: number, epochIndex: number) => void;
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

export const createAudioPipeline = async ({
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
  onMicrophoneBoundary,
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
    packet: {
      epochIndex: number;
      epochSourceStartFrame: number;
      sourceFrameStart: number;
      sourceGeneration: number;
      sequence: number;
      sampleOffset: number;
      alignment: MeetingFrameAlignmentSegment | null;
      alignmentErrorCode: string;
    };
  }>({
    write: async ({ buffer, packet }) => {
      if (gateOpening) await gateOpening;
      const api = window.electronAPI;

      if (!api?.meetingTranscriptionSend)
        throw new Error("Meeting recording bridge is unavailable");
      // SAFETY: the bridge contract returns the ack for the sent packet.
      const ack = await api.meetingTranscriptionSend(buffer, source, sessionId, packet);

      if (!ack.success || ack.sequence !== packet.sequence) {
        throw new Error("Meeting recording write was not acknowledged");
      }

      onAck(packet.sequence, packet.epochIndex);
      processor.port.postMessage({
        type: "ack",
        sequence: packet.sequence,
        epochIndex: packet.epochIndex,
      });
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

  const gateWaiters = new Map<
    string,
    { resolve(ack: MeetingMicGateAck): void; reject(error: Error): void }
  >();

  const checkDrain = () => {
    if (flushSequence === null || !drainPromise) return;
    const sequence = flushSequence;

    // The queue rejects only with Error instances it constructs itself.
    void queue
      .drain()
      .then(() => {
        // SAFETY: flushSequence was non-null at entry and stored above.
        resolveDrain?.(sequence as number);
      })
      .catch((error: Error) => flushReject?.(error));
  };

  processor.port.onmessage = (event) => {
    // SAFETY: the worklet protocol emits only the message union below.
    const message = event.data as
      | MeetingCapturePacketMessage
      | { type: "flush-complete"; lastSequence: number; boundaryRenderFrame: number }
      | { type: "source-gap"; epochIndex: number }
      | {
          type: "gate-ack";
          commandId: string;
          sourceGeneration: number;
          effectiveMuted: boolean;
          boundaryRenderFrame: number;
          lastSequence: number;
        }
      | { type: "error"; code?: string };

    if (message?.type === "source-gap") {
      if (message.epochIndex !== activeEpochIndex + 1) {
        onFailure(new Error("Meeting capture gap has an invalid epoch"));

        return;
      }

      activeEpochIndex = message.epochIndex;
      hasSentInEpoch = false;
    } else if (message?.type === "chunk") {
      const frames = message.buffer.byteLength / 2;

      if (
        !Number.isSafeInteger(message.renderStartFrame) ||
        message.sourceGeneration !== activeSourceGeneration ||
        message.epochIndex !== activeEpochIndex
      ) {
        onFailure(new Error("Meeting capture frame anchor is stale"));

        return;
      }

      const sourceFrameStart = message.renderStartFrame - renderOriginFrame;
      const packetEpochSourceStartFrame = epochStarts.get(message.epochIndex) ?? sourceFrameStart;
      epochStarts.set(message.epochIndex, packetEpochSourceStartFrame);
      const coverageStart = Math.max(packetEpochSourceStartFrame, sourceFrameStart - 4 * 24_000);
      const start = alignmentAtRenderFrame(renderOriginFrame + coverageStart);
      const end = alignmentAtRenderFrame(message.renderStartFrame + frames);

      const alignment: MeetingFrameAlignmentSegment | null =
        start && end && start.helperGeneration === end.helperGeneration
          ? {
              sourceGeneration,
              sourceStartFrame: coverageStart,
              sourceEndFrame: sourceFrameStart + frames,
              timelineStartFrame: start.timelineFrame,
              rate: start.rate,
              uncertaintyStartFrames: start.uncertaintyFrames,
              uncertaintyEndFrames: end.uncertaintyFrames,
              helperGeneration: start.helperGeneration,
              sourceStartNs: start.sourceNs,
              sourceEndNs: end.sourceNs,
              helperStartNs: start.helperNs,
              helperEndNs: end.helperNs,
              sampledSourceStartNs: start.sampledSourceStartNs,
              sampledSourceEndNs: start.sampledSourceEndNs,
              freshnessSourceNs: start.freshnessSourceNs,
            }
          : null;

      const packet = {
        epochIndex: message.epochIndex,
        epochSourceStartFrame: packetEpochSourceStartFrame,
        sourceFrameStart,
        sourceGeneration: message.sourceGeneration,
        sequence: message.sequence,
        sampleOffset: message.sampleOffset,
        alignment,
        alignmentErrorCode: alignment ? "alignment-confirmed" : "clock-unavailable",
      };

      hasSentInEpoch = true;
      void queue.write({ buffer: message.buffer, packet }, frames).catch(() => {});
    } else if (message?.type === "flush-complete") {
      flushSequence = message.lastSequence;

      if (source === "mic")
        onMicrophoneBoundary({
          sourceGeneration,
          sourceFrame: message.boundaryRenderFrame - renderOriginFrame,
          alignment: alignmentAtRenderFrame(message.boundaryRenderFrame),
        });
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
    // Store the resolver for the ordered flush-complete + write-ack barrier;
    // both callbacks are set synchronously by the Promise constructor above.
    // Store the resolver for the ordered flush-complete + write-ack barrier;
    // both callbacks are set synchronously by the Promise constructor above.
    resolveDrain = resolvePromise;
    flushReject = rejectPromise;

    const timeout = window.setTimeout(() => {
      const error = new Error("Meeting audio flush did not complete");
      onFailure(error);
      rejectPromise(error);
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
      gateOpening = new Promise<void>((resolve) => {
        releaseGateOpening = resolve;
      });

      if (hasSentInEpoch) activeEpochIndex = Math.max(activeEpochIndex + 1, reserveEpoch());
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
      type: "set-gate",
      commandId,
      sequence,
      effectiveMuted,
      epochIndex: activeEpochIndex,
      sourceGeneration: activeSourceGeneration,
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

export async function setAudioPipelineGate(
  processor: AudioWorkletNode | null,
  effectiveMuted: boolean,
  sequence: number
): Promise<{ ack: MeetingMicGateAck; commit(): void }> {
  const setGate = processor ? processorGateControls.get(processor) : null;

  if (!setGate) throw new Error("Meeting microphone gate is unavailable");

  return setGate(effectiveMuted, sequence);
}

export const flushAndDisconnectProcessor = async (
  processor: AudioWorkletNode | null
): Promise<number> => {
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
