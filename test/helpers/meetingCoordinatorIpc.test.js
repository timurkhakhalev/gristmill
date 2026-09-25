const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const originalLoad = Module._load;
const RUN_ID = "b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2";

const fakeWindow = () => {
  const win = new EventEmitter();
  win.isDestroyed = () => false;
  win.webContents = new EventEmitter();
  win.webContents.messages = [];
  win.webContents.send = (channel, payload) => win.webContents.messages.push({ channel, payload });
  win.messages = win.webContents.messages;
  return win;
};

let currentWindow = null;
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
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") return electronStub;
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

function createDatabaseFake(events) {
  return {
    recordings: new Map(),
    epochs: [],
    finalized: [],
    createMeetingRecording(noteId, input, startedAt, id) {
      events.push("recording-created");
      const recording = {
        id,
        noteId,
        config: input.config,
        startedAt,
        captureState: "recording",
        audioState: "available",
      };
      this.recordings.set(id, recording);
      return recording;
    },
    createMeetingRecordingEpoch(recordingId, source, epochIndex, startFrame) {
      this.epochs.push({ recordingId, source, epochIndex, startFrame });
    },
    updateMeetingRecordingEpochRecovery(recordingId, source, epochIndex, result) {
      Object.assign(this.epochs.find((item) => item.recordingId === recordingId && item.source === source && item.epochIndex === epochIndex), result);
    },
    markMeetingRecordingFinalizing(recordingId) {
      this.recordings.get(recordingId).captureState = "finalizing";
    },
    finalizeMeetingRecording(recordingId, input) {
      this.finalized.push({ recordingId, input });
      const recording = this.recordings.get(recordingId);
      recording.captureState = input.captureState;
      recording.captureErrorCode = input.errorCode ?? null;
      return { recording, initialRun: { id: RUN_ID } };
    },
    getGoogleAccounts: () => [],
    getNote: (noteId) => ({ id: noteId, transcript: "Existing transcript" }),
    getSpeakerMappings: () => [],
    setSpeakerMapping: () => {},
    removeSpeakerMapping: () => {},
    getSpeakerProfiles: () => [],
    upsertSpeakerProfile: () => ({ id: 1 }),
  };
}

function createStorageFake(events, { failWrite = false } = {}) {
  return {
    files: new Map(),
    openEpochWriter(recordingId, source, epochIndex) {
      this.files.set(`${recordingId}:${source}:${epochIndex}`, []);
    },
    appendEpochSamples(recordingId, source, epochIndex, samples) {
      if (failWrite) throw new Error("disk full");
      events.push("pcm-written");
      this.files.get(`${recordingId}:${source}:${epochIndex}`).push(Buffer.from(samples));
    },
    closeEpochWriter() {},
    recoverEpoch(recordingId, source, epochIndex) {
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
    activeSessionId: null,
    async beginRecordingSession({ sessionId }) { this.activeSessionId = sessionId; },
    endRecordingSession(sessionId) {
      if (this.activeSessionId !== sessionId) return false;
      this.activeSessionId = null;
      return true;
    },
    setUserRecording() {},
    setMicWarmHold() {},
    recordMeetingAudioChunk() {},
    async setRecordingSystemAudioAvailable(sessionId) { return this.activeSessionId === sessionId; },
    getPreferences: () => ({ processDetection: true, audioDetection: true }),
    setPreferences() {},
    async handleNotificationResponse() {},
    async joinCalendarMeeting() {},
  };
}

function buildHarness({ failWrite = false } = {}) {
  currentWindow = fakeWindow();
  const handlers = new Map();
  const listeners = new Map();
  const events = [];
  const databaseManager = createDatabaseFake(events);
  const meetingRecordingStorage = createStorageFake(events, { failWrite });
  const engine = createEngineFake();
  let tokenCalls = 0;
  let asrCalls = 0;
  const coordinator = loadCoordinator();
  const runtime = coordinator.registerMeetingCoordinatorHandlers(
    {
      handle: (channel, listener) => handlers.set(channel, listener),
      on: (channel, listener) => listeners.set(channel, listener),
    },
    {
      databaseManager,
      meetingRecordingStorage,
      diarizationManager: {
        isAvailable: () => false,
        async convertRawPcmToWav() { return "/tmp/fake.wav"; },
        async diarize() { return []; },
        capSpeakerClusters: (segments) => segments,
        mergeWithTranscript: (segments) => segments,
      },
      meetingDetectionEngine: engine,
      audioTapManager: null,
      meetingAecManager: null,
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

const invoke = (harness, channel, ...args) => harness.handlers.get(channel)(...args);
const START = {
  noteId: 11,
  sessionId: "session-m2",
  autoEndEligible: false,
};
const START_EVENT = () => ({ sender: currentWindow.webContents });

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
    { epochIndex: 0, epochStartFrame: 100, sequence: 0, sampleOffset: 0 }
  );

  assert.deepEqual(response, { success: true, sequence: 0 });
  assert.deepEqual(harness.events, ["recording-created", "pcm-written"]);
  assert.equal(harness.meetingRecordingStorage.files.get(`${started.recordingId}:mic:0`)[0].equals(raw), true);
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
      { epochIndex: 0, epochStartFrame: 0, sequence: 0, sampleOffset: 0 }
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
      { epochIndex: 0, epochStartFrame: 0, sequence: 0, sampleOffset: 0 }
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
