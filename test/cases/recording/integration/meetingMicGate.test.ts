const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { MeetingCaptureSession }: typeof import("../../../../src/helpers/meetingCaptureSession.ts") = require("../../../../src/helpers/meetingCaptureSession.ts");
const { createRendererServer, installBrowserGlobals, installMicCaptureGlobals } = require("../../../lib/rendererTestHarness.ts") as typeof import("../../../lib/rendererTestHarness.js");

function captureHarness(delayMicClose = false) {
  const intervals: Array<{ recordingId: string; source: string; startFrame: number; endFrame: number | null; reason: string }> = [];
  const writes: Array<{ source: string; epoch: number; bytes: number }> = [];
  const database = {
    createMeetingRecording: () => ({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    createMeetingRecordingEpoch() {},
    addMeetingRecordingEpochAlignment() {},
    markMeetingRecordingEpochAlignmentUnknown() {},
    updateMeetingRecordingEpochRecovery() {},
    markMeetingRecordingFinalizing() {},
    finalizeMeetingRecording: (_id: string, input: { captureState: "ready" | "incomplete" }) => ({
      recording: { captureState: input.captureState }, initialRun: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    }),
    openMeetingIntentionalInterval: (recordingId: string, source: string, sourceGeneration: number, startFrame: number, reason: string) => {
      const interval = { recordingId, source, startFrame, endFrame: null, reason };
      intervals.push(interval);
      return interval;
    },
    closeMeetingIntentionalInterval: (recordingId: string, source: string, sourceGeneration: number, endFrame: number, reason: string) => {
      const interval = [...intervals].reverse().find((item) => item.recordingId === recordingId && item.source === source && item.reason === reason && item.endFrame === null);
      if (!interval) return null;
      interval.endFrame = endFrame;
      return interval;
    },
    listMeetingIntentionalIntervals: (recordingId: string) => intervals.filter((item) => item.recordingId === recordingId),
  };
  let releaseClose: (() => void) | null = null;
  let signalCloseStarted: (() => void) | null = null;
  const closeStarted = new Promise<void>((resolve) => { signalCloseStarted = resolve; });
  const storage = {
    openEpochWriter() {},
    appendEpochSamples: (recordingId: string, source: string, epoch: number, samples: Buffer) => writes.push({ source, epoch, bytes: samples.length }),
    closeEpochWriter: (_recordingId: string, source: string) => {
      if (source !== "mic" || !delayMicClose) return Promise.resolve();
      signalCloseStarted?.();
      return new Promise<void>((resolve) => { releaseClose = resolve; });
    },
    recoverEpoch: (_id: string, _source: string, _epoch: number) => ({ frameCount: 2_400, ignoredTrailingBytes: 0, errorCode: null }),
  };
  return { capture: MeetingCaptureSession.create(database as any, storage as any, 1, null, new Date("2026-10-01T00:00:00Z"), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), intervals, writes, waitForClose: () => closeStarted, releaseClose: () => releaseClose?.() };
}

const packet = (epochIndex: number, epochStartFrame: number, frameStart: number, sequence: number, sampleOffset: number, sourceGeneration = 1) => ({
  epochIndex, epochSourceStartFrame: epochStartFrame, sourceFrameStart: frameStart, sourceGeneration, sequence, sampleOffset, alignment: null, alignmentErrorCode: "clock-unavailable",
});

test("manual and platform mute intent persist exact frame boundaries and reject stale writes", async () => {
  const { capture, intervals, writes } = captureHarness();
  capture.appendRendererSamples("mic", packet(0, 0, 0, 0, 0), Buffer.alloc(4_800));
  capture.appendNativeSamples("system", 1, Buffer.alloc(4_800), 0, 0);

  assert.deepEqual(await capture.setMicIntent({ boundaryAlignment: null, sequence: 1, sourceGeneration: 1, manualMuted: true, platformMuted: false, boundaryFrame: 2_400 }), {
    sequence: 1, sourceGeneration: 1, effectiveMuted: true, boundaryFrame: 2_400,
  });
  await assert.rejects(capture.setMicIntent({ boundaryAlignment: null, sequence: 1, sourceGeneration: 1, manualMuted: false, platformMuted: false, boundaryFrame: 2_400 }), /Stale/);
  assert.throws(() => capture.appendRendererSamples("mic", packet(1, 2_400, 2_400, 0, 0), Buffer.alloc(4_800)), /active intent generation/);

  await capture.setMicIntent({ boundaryAlignment: null, sequence: 2, sourceGeneration: 1, manualMuted: true, platformMuted: true, boundaryFrame: 2_400 });
  await capture.setMicIntent({ boundaryAlignment: null, sequence: 3, sourceGeneration: 1, manualMuted: false, platformMuted: true, boundaryFrame: 4_800 });
  await capture.setMicIntent({ boundaryAlignment: null, sequence: 4, sourceGeneration: 1, manualMuted: false, platformMuted: false, boundaryFrame: 4_800 });
  capture.appendRendererSamples("mic", packet(1, 4_800, 4_800, 0, 0), Buffer.alloc(4_800));
  capture.appendNativeSamples("system", 1, Buffer.alloc(9_600), 2_400, 2_400);

  assert.deepEqual(intervals.map(({ reason, startFrame, endFrame }) => [reason, startFrame, endFrame]), [
    ["manual-muted", 2_400, 4_800],
    ["platform-muted", 2_400, 4_800],
  ]);
  assert.deepEqual(writes.filter((item) => item.source === "mic").map((item) => item.bytes), [4_800, 4_800]);
  assert.equal((await capture.stop({ lastSequence: { mic: 0 } })).captureState, "ready");
});

test("Stop waits for an in-flight mic boundary commit and rejects later controls", async () => {
  const { capture, waitForClose, releaseClose, intervals } = captureHarness(true);
  capture.appendRendererSamples("mic", packet(0, 0, 0, 0, 0), Buffer.alloc(4_800));
  capture.appendNativeSamples("system", 1, Buffer.alloc(4_800), 0, 0);
  const transition = capture.setMicIntent({ boundaryAlignment: null, sequence: 1, sourceGeneration: 1, manualMuted: true, platformMuted: false, boundaryFrame: 2_400 });
  await waitForClose();
  const stopping = capture.stop({ lastSequence: { mic: 0 } });
  releaseClose();
  await transition;
  await assert.rejects(capture.setMicIntent({ boundaryAlignment: null, sequence: 2, sourceGeneration: 1, manualMuted: false, platformMuted: false, boundaryFrame: 2_400 }), /stopping/);
  const result = await stopping;
  assert.equal(result.captureState, "ready");
  assert.equal(intervals[0].endFrame, 2_400);
});

test("renderer gate holds the healthy device and keeps frame origin across recovery", async (t: import("node:test").TestContext) => {
  installMicCaptureGlobals(t);
  let currentRenderFrame = 50_400;
  const audioContextOriginFrame = 48_000;
  const tracks: Array<{ readyState: string; muted: boolean; label: string; getSettings(): { deviceId: string }; stop(): void; addEventListener(type: string, listener: () => void): void; removeEventListener(type: string, listener: () => void): void; dispatch(type: string): void; stopCount: number }> = [];
  let acquired = 0;
  const mediaDevices = navigator.mediaDevices as unknown as {
    getUserMedia: (constraints: unknown) => Promise<MediaStream>;
    enumerateDevices: () => Promise<MediaDeviceInfo[]>;
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
  };
  mediaDevices.enumerateDevices = async () => [{ kind: "audioinput", deviceId: "mic-1", groupId: "mic-1", label: "Mic" } as MediaDeviceInfo];
  mediaDevices.addEventListener = () => {};
  mediaDevices.removeEventListener = () => {};
  mediaDevices.getUserMedia = async () => {
    acquired += 1;
    const listeners = new Map<string, Set<() => void>>();
    const track = {
      readyState: "live",
      muted: false,
      label: `mic-${acquired}`,
      stopCount: 0,
      getSettings: () => ({ deviceId: "mic-1" }),
      stop() { this.stopCount += 1; this.readyState = "ended"; },
      addEventListener(type: string, listener: () => void) {
        const handlers = listeners.get(type) ?? new Set();
        handlers.add(listener);
        listeners.set(type, handlers);
      },
      removeEventListener(type: string, listener: () => void) { listeners.get(type)?.delete(listener); },
      dispatch(type: string) { listeners.get(type)?.forEach((listener) => listener()); },
    };
    tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  };

  class FakeAudioContext {
    state = "running";
    sampleRate = 24_000;
    currentTime = audioContextOriginFrame / this.sampleRate;
    audioWorklet = { addModule: async () => {} };
    destination = {};
    constructor() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
    createAnalyser() { return { fftSize: 0, smoothingTimeConstant: 0, connect() {}, disconnect() {} }; }
    async resume() {}
    async close() {}
  }
  const processors: FakeAudioWorkletNode[] = [];
  class FakeAudioWorkletNode {
    port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage(message: unknown): void };
    constructor() {
      processors.push(this);
      this.port = {
        onmessage: null,
        postMessage: (message) => {
          const request = message as { type?: string; commandId?: string; sourceGeneration?: number; effectiveMuted?: boolean };
          if (request.type === "set-gate") queueMicrotask(() => this.port.onmessage?.({ data: {
            type: "gate-ack", commandId: request.commandId, sourceGeneration: request.sourceGeneration,
            effectiveMuted: request.effectiveMuted, boundaryRenderFrame: currentRenderFrame, lastSequence: -1,
          } }));
          if (request.type === "flush") queueMicrotask(() => this.port.onmessage?.({ data: { type: "flush-complete", lastSequence: -1, boundaryRenderFrame: currentRenderFrame } }));
        },
      };
    }
    connect() {}
    disconnect() {}
  }
  const globals = globalThis as Record<string, unknown>;
  const originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  const originalAudioWorkletNode = Object.getOwnPropertyDescriptor(globalThis, "AudioWorkletNode");
  globals.AudioContext = FakeAudioContext;
  globals.AudioWorkletNode = FakeAudioWorkletNode;
  t.after(() => {
    if (originalAudioContext) Object.defineProperty(globalThis, "AudioContext", originalAudioContext);
    else delete globals.AudioContext;
    if (originalAudioWorkletNode) Object.defineProperty(globalThis, "AudioWorkletNode", originalAudioWorkletNode);
    else delete globals.AudioWorkletNode;
  });

  const sentSequences: number[] = [];
  const intentRequests: Array<{ sequence: number; boundaryFrame: number; sourceGeneration: number; effectiveMuted: boolean }> = [];
  let resolveRecoveryIntent: (() => void) | null = null;
  const recoveryIntent = new Promise<void>((resolve) => { resolveRecoveryIntent = resolve; });
  const noopListener = () => () => {};
  installBrowserGlobals(t, { window: { electronAPI: {
    checkSystemAudioAccess: async () => ({ granted: false, status: "unsupported", mode: "unsupported", strategy: "unsupported" }),
    meetingTranscriptionStart: async () => ({
      success: true, recordingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      originAt: "2026-10-01T00:00:00.000Z", systemAudioMode: "unsupported", systemAudioStrategy: "unsupported",
    }),
    meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
    meetingTranscriptionSetMicIntent: async (request: { sequence: number; boundaryFrame: number; sourceGeneration: number; manualMuted: boolean; platformMuted: boolean }) => {
      const effectiveMuted = request.manualMuted || request.platformMuted;
      intentRequests.push({ sequence: request.sequence, boundaryFrame: request.boundaryFrame, sourceGeneration: request.sourceGeneration, effectiveMuted });
      if (request.sourceGeneration > 1) resolveRecoveryIntent?.();
      return { success: true, sequence: request.sequence, boundaryFrame: request.boundaryFrame, sourceGeneration: request.sourceGeneration, effectiveMuted };
    },
    meetingTranscriptionSend: async (_buffer: unknown, _source: unknown, _sessionId: unknown, packet: { sequence: number }) => {
      sentSequences.push(packet.sequence);
      return { success: true, sequence: packet.sequence };
    },
    meetingTranscriptionStop: async () => ({ success: true, captureState: "incomplete" }),
    onMeetingTranscriptionError: noopListener,
    onMeetingTranscriptionFatalError: noopListener,
    onMeetingSystemAudioSilent: noopListener,
    onMeetingSystemAudioInterrupted: noopListener,
    onMeetingSystemAudioResumed: noopListener,
  } } });

  const vite = await createRendererServer(t, { cachePrefix: "gristmill-meeting-mic-gate-store-" });
  const store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts") as typeof import("../../../../src/stores/meetingRecordingStore.js");
  try {
    assert.equal(await store.startRecording({ noteId: 1, noteTitle: "Meeting", folderId: null, autoEndEligible: false }), true);
    assert.equal(acquired, 1);
    processors[0].port.onmessage?.({ data: {
      type: "chunk", buffer: new ArrayBuffer(4_800), sequence: 0, sampleOffset: 0,
      renderStartFrame: audioContextOriginFrame, epochIndex: 0, sourceGeneration: 1,
    } });
    await new Promise(setImmediate);
    assert.deepEqual(sentSequences, [0]);
    assert.equal(await store.setManualMicMuted(true), true);
    assert.equal(tracks[0].stopCount, 0);
    assert.equal(acquired, 1);
    currentRenderFrame = 52_800;
    assert.equal(await store.setManualMicMuted(false), true);
    assert.equal(intentRequests[0].boundaryFrame, 2_400);
    assert.equal(intentRequests[1].boundaryFrame, 4_800);
    assert.equal(acquired, 1);
    assert.equal(tracks[0].stopCount, 0);

    // More than the five-second backlog limit must still reach main after unmute.
    for (let sequence = 0; sequence < 60; sequence++) {
      processors[0].port.onmessage?.({ data: {
        type: "chunk", buffer: new ArrayBuffer(4_800), sequence, sampleOffset: sequence * 2_400,
        renderStartFrame: currentRenderFrame + sequence * 2_400, epochIndex: 1, sourceGeneration: 1,
      } });
      await new Promise(setImmediate);
    }
    assert.deepEqual(sentSequences, [0, ...Array.from({ length: 60 }, (_, index) => index)]);
    assert.equal(store.useMeetingRecordingStore.getState().isRecording, true);

    currentRenderFrame = 240_000;
    tracks[0].readyState = "ended";
    tracks[0].dispatch("ended");
    await recoveryIntent;
    assert.equal(acquired, 2);
    assert.equal(intentRequests[2].sourceGeneration, 2);
    assert.equal(intentRequests[2].boundaryFrame, 192_000, "replacement worklet uses the same AudioContext frame origin");
    assert.equal(tracks[0].stopCount, 1, "old device stops only after its replacement graph is attached");

    await store.stopRecording();
    assert.equal(tracks[1].stopCount, 1, "Stop releases the healthy replacement device");
  } finally {
    await store.stopRecording();
  }
});
