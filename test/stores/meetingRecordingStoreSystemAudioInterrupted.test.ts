const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness.ts");

type TestContext = import("node:test").TestContext;

interface SystemAudioInterruption {
  systemAudioStrategy: string;
  reason: "no_audio_delivered" | "device_invalidated" | "gone_quiet";
  recovering: boolean;
}

type MeetingStartResult = {
  success: boolean;
  recordingId?: string;
  originAt?: string;
  systemAudioMode?: string;
  systemAudioStrategy?: string;
  error?: string;
};

interface SystemAudioListeners {
  systemAudioInterrupted: ((data: SystemAudioInterruption) => void) | null;
  systemAudioResumed: (() => void) | null;
}

interface MeetingStoreModule {
  useMeetingRecordingStore: {
    getState(): {
      isRecording: boolean;
      systemAudioInterrupted: { recovering: boolean; reason: string } | null;
      systemAudioInterruptedNonce: number;
      micCaptureStatus: string;
    };
  };
  startRecording(args: Record<string, unknown>): Promise<boolean>;
  stopRecording(): Promise<{ stopped: boolean }>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;

  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

let vitePromise: Promise<import("vite").ViteDevServer> | undefined;

const cleanup: Array<() => void | Promise<void>> = [];

test.after(async () => {
  for (const close of cleanup) await close();
});

function getVite() {
  // Reuse one dev server across tests; its TestContext only needs after().
  const fakeContext = {
    after: (close: () => void | Promise<void>) => cleanup.push(close),
  } as unknown as TestContext;

  return (vitePromise ??= createRendererServer(fakeContext, {
    cachePrefix: "openwhispr-meeting-system-audio-interrupted-test-",
  }));
}

// Sibling of meetingRecordingStoreSystemAudioSilence: that warning latches once
// per recording, this one repeats, because capture can stop and be restarted
// several times in one call and each break is worth surfacing (#1990).

const START_ARGS = {
  noteId: 11,
  noteTitle: "Meeting",
  folderId: null,
  autoEndEligible: false,
};

const RECORDING_ID = "a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1";

function createElectronAPI({
  systemAudioMode,
  systemAudioStrategy,
}: {
  systemAudioMode: string;
  systemAudioStrategy: string;
}) {
  const listeners: SystemAudioListeners = {
    systemAudioInterrupted: null,
    systemAudioResumed: null,
  };

  const noopListener = () => () => {};

  const api = {
    checkSystemAudioAccess: async () => ({
      granted: systemAudioMode !== "unsupported",
      status: systemAudioMode === "unsupported" ? "unsupported" : "granted",
      mode: systemAudioMode,
      strategy: systemAudioStrategy,
    }),
    onMeetManualMute: () => () => {},
    onMeetPlatformMute: () => () => {},
    meetingTranscriptionStart: async (): Promise<MeetingStartResult> => ({
      success: true,
      recordingId: RECORDING_ID,
      originAt: new Date().toISOString(),
      systemAudioMode,
      systemAudioStrategy,
    }),
    meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
    meetingTranscriptionStop: async () => ({ success: true }),
    meetingTranscriptionSend: async (
      _buffer: unknown,
      _source: unknown,
      _sessionId: unknown,
      packet: { sequence: number }
    ) => ({
      success: true,
      sequence: packet.sequence,
    }),
    onMeetingTranscriptionError: noopListener,
    onMeetingTranscriptionFatalError: noopListener,
    onMeetingSystemAudioSilent: noopListener,
    onMeetingSystemAudioInterrupted: (callback: (data: SystemAudioInterruption) => void) => {
      listeners.systemAudioInterrupted = callback;

      return () => {
        if (listeners.systemAudioInterrupted === callback) {
          listeners.systemAudioInterrupted = null;
        }
      };
    },
    onMeetingSystemAudioResumed: (callback: () => void) => {
      listeners.systemAudioResumed = callback;

      return () => {
        if (listeners.systemAudioResumed === callback) listeners.systemAudioResumed = null;
      };
    },
    onMeetingTranscriptionStopRequested: noopListener,
  };

  return { api, listeners };
}

async function loadStore(t: TestContext, api: Record<string, unknown>) {
  installBrowserGlobals(t, {
    window: { electronAPI: api },
  });
  const vite = await getVite();
  const module = await vite.moduleGraph.getModuleByUrl("/stores/meetingRecordingStore.ts");

  if (module) vite.moduleGraph.invalidateModule(module);

  return vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
}

async function stopStoreAndAssertOutcome(store: MeetingStoreModule) {
  const expectedStopped = store.useMeetingRecordingStore.getState().isRecording;
  const result = await store.stopRecording();
  assert.equal(result.stopped, expectedStopped);
}

async function startWithPendingMicrophone(t: TestContext, startResult?: MeetingStartResult) {
  let store!: MeetingStoreModule;
  let starting!: Promise<boolean>;
  let finishStart = async () => {};

  t.after(async () => {
    await finishStart();

    if (store) await stopStoreAndAssertOutcome(store);
  });

  installMicCaptureGlobals(t);
  const micStream = await navigator.mediaDevices.getUserMedia();
  const microphone = deferred<MediaStream>();
  const micRequested = deferred<void>();
  const mainStarted = deferred<void>();
  navigator.mediaDevices.getUserMedia = () => {
    micRequested.resolve();

    return microphone.promise;
  };

  const { api, listeners } = createElectronAPI({
    systemAudioMode: "native",
    systemAudioStrategy: "native",
  });

  const startMain = api.meetingTranscriptionStart;
  api.meetingTranscriptionStart = async () => {
    mainStarted.resolve();

    return startResult ?? startMain();
  };

  store = await loadStore(t, api);
  starting = store.startRecording(START_ARGS);
  finishStart = async () => {
    microphone.resolve(micStream);
    await starting;
  };

  await Promise.all([mainStarted.promise, micRequested.promise]);

  return { api, listeners, store, finishStart };
}

const stoppedCapture: SystemAudioInterruption = {
  systemAudioStrategy: "native",
  reason: "no_audio_delivered",
  recovering: false,
};

test("the final startup interruption survives a pending microphone permission", async (t: TestContext) => {
  const { listeners, store, finishStart } = await startWithPendingMicrophone(t);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    listeners.systemAudioInterrupted?.({ ...stoppedCapture, recovering: true });
  }

  listeners.systemAudioInterrupted?.(stoppedCapture);
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);

  await finishStart();

  assert.deepEqual(store.useMeetingRecordingStore.getState().systemAudioInterrupted, {
    recovering: false,
    reason: "no_audio_delivered",
  });
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterruptedNonce, 1);
  assert.equal((await store.stopRecording()).stopped, true);
});

test("resumed audio discards a quiet warning buffered during microphone setup", async (t: TestContext) => {
  const { listeners, store, finishStart } = await startWithPendingMicrophone(t);
  listeners.systemAudioInterrupted?.({ ...stoppedCapture, reason: "gone_quiet" });
  listeners.systemAudioResumed?.();
  await finishStart();
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterruptedNonce, 0);
  assert.equal((await store.stopRecording()).stopped, true);
});

test("resumed audio discards a recovered capture warning buffered during microphone setup", async (t: TestContext) => {
  const { listeners, store, finishStart } = await startWithPendingMicrophone(t);
  listeners.systemAudioInterrupted?.(stoppedCapture);
  listeners.systemAudioResumed?.();
  await finishStart();
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);
  assert.equal((await store.stopRecording()).stopped, true);
});

test("a mic-only fallback discards buffered system-audio interruptions", async (t: TestContext) => {
  const { listeners, store, finishStart } = await startWithPendingMicrophone(t, {
    success: true,
    recordingId: RECORDING_ID,
    originAt: new Date().toISOString(),
    systemAudioMode: "unsupported",
    systemAudioStrategy: "unsupported",
  });

  listeners.systemAudioInterrupted?.(stoppedCapture);
  await finishStart();
  listeners.systemAudioInterrupted?.(stoppedCapture);
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, true);
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterruptedNonce, 0);
  assert.equal((await store.stopRecording()).stopped, true);
});

test("failed startup removes early interruption listeners before another session", async (t: TestContext) => {
  const { api, listeners, store, finishStart } = await startWithPendingMicrophone(t, {
    success: false,
    error: "capture startup failed",
  });

  const lateInterrupted = listeners.systemAudioInterrupted;
  const lateResumed = listeners.systemAudioResumed;
  listeners.systemAudioInterrupted?.(stoppedCapture);
  await finishStart();
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);
  assert.equal(listeners.systemAudioInterrupted, null);
  assert.equal(listeners.systemAudioResumed, null);

  api.meetingTranscriptionStart = async () => ({
    success: true,
    recordingId: "c3c3c3c3-3333-4333-8333-c3c3c3c3c3c3",
    originAt: new Date().toISOString(),
    systemAudioMode: "native",
    systemAudioStrategy: "native",
  });
  assert.equal(await store.startRecording(START_ARGS), true);
  listeners.systemAudioInterrupted!({ ...stoppedCapture, reason: "gone_quiet" });
  lateInterrupted?.(stoppedCapture);
  lateResumed?.();
  assert.equal(
    store.useMeetingRecordingStore.getState().systemAudioInterrupted!.reason,
    "gone_quiet"
  );
  assert.equal((await store.stopRecording()).stopped, true);
});

test("stopping during microphone setup discards buffered warnings and early listeners", async (t: TestContext) => {
  const { listeners, store, finishStart } = await startWithPendingMicrophone(t);
  listeners.systemAudioInterrupted?.(stoppedCapture);
  const stopping = store.stopRecording();
  await finishStart();
  assert.equal((await stopping).stopped, false);
  assert.equal(listeners.systemAudioInterrupted, null);
  assert.equal(listeners.systemAudioResumed, null);
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterruptedNonce, 0);
});

test("resumed audio clears live warnings without creating another interruption", async (t: TestContext) => {
  let store!: MeetingStoreModule;
  t.after(async () => {
    if (store) await stopStoreAndAssertOutcome(store);
  });

  installMicCaptureGlobals(t);

  const { api, listeners } = createElectronAPI({
    systemAudioMode: "native",
    systemAudioStrategy: "native",
  });

  store = await loadStore(t, api);
  await store.startRecording(START_ARGS);
  listeners.systemAudioInterrupted!({ ...stoppedCapture, reason: "gone_quiet" });
  const nonce = store.useMeetingRecordingStore.getState().systemAudioInterruptedNonce;
  listeners.systemAudioResumed?.();
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterruptedNonce, nonce);

  for (const recovering of [true, false]) {
    listeners.systemAudioInterrupted!({ ...stoppedCapture, recovering });
    listeners.systemAudioResumed?.();
    assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);
  }

  const lateResumed = listeners.systemAudioResumed;
  assert.equal((await store.stopRecording()).stopped, true);
  await store.startRecording(START_ARGS);
  listeners.systemAudioInterrupted!({ ...stoppedCapture, reason: "gone_quiet" });
  lateResumed?.();
  assert.equal(
    store.useMeetingRecordingStore.getState().systemAudioInterrupted!.reason,
    "gone_quiet"
  );
  assert.equal((await store.stopRecording()).stopped, true);
});

test("every interruption bumps the nonce so a repeat still notifies", async (t: TestContext) => {
  const { api, listeners } = createElectronAPI({
    systemAudioMode: "native",
    systemAudioStrategy: "native",
  });

  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);
  assert.equal(typeof listeners.systemAudioInterrupted, "function");

  listeners.systemAudioInterrupted!({
    systemAudioStrategy: "native",
    reason: "no_audio_delivered",
    recovering: true,
  });
  let state = store.useMeetingRecordingStore.getState();
  assert.deepEqual(state.systemAudioInterrupted, {
    recovering: true,
    reason: "no_audio_delivered",
  });
  const firstNonce = state.systemAudioInterruptedNonce;

  listeners.systemAudioInterrupted!({
    systemAudioStrategy: "native",
    reason: "device_invalidated",
    recovering: true,
  });
  state = store.useMeetingRecordingStore.getState();
  assert.equal(state.systemAudioInterruptedNonce, firstNonce + 1);

  assert.equal((await store.stopRecording()).stopped, true);
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);
});

// The reason has to survive the hop: the toast copy for a quiet call is much
// weaker than the one for capture that has actually stopped, and only the
// reason separates them.
test("a give-up report carries recovering false and its reason through to the store", async (t: TestContext) => {
  const { api, listeners } = createElectronAPI({
    systemAudioMode: "native",
    systemAudioStrategy: "native",
  });

  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  listeners.systemAudioInterrupted!({
    systemAudioStrategy: "native",
    reason: "gone_quiet",
    recovering: false,
  });

  assert.deepEqual(store.useMeetingRecordingStore.getState().systemAudioInterrupted, {
    recovering: false,
    reason: "gone_quiet",
  });

  listeners.systemAudioInterrupted!({
    systemAudioStrategy: "native",
    reason: "no_audio_delivered",
    recovering: false,
  });
  assert.deepEqual(store.useMeetingRecordingStore.getState().systemAudioInterrupted, {
    recovering: false,
    reason: "no_audio_delivered",
  });

  assert.equal((await store.stopRecording()).stopped, true);
});

test("an interruption arriving after stop is ignored without crashing", async (t: TestContext) => {
  const { api, listeners } = createElectronAPI({
    systemAudioMode: "native",
    systemAudioStrategy: "native",
  });

  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  const lateCallback = listeners.systemAudioInterrupted;
  assert.equal((await store.stopRecording()).stopped, true);

  lateCallback!({
    systemAudioStrategy: "native",
    reason: "no_audio_delivered",
    recovering: true,
  });
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);
});

test("no interruption state when the session had no system audio", async (t: TestContext) => {
  installMicCaptureGlobals(t);

  const { api, listeners } = createElectronAPI({
    systemAudioMode: "unsupported",
    systemAudioStrategy: "unsupported",
  });

  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal(store.useMeetingRecordingStore.getState().micCaptureStatus, "active");

  listeners.systemAudioInterrupted!({
    systemAudioStrategy: "unsupported",
    reason: "no_audio_delivered",
    recovering: true,
  });
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);

  assert.equal((await store.stopRecording()).stopped, true);
});
