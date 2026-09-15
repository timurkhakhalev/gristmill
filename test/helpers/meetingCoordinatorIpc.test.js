const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const originalLoad = Module._load;

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// connectRealtimeStreaming builds its client instances only after
// `await getMeetingSystemAudioPlan()` and `await fetchRealtimeToken(...)` —
// the pre-migration order, kept 1:1 — so fixtures must let those microtasks
// run before observing the construction.
async function waitFor(condition, label, { attempts = 200 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

const clientCount = () => FakeStreamingClient.instances.length;

class FakeStreamingClient {
  constructor() {
    FakeStreamingClient.instances.push(this);
    this.isConnected = false;
    this.audioBytesSent = 0;
    this.completedSegments = [];
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onConnectionLost = null;
    this.sent = [];
    this.connectDeferred = createDeferred();
  }
  async connect() {
    await this.connectDeferred.promise;
    this.isConnected = true;
  }
  sendAudio(buffer) {
    this.sent.push(buffer);
    return true;
  }
  async disconnect() {
    this.isConnected = false;
    return { text: "" };
  }
}

const providersStub = {
  STREAMING_CLIENT_BY_PROVIDER: { "openai-realtime": FakeStreamingClient },
  ALLOWED_MEETING_PROVIDERS: new Set(["local", "openai-realtime"]),
  getMeetingStreamingClient: () => FakeStreamingClient,
  getMeetingConnectionKey: (options = {}) => JSON.stringify({ provider: options.provider }),
};

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
    static fromWebContents() {
      return currentWindow;
    }
    static getAllWindows() {
      return [];
    }
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
    if (request === "./meetingStreamingProviders" || request === "./meetingStreamingProviders.js") {
      return providersStub;
    }
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

function createEngineFake() {
  return {
    stoppedSessions: [],
    activeSessionId: null,
    begunSessions: [],
    userRecording: null,
    systemAudioResult: true,
    endRecordingSession(expectedSessionId) {
      if (expectedSessionId == null) {
        this.stoppedSessions.push(null);
        this.activeSessionId = null;
        return true;
      }
      if (this.activeSessionId !== expectedSessionId) {
        return false;
      }
      this.stoppedSessions.push(expectedSessionId);
      this.activeSessionId = null;
      return true;
    },
    setUserRecording(active) {
      this.userRecording = active;
    },
    async beginRecordingSession(session) {
      this.begunSessions.push(session);
      this.activeSessionId = session.sessionId;
    },
    async setRecordingSystemAudioAvailable(sessionId) {
      return this.activeSessionId === sessionId ? this.systemAudioResult : false;
    },
    setMicWarmHold() {},
    recordMeetingAudioChunk() {},
    getPreferences: () => ({ processDetection: true, audioDetection: true }),
    setPreferences() {},
    async handleNotificationResponse() {},
    async joinCalendarMeeting() {},
  };
}

function createDiarizationManagerFake({ available = false } = {}) {
  return {
    isAvailable: () => available,
    async convertRawPcmToWav() {
      return "/tmp/fake-diarize.wav";
    },
    async diarize() {
      return [];
    },
    capSpeakerClusters: (segments) => segments,
    mergeWithTranscript: (segments) => segments,
  };
}

function buildHarness({ diarizationAvailable = false } = {}) {
  FakeStreamingClient.instances = [];
  currentWindow = fakeWindow();
  const handlers = new Map();
  const listenerChannels = new Map();
  const ipcMainFake = {
    handle: (channel, listener) => handlers.set(channel, listener),
    on: (channel, listener) => listenerChannels.set(channel, listener),
  };
  const harnessListenerChannels = listenerChannels;
  const engine = createEngineFake();
  const coordinator = loadCoordinator();
  const runtime = coordinator.registerMeetingCoordinatorHandlers(ipcMainFake, {
    databaseManager: {
      getGoogleAccounts: () => [],
      getNote: () => null,
      getSpeakerMappings: () => [],
      setSpeakerMapping: () => {},
      removeSpeakerMapping: () => {},
      getSpeakerProfiles: () => [],
      upsertSpeakerProfile: () => ({ id: 1 }),
    },
    diarizationManager: createDiarizationManagerFake({ available: diarizationAvailable }),
    meetingDetectionEngine: engine,
    audioTapManager: null,
    meetingAecManager: null,
    whisperManager: { transcribeLocalWhisper: async () => ({ success: true, text: "" }) },
    parakeetManager: { transcribeLocalParakeet: async () => ({ success: true, text: "" }) },
    liveSpeakerIdentifier: {
      isAvailable: () => false,
      start: async () => false,
      stop: async () => ({}),
      feedAudio: async () => undefined,
      recluster: async () => [],
      setEnabled: () => {},
      maxSpeakers: 0,
      setMaxSpeakers(n) {
        this.maxSpeakers = n;
      },
      getSpeakerEmbedding: () => null,
      mapSpeaker: () => {},
    },
    fetchRealtimeToken: async () => "token",
    resolveWhisperVadOptions: () => ({}),
    speakerEmbeddings: () => ({ cosineSimilarity: () => 0.9 }),
    getControlPanelWindow: () => currentWindow,
    getMeetingNotificationData: () => null,
    consumePendingMeetingNoteNavigation: () => null,
    showNotificationWindow: () => {},
  });
  return { runtime, handlers, listenerChannels: harnessListenerChannels, engine };
}

const invoke = (handlers, channel, ...args) => handlers.get(channel)(...args);

const START_OPTIONS = { provider: "openai-realtime", sessionId: "", autoEndEligible: false };

test("prepare rejects unsupported providers and short-circuits the local provider", async () => {
  const { handlers } = buildHarness();
  const event = { sender: null };

  const unsupported = await invoke(handlers, "meeting-transcription-prepare", event, {
    provider: "nope",
  });
  assert.deepEqual(unsupported, { success: false, error: "Unsupported provider: nope" });

  const local = await invoke(handlers, "meeting-transcription-prepare", event, {
    provider: "local",
  });
  assert.deepEqual(local, { success: true });
});

test("prepare connects once and reuses the connection for the same key", async () => {
  const { handlers } = buildHarness();
  const event = { sender: null };
  const options = { provider: "openai-realtime" };

  const pending = invoke(handlers, "meeting-transcription-prepare", event, options);
  await waitFor(() => clientCount() === 1, "the connect client is constructed");
  FakeStreamingClient.instances[0].connectDeferred.resolve();
  assert.deepEqual(await pending, { success: true });

  const reuse = await invoke(handlers, "meeting-transcription-prepare", event, options);
  assert.deepEqual(reuse, { success: true, alreadyPrepared: true });
  assert.equal(FakeStreamingClient.instances.length, 1, "warm reuse must not reconnect");
});

test("concurrent prepares keep the single-operation guard", async () => {
  const { handlers } = buildHarness();
  const event = { sender: null };
  const options = { provider: "openai-realtime" };

  const first = invoke(handlers, "meeting-transcription-prepare", event, options);
  await waitFor(() => clientCount() === 1, "the first prepare is in flight");
  const second = await invoke(handlers, "meeting-transcription-prepare", event, options);
  assert.deepEqual(second, { success: false, error: "Operation in progress" });

  FakeStreamingClient.instances[0].connectDeferred.resolve();
  assert.deepEqual(await first, { success: true });
});

test("a prepare failure resolves with the serialized error", async () => {
  const { handlers } = buildHarness();
  const event = { sender: null };
  const options = { provider: "openai-realtime" };

  const pending = invoke(handlers, "meeting-transcription-prepare", event, options);
  await waitFor(() => clientCount() === 1, "the connect client is constructed");
  FakeStreamingClient.instances[0].connectDeferred.reject(new Error("no route to host"));
  assert.deepEqual(await pending, { success: false, error: "no route to host" });

  // The guard clears, so a later prepare can try again.
  const retry = invoke(handlers, "meeting-transcription-prepare", event, options);
  await waitFor(() => clientCount() === 2, "the retry client is constructed");
  FakeStreamingClient.instances[1].connectDeferred.resolve();
  assert.deepEqual(await retry, { success: true });
});

// CHARACTERIZATION (defect, not fixed by this migration): cancel clears the
// prepare/start guards while the connect is still running, so a duplicate
// prepare can interleave with the unresolved connect and the streaming refs /
// connection key end up last-writer-wins. The migration deliberately does not
// add a hard abort or change this contract; the fix is a separate decision.
test("cancel during an in-flight prepare admits a second connect while the first is unresolved", async () => {
  const { handlers } = buildHarness();
  const event = { sender: null };

  const first = invoke(handlers, "meeting-transcription-prepare", event, {
    provider: "openai-realtime",
  });
  await waitFor(() => clientCount() === 1, "the first connect client is constructed");

  assert.deepEqual(await invoke(handlers, "meeting-transcription-cancel"), { success: true });

  // The guard is gone, so the second prepare is admitted while the first
  // connect is still unresolved.
  const second = invoke(handlers, "meeting-transcription-prepare", event, {
    provider: "openai-realtime",
  });
  await waitFor(() => clientCount() === 2, "two overlapping connects");

  FakeStreamingClient.instances[0].connectDeferred.resolve();
  assert.deepEqual(await first, { success: true });
  FakeStreamingClient.instances[1].connectDeferred.resolve();
  assert.deepEqual(await second, { success: true });

  // Last writer wins on the connection key.
  const warm = await invoke(handlers, "meeting-transcription-prepare", event, {
    provider: "openai-realtime",
  });
  assert.deepEqual(warm, { success: true, alreadyPrepared: true });
});

test("cancel refuses while a recording is live", async () => {
  const { handlers, engine } = buildHarness();
  const event = { sender: null };
  engine.systemAudioResult = true;

  // Simulate a live local recording (its interval timer counts as activity).
  const start = invoke(handlers, "meeting-transcription-start", event, {
    ...START_OPTIONS,
    provider: "local",
    sessionId: "meeting-live",
  });
  const started = await start;
  assert.equal(started.success, true, JSON.stringify(started));

  assert.deepEqual(await invoke(handlers, "meeting-transcription-cancel"), {
    success: false,
    reason: "recording-active",
  });

  // Stop so the local chunking interval does not leak into the next test.
  const stopped = await invoke(handlers, "meeting-transcription-stop", "meeting-live");
  assert.equal(stopped.success, true, JSON.stringify(stopped));
});

test("a local start records the session, and its stop publishes and tears down", async () => {
  const { handlers, engine } = buildHarness();
  const event = { sender: null };

  const started = await invoke(handlers, "meeting-transcription-start", event, {
    provider: "local",
    sessionId: "meeting-1",
    noteId: 7,
    autoEndEligible: false,
  });
  assert.equal(started.success, true, JSON.stringify(started));
  assert.equal(started.sessionId, "meeting-1");
  assert.equal(engine.begunSessions.length, 1);
  assert.equal(engine.userRecording, true);

  const stopped = await invoke(handlers, "meeting-transcription-stop", "meeting-1");
  assert.equal(stopped.success, true, JSON.stringify(stopped));
  assert.equal(stopped.diarizationSessionId.startsWith("diar-"), true);
  assert.equal(engine.userRecording, false);
  assert.deepEqual(engine.stoppedSessions, [null, "meeting-1"]);
});

test("stop with another session's id is a stale no-op", async () => {
  const { handlers, engine } = buildHarness();
  engine.activeSessionId = "meeting-other";
  const stopped = await invoke(handlers, "meeting-transcription-stop", "meeting-1");
  assert.deepEqual(stopped, { success: false, reason: "stale-session" });
  assert.deepEqual(engine.stoppedSessions, []);
});

test("a duplicate start is refused while the first start is in flight", async () => {
  const { handlers } = buildHarness();
  const event = { sender: null };

  const first = invoke(handlers, "meeting-transcription-start", event, {
    ...START_OPTIONS,
    sessionId: "meeting-1",
  });
  // The first start is in flight (blocked inside the realtime connect); the
  // lifecycle gate must refuse the second one without queueing it.
  await waitFor(() => clientCount() === 1, "the first start reached its connect");
  const second = await invoke(handlers, "meeting-transcription-start", event, {
    ...START_OPTIONS,
    sessionId: "meeting-2",
  });
  assert.deepEqual(second, { success: false, error: "Operation in progress" });

  FakeStreamingClient.instances[0].connectDeferred.resolve();
  const firstResult = await first;
  assert.equal(firstResult.success, true, JSON.stringify(firstResult));
});

test("an owner reload tears its recording session down through the lifecycle", async () => {
  const { handlers, engine } = buildHarness();
  const owner = new EventEmitter();
  owner.isDestroyed = () => false;
  const event = { sender: owner };

  const startPromise = invoke(handlers, "meeting-transcription-start", event, {
    ...START_OPTIONS,
    sessionId: "meeting-1",
  });
  await waitFor(() => clientCount() === 1, "the start reached its connect");
  FakeStreamingClient.instances[0].connectDeferred.resolve();
  const started = await startPromise;
  assert.equal(started.success, true, JSON.stringify(started));
  assert.equal(engine.activeSessionId, "meeting-1");

  // Reload / render-process-gone reaches the lifecycle's owner-loss listener.
  owner.emit("destroyed");
  await waitFor(() => engine.stoppedSessions.length === 2, "the owner-loss stop ran");

  assert.deepEqual(engine.stoppedSessions, [null, "meeting-1"]);
  assert.equal(engine.userRecording, false);
});

test("system-audio availability rejects a stale session", async () => {
  const { handlers } = buildHarness();
  const result = await invoke(
    handlers,
    "meeting-transcription-set-system-audio-available",
    { sender: null },
    "meeting-stale",
    true
  );
  assert.deepEqual(result, { success: false, reason: "stale-session" });
});

test("recording lock admits one pipeline and reports the holder", async () => {
  const { handlers } = buildHarness();

  assert.deepEqual(await invoke(handlers, "acquire-recording-lock", "meeting"), { success: true });
  assert.deepEqual(await invoke(handlers, "acquire-recording-lock", "dictation"), {
    success: false,
    holder: "meeting",
  });
  assert.deepEqual(await invoke(handlers, "release-recording-lock", "dictation"), { success: true });
  assert.deepEqual(await invoke(handlers, "release-recording-lock", "meeting"), { success: true });
  assert.deepEqual(await invoke(handlers, "acquire-recording-lock", "dictation"), { success: true });
});

test("a late diarization result is published to the session that owned the recording", async () => {
  const diarizeDeferred = createDeferred();
  const diarizationManager = createDiarizationManagerFake({ available: true });
  diarizationManager.diarize = () => diarizeDeferred.promise;
  diarizationManager.mergeWithTranscript = (segments) => segments.map((s) => s);

  buildHarness({ diarizationAvailable: true });
  // Re-register with the deferred diarizer: buildHarness already created the
  // registration, so drive a second harness with the fake swapped in.
  const diarizationHarness = (() => {
    FakeStreamingClient.instances = [];
    currentWindow = fakeWindow();
    const localHandlers = new Map();
    const localListeners = new Map();
    const coordinator = loadCoordinator();
    const localEngine = createEngineFake();
    coordinator.registerMeetingCoordinatorHandlers(
      {
        handle: (channel, listener) => localHandlers.set(channel, listener),
        on: (channel, listener) => localListeners.set(channel, listener),
      },
      {
        databaseManager: {
          getGoogleAccounts: () => [],
          getNote: () => null,
          getSpeakerMappings: () => [],
          setSpeakerMapping: () => {},
          removeSpeakerMapping: () => {},
          getSpeakerProfiles: () => [],
          upsertSpeakerProfile: () => ({ id: 1 }),
        },
        diarizationManager,
        meetingDetectionEngine: localEngine,
        audioTapManager: null,
        meetingAecManager: null,
        whisperManager: { transcribeLocalWhisper: async () => ({}) },
        parakeetManager: { transcribeLocalParakeet: async () => ({}) },
        liveSpeakerIdentifier: {
          isAvailable: () => false,
          start: async () => false,
          stop: async () => ({}),
          feedAudio: async () => undefined,
          recluster: async () => [],
          setEnabled: () => {},
          setMaxSpeakers() {},
          getSpeakerEmbedding: () => null,
          mapSpeaker: () => {},
        },
        fetchRealtimeToken: async () => "token",
        resolveWhisperVadOptions: () => ({}),
        speakerEmbeddings: () => ({ cosineSimilarity: () => 0.9 }),
        getControlPanelWindow: () => currentWindow,
        getMeetingNotificationData: () => null,
        consumePendingMeetingNoteNavigation: () => null,
        showNotificationWindow: () => {},
      }
    );
    return { handlers: localHandlers, listenerChannels: localListeners, engine: localEngine };
  })();

  const event = { sender: null };
  const started = await invoke(diarizationHarness.handlers, "meeting-transcription-start", event, {
    provider: "local",
    sessionId: "meeting-A",
    noteId: 42,
    autoEndEligible: false,
  });
  assert.equal(started.success, true, JSON.stringify(started));

  // Feed one system chunk so the raw PCM capture exists for diarization.
  invoke(
    diarizationHarness.listenerChannels,
    "meeting-transcription-send",
    null,
    Buffer.alloc(4),
    "system"
  );

  const stopped = await invoke(diarizationHarness.handlers, "meeting-transcription-stop", "meeting-A");
  assert.equal(stopped.success, true, JSON.stringify(stopped));

  // Session B starts before A's background diarization resolves.
  const startedB = await invoke(diarizationHarness.handlers, "meeting-transcription-start", event, {
    provider: "local",
    sessionId: "meeting-B",
    noteId: 99,
    autoEndEligible: false,
  });
  assert.equal(startedB.success, true, JSON.stringify(startedB));

  diarizeDeferred.resolve([]);

  // Allow the publication async path to run.
  await waitFor(
    () =>
      currentWindow.messages.filter((m) => m.channel === "meeting-diarization-complete").length ===
      1,
    "the diarization completion is published"
  );

  const completions = currentWindow.messages.filter(
    (m) => m.channel === "meeting-diarization-complete"
  );
  assert.equal(completions.length, 1, "exactly one diarization completion");
  assert.equal(
    completions[0].payload.sessionId.startsWith("diar-"),
    true,
    "the stop's diarization session id"
  );
  assert.equal(completions[0].payload.noteId, 42, "late result routes to session A's note");
  assert.equal(diarizationHarness.engine.activeSessionId, "meeting-B", "session B keeps recording");

  // Stop B so the local chunking interval does not keep the runner alive.
  const stoppedB = await invoke(diarizationHarness.handlers, "meeting-transcription-stop", "meeting-B");
  assert.equal(stoppedB.success, true, JSON.stringify(stoppedB));
});
