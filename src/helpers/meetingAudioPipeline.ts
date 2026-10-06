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
      const send = window.electronAPI?.meetingTranscriptionSend;

      if (!send) throw new Error("Meeting recording bridge is unavailable");
      // SAFETY: the bridge contract returns the ack for the sent packet.
      const ack = await send(buffer, source, sessionId, packet);

      if (!ack.success || ack.sequence !== packet.sequence) {
        throw new Error("Meeting recording write was not acknowledged");
      }

      onAck(packet.sequence, packet.epochIndex);
      processor.port.postMessage({ type: "ack", sequence: packet.sequence });
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
      | {
          type: "gate-ack";
          commandId: string;
          sourceGeneration: number;
          effectiveMuted: boolean;
          boundaryRenderFrame: number;
          lastSequence: number;
        }
      | { type: "error"; code?: string };

    if (message?.type === "chunk") {
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
