const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const originalLoad = Module._load;
const RUN_ID = "b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2";

const fakeWindow = () => {
  const win = new EventEmitter();
  win.isDestroyed = () => false;
  win.webContents = new EventEmitter();
  win.webContents.messages = [];
  win.webContents.send = (channel: string, payload: unknown) => win.webContents.messages.push({ channel, payload });
  win.messages = win.webContents.messages;
  return win;
};

let currentWindow: ReturnType<typeof fakeWindow> | null = null;
const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    getAppMetrics: () => [],
    requestSingleInstanceLock: () => true,
  },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  BrowserWindow: class BrowserWindowStub {
    static fromWebContents() { return currentWindow; }
    static getAllWindows() { return []; }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

function loadCoordinator() {
  Module._load = function loadWithMocks(request: string, parent: unknown, isMain: boolean) {
    if (request === "electron") return electronStub;
    if (request === "./zoomSpeakerCollector.js") return { ZoomSpeakerCollector: class {
      start() {} stop() { return Promise.resolve(); } invalidate() {}
      bindClock() {} recordClock() {} recordDeliveredFrames() {}
    } };
    if (request === "./windowBroadcast" || request === "./windowBroadcast.js") {
      return { broadcastToWindows: () => {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("../../src/helpers/meetingCoordinatorIpcHandlers");
  } finally {
    Module._load = originalLoad;
  }
}

function createDatabaseFake(events: string[]) {
  return {
    saveMeetingPlatformObservation() {},
    saveMeetingAudioClockAnchor() {},
    setMeetingPlatformCoverage() {},
    recordings: new Map<string, { id: string; groupId: string; noteId: number; config: unknown; startedAt: string; captureState: string; audioState: string; captureErrorCode?: string | null }>(),
    epochs: [] as { recordingId: string; source: string; epochIndex: number; startFrame: number }[],
    intentionalIntervals: [] as Array<{ id: string; recordingId: string; source: string; startFrame: number; endFrame: number | null; reason: string }>,
    finalized: [] as { recordingId: string; input: { captureState: string; errorCode?: string } }[],
    createMeetingRecording(noteId: number, input: { config: unknown }, startedAt: string, id: string, groupId = id) {
      events.push("recording-created");
      const recording = {
        id,
        groupId,
        noteId,
        config: input.config,
        startedAt,
        captureState: "recording",
        audioState: "available",
      };
      this.recordings.set(id, recording);
      return recording;
    },
    createMeetingRecordingEpoch(recordingId: string, source: string, epochIndex: number, sourceGeneration: number, startFrame: number) {
      this.epochs.push({ recordingId, source, epochIndex, startFrame });
    },
    addMeetingRecordingEpochAlignment() {},
    markMeetingRecordingEpochAlignmentUnknown() {},
    updateMeetingRecordingEpochRecovery(recordingId: string, source: string, epochIndex: number, result: unknown) {
      const epoch = this.epochs.find((item) => item.recordingId === recordingId && item.source === source && item.epochIndex === epochIndex);
      if (!epoch) throw new Error("Recording epoch not found");
      Object.assign(epoch, result);
    },
    markMeetingRecordingFinalizing(recordingId: string) {
      const recording = this.recordings.get(recordingId);
      assert.ok(recording);
      recording.captureState = "finalizing";
    },
    finalizeMeetingRecording(recordingId: string, input: { captureState: string; errorCode?: string }) {
      this.finalized.push({ recordingId, input });
      const recording = this.recordings.get(recordingId);
      assert.ok(recording);
      recording.captureState = input.captureState;
      recording.captureErrorCode = input.errorCode ?? null;
      return { recording, initialRun: { id: RUN_ID } };
    },
    openMeetingIntentionalInterval(recordingId: string, source: string, sourceGeneration: number, startFrame: number, reason: string) {
      const interval = { id: `${recordingId}:${source}:${reason}:${startFrame}`, recordingId, source, startFrame, endFrame: null, reason };
      this.intentionalIntervals.push(interval);
      return interval;
    },
    closeMeetingIntentionalInterval(recordingId: string, source: string, sourceGeneration: number, endFrame: number, reason: string) {
      const interval = [...this.intentionalIntervals].reverse().find((item) => item.recordingId === recordingId && item.source === source && item.reason === reason && item.endFrame === null);
      if (!interval) return null;
      interval.endFrame = endFrame;
      return interval;
    },
    listMeetingIntentionalIntervals(recordingId: string) { return this.intentionalIntervals.filter((item) => item.recordingId === recordingId); },
    getGoogleAccounts: () => [],
    getNote: (noteId: unknown) => ({ id: noteId, transcript: "Existing transcript" }),
    getSpeakerMappings: () => [],
    setSpeakerMapping: () => {},
    removeSpeakerMapping: () => {},
    getSpeakerProfiles: () => [],
    upsertSpeakerProfile: () => ({ id: 1 }),
  };
}

function createStorageFake(events: string[], { failWrite = false } = {}) {
  return {
    files: new Map<string, Buffer[]>(),
    openEpochWriter(recordingId: string, source: string, epochIndex: number) {
      this.files.set(`${recordingId}:${source}:${epochIndex}`, []);
    },
    appendEpochSamples(recordingId: string, source: string, epochIndex: number, samples: Buffer | Uint8Array) {
      if (failWrite) throw new Error("disk full");
      events.push("pcm-written");
      const buffers = this.files.get(`${recordingId}:${source}:${epochIndex}`);
      assert.ok(buffers);
      buffers.push(Buffer.from(samples));
    },
    closeEpochWriter() {},
    recoverEpoch(recordingId: string, source: string, epochIndex: number) {
      const buffers = this.files.get(`${recordingId}:${source}:${epochIndex}`) ?? [];
      return {
        frameCount: buffers.reduce((total, buffer) => total + buffer.length / 2, 0),
        ignoredTrailingBytes: 0,
        errorCode: null,
      };
    },
  };
}

function createEngineFake() {
  return {
    activeSessionId: null as string | null,
    async beginRecordingSession({ sessionId }: { sessionId: string }) { this.activeSessionId = sessionId; },
    endRecordingSession(sessionId: string) {
      if (this.activeSessionId !== sessionId) return false;
      this.activeSessionId = null;
      return true;
    },
    setUserRecording() {},
    setMicWarmHold() {},
    recordMeetingAudioChunk() {},
    async setRecordingSystemAudioAvailable(sessionId: string) { return this.activeSessionId === sessionId; },
    getPreferences: () => ({ processDetection: true, audioDetection: true }),
    setPreferences() {},
    async handleNotificationResponse() {},
    async joinCalendarMeeting() {},
    findCalendarEventNote: (eventId: string) => (eventId === "evt-1" ? { noteId: 42, folderId: 7 } : null),
    createCalendarEventNote: (eventId: string, initial: { content?: string }) =>
      eventId === "evt-2" && initial.content === "Hi" ? { noteId: 43, folderId: 7 } : null,
  };
}

function buildHarness({ failWrite = false, audioTapManager = null }: {
  failWrite?: boolean;
  audioTapManager?: import("../../src/helpers/meetingCoordinatorIpcHandlers.js").MeetingCoordinatorDeps["audioTapManager"];
} = {}) {
  currentWindow = fakeWindow();
  const handlers = new Map();
  const listeners = new Map();
  const events: string[] = [];
  const databaseManager = createDatabaseFake(events);
  const meetingRecordingStorage = createStorageFake(events, { failWrite });
  const engine = createEngineFake();
  let tokenCalls = 0;
  let asrCalls = 0;
  const coordinator = loadCoordinator();
  const runtime = coordinator.registerMeetingCoordinatorHandlers(
    {
      handle: (channel: string, listener: unknown) => handlers.set(channel, listener),
      on: (channel: string, listener: unknown) => listeners.set(channel, listener),
    },
    {
      databaseManager,
      meetingRecordingStorage,
      diarizationManager: {
        isAvailable: () => false,
        async convertRawPcmToWav() { return "/tmp/fake.wav"; },
        async diarize() { return []; },
        capSpeakerClusters: (segments: unknown) => segments,
        mergeWithTranscript: (segments: unknown) => segments,
      },
      meetingDetectionEngine: engine,
      audioTapManager,
      whisperManager: { transcribeLocalWhisper: async () => { asrCalls += 1; return { success: true, text: "" }; } },
      parakeetManager: { transcribeLocalParakeet: async () => { asrCalls += 1; return { success: true, text: "" }; } },
      liveSpeakerIdentifier: {
        isAvailable: () => false,
        start: async () => false,
        stop: async () => ({}),
        feedAudio: async () => undefined,
        recluster: async () => [],
        setEnabled: () => {},
        maxSpeakers: 0,
        setMaxSpeakers() {},
        getSpeakerEmbedding: () => null,
        mapSpeaker: () => {},
      },
      fetchRealtimeToken: async () => { tokenCalls += 1; return "unused-token"; },
      resolveWhisperVadOptions: () => ({}),
      speakerEmbeddings: () => ({ cosineSimilarity: () => 0.9 }),
      getControlPanelWindow: () => currentWindow,
      getMeetingNotificationData: () => null,
      consumePendingMeetingNoteNavigation: () => null,
      showNotificationWindow: () => {},
    }
  );
  return { runtime, handlers, listeners, events, databaseManager, meetingRecordingStorage, tokenCalls: () => tokenCalls, asrCalls: () => asrCalls, engine };
}

const invoke = (harness: ReturnType<typeof buildHarness>, channel: string, ...args: unknown[]) => harness.handlers.get(channel)(...args);
const START = {
  noteId: 11,
  sessionId: "session-m2",
  autoEndEligible: false,
};
const START_EVENT = () => ({ sender: currentWindow.webContents });

test("initial manual mute is persisted at frame zero before any renderer audio", async () => {
  const harness = buildHarness();
  const started = await invoke(harness, "meeting-transcription-start", START_EVENT(), { ...START, manualMicMuted: true });
  assert.equal(started.success, true);
  assert.deepEqual(
    harness.databaseManager.listMeetingIntentionalIntervals(started.recordingId).map(({ source, startFrame, endFrame, reason }: any) => [source, startFrame, endFrame, reason]),
    [["mic", 0, null, "manual-muted"]]
  );
  const stopped = await invoke(harness, "meeting-transcription-stop", START_EVENT(), { sessionId: START.sessionId, lastSequence: {} });
  assert.equal(stopped.success, true);
});

test("a native helper failure reconnects system audio without ending the meeting or exposing its raw error", async () => {
  let callbacks: import("../../src/helpers/audioTapManager.js").AudioTapStartOptions = {};
  let starts = 0;
  let helperOriginNs = "1000000000000000";
  let helperGeneration = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const harness = buildHarness({ audioTapManager: {
    isSupported: () => true,
    getClockOrigin: () => ({ helperGeneration, monotonicOriginNs: helperOriginNs }),
    probeClock: async (nonce) => ({
      type: "probe", nonce, helperReceiveNs: helperOriginNs, helperSendNs: helperOriginNs,
      helperGeneration, helperFrame: 0,
    }),
    start: async (options = {}) => {
      starts += 1;
      callbacks = options;
      if (starts > 1) {
        helperOriginNs = (BigInt(helperOriginNs) + 100_000_000n).toString();
        helperGeneration = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      }
      options.onStart?.({
        type: "start", generation: helperGeneration, sampleRate: 24_000, channels: 1, bitsPerChannel: 16,
        monotonicOriginNs: helperOriginNs, originFrame: 0,
      });
    },
    stop: async () => {},
  } });
  const started = await invoke(harness, "meeting-transcription-start", START_EVENT(), START);
  try {
    assert.equal(started.success, true);
    assert.equal(starts, 1);
    callbacks.onError?.(new Error("audio device disappeared"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(starts, 2);
    assert.equal(harness.runtime.isRecording(), true);
    assert.equal(harness.databaseManager.recordings.size, 1);
    callbacks.onChunk?.(Buffer.alloc(4800), 0);
    assert.ok(currentWindow.messages.some((message: { channel: string }) => message.channel === "meeting-system-audio-resumed"));
    assert.ok(!currentWindow.messages.some((message: { channel: string }) => message.channel === "meeting-transcription-error"));
    assert.equal(harness.databaseManager.finalized.length, 0);
  } finally {
    const stopped = await invoke(harness, "meeting-transcription-stop", START_EVENT(), { sessionId: START.sessionId, lastSequence: {} });
    assert.equal(stopped.success, true);
  }
});

test("prepare and start need no credentials or model connection and create durable recording first", async () => {
  const harness = buildHarness();
  const prepared = await invoke(harness, "meeting-transcription-prepare", { sender: null }, {});
  assert.deepEqual(prepared, { success: true });

  const started = await invoke(harness, "meeting-transcription-start", START_EVENT(), START);
  assert.equal(started.success, true);
  assert.match(started.recordingId, /^[0-9a-f-]{36}$/);
  assert.equal(harness.databaseManager.recordings.has(started.recordingId), true);
  assert.equal(harness.events[0], "recording-created");
  assert.equal(harness.tokenCalls(), 0);
  assert.equal(harness.asrCalls(), 0);
  assert.equal(harness.runtime.isRecording(), true);
});

test("start preserves the requested meeting group across IPC validation and capture persistence", async () => {
  const harness = buildHarness();
  const groupId = "f0f0f0f0-0000-4000-8000-f0f0f0f0f0f0";
  const started = await invoke(harness, "meeting-transcription-start", START_EVENT(), { ...START, groupId });
  assert.equal(started.success, true);
  assert.equal(harness.databaseManager.recordings.get(started.recordingId)?.groupId, groupId);
});

test("renderer audio is acknowledged only after its raw PCM bytes are written", async () => {
  const harness = buildHarness();
  const started = await invoke(harness, "meeting-transcription-start", START_EVENT(), START);
  const raw = Buffer.alloc(4_800, 7);
  const response = await invoke(
    harness,
    "meeting-transcription-send",
    { sender: currentWindow.webContents },
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
    "mic",
    START.sessionId,
    { epochIndex: 0, epochSourceStartFrame: 100, sourceFrameStart: 100, alignment: null, alignmentErrorCode: "clock-unavailable", sourceGeneration: 1, sequence: 0, sampleOffset: 0 }
  );

  assert.deepEqual(response, { success: true, sequence: 0 });
  assert.deepEqual(harness.events, ["recording-created", "pcm-written"]);
  const written = harness.meetingRecordingStorage.files.get(`${started.recordingId}:mic:0`);
  assert.ok(written);
  assert.equal(written[0]?.equals(raw), true);
});

test("disk errors reject acknowledgement and finalize incomplete", async () => {
  const harness = buildHarness({ failWrite: true });
  const started = await invoke(harness, "meeting-transcription-start", START_EVENT(), START);
  assert.equal(started.success, true);
  const raw = Buffer.alloc(4_800, 9);

  await assert.rejects(
    async () => invoke(
      harness,
      "meeting-transcription-send",
      { sender: currentWindow.webContents },
      raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
      "mic",
      START.sessionId,
      { epochIndex: 0, epochSourceStartFrame: 0, sourceFrameStart: 0, alignment: null, alignmentErrorCode: "clock-unavailable", sourceGeneration: 1, sequence: 0, sampleOffset: 0 }
    ),
    /disk full/
  );
  const stopped = await invoke(harness, "meeting-transcription-stop", { sender: currentWindow.webContents }, {
    sessionId: START.sessionId,
    lastSequence: { mic: -1, system: -1 },
    incomplete: true,
    errorCode: "capture-write-failed",
  });

  assert.equal(stopped.success, true);
  assert.equal(stopped.captureState, "incomplete");
  assert.equal(harness.databaseManager.finalized.length, 1);
});

test("repeated stop cannot create a second initial processing run", async () => {
  const harness = buildHarness();
  await invoke(harness, "meeting-transcription-start", START_EVENT(), START);
  const request = {
    sessionId: START.sessionId,
    lastSequence: { mic: -1, system: -1 },
    incomplete: true,
    errorCode: "renderer-lost",
  };
  const first = await invoke(harness, "meeting-transcription-stop", { sender: currentWindow.webContents }, request);
  const second = await invoke(harness, "meeting-transcription-stop", { sender: currentWindow.webContents }, request);

  assert.equal(first.success, true);
  assert.equal(second.success, false);
  assert.equal(harness.databaseManager.finalized.length, 1);
  assert.equal(first.initialRunId, RUN_ID);
});

test("capture packet validation rejects unknown sources", async () => {
  const harness = buildHarness();
  await invoke(harness, "meeting-transcription-start", START_EVENT(), START);
  await assert.rejects(
    async () => invoke(
      harness,
      "meeting-transcription-send",
      { sender: currentWindow.webContents },
      new ArrayBuffer(4_800),
      "fallback",
      START.sessionId,
      { epochIndex: 0, epochSourceStartFrame: 0, sequence: 0, sampleOffset: 0 }
    ),
    /source is invalid/
  );
});

test("renderer crash finalizes available capture state as incomplete", async () => {
  const harness = buildHarness();
  await invoke(harness, "meeting-transcription-start", START_EVENT(), START);

  currentWindow.webContents.emit("render-process-gone");
  for (let attempt = 0; attempt < 20 && harness.databaseManager.finalized.length === 0; attempt += 1) {
    await new Promise(setImmediate);
  }

  assert.equal(harness.databaseManager.finalized.length, 1);
  assert.equal(harness.databaseManager.finalized[0].input.captureState, "incomplete");
  assert.equal(harness.databaseManager.finalized[0].input.errorCode, "renderer-lost");
  assert.equal(harness.runtime.isRecording(), false);
});
