// The real bundled preload talks to the real typed meeting coordinator over
// fakes: command shapes crossing the wire, event payloads reaching callbacks
// with malformed ones dropped, payload-only listeners, unsubscribe removing
// exactly its own listener, and junk invoke responses rejected at the preload
// boundary. Run pnpm run build:main first so dist-main/preload.js exists.
const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

const root = path.resolve(__dirname, "../..");
const bundledPreload = path.join(root, "dist-main", "preload.js");

const electronStub = {
  app: {
    getPath: () => "/tmp",
    getAppPath: () => process.cwd(),
    isReady: () => false,
  },
  ipcMain: { handle() {}, on() {}, removeHandler() {}, emit() {} },
  BrowserWindow: { getAllWindows: () => [] },
};

const originalLoad = Module._load;

function registerRealHandlers(deps: any) {
  Module._load = function patchedLoad(request: string, parent: any, isMain: boolean) {
    if (request === "electron") return electronStub;
    if (request === "./windowBroadcast" || request === "./windowBroadcast.js") {
      return { broadcastToWindows: () => {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { registerMeetingCoordinatorHandlers } = require(
      "../../src/helpers/meetingCoordinatorIpcHandlers"
    );
    const handlers = new Map();
    registerMeetingCoordinatorHandlers(
      {
        handle: (channel: string, listener: any) => handlers.set(channel, listener),
        on: () => {},
      },
      deps
    );
    return handlers;
  } finally {
    Module._load = originalLoad;
  }
}

function loadBundledPreload(transport: any) {
  let api: Record<string, any> | undefined;
  vm.runInNewContext(fs.readFileSync(bundledPreload, "utf8"), {
    // The bundle keeps CJS interop for hybrid manifest modules, so the
    // sandbox needs the same bindings Node's CJS loader provides.
    module: { exports: {} },
    exports: {},
    require(name: string) {
      assert.equal(name, "electron", "the bundled preload must only require electron");
      return {
        contextBridge: {
          exposeInMainWorld: (_name: string, value: any) => {
            api = value;
          },
        },
        ipcRenderer: {
          invoke: (channel: string, ...args: any[]) => transport.invoke(channel, ...args),
          send: (channel: string, ...args: any[]) => transport.send(channel, ...args),
          on: (channel: string, listener: any) => transport.on(channel, listener),
          removeListener: (channel: string, listener: any) => transport.removeListener(channel, listener),
        },
        webUtils: { getPathForFile: () => "" },
      };
    },
    process: { platform: "darwin", versions: {} },
    console,
  });
  if (!api) throw new Error("Bundled preload did not expose its API");
  return api;
}

const plain = (value: any) => JSON.parse(JSON.stringify(value));

async function createFixture({ responses = {}, engine }: {
  responses?: Record<string, (...args: any[]) => unknown>;
  engine?: any;
} = {}) {
  assert.ok(fs.existsSync(bundledPreload), "Run pnpm run build:main first");

  const engineFake = engine ?? {
    getPreferences: () => ({ processDetection: true, audioDetection: false }),
    setPreferences() {},
    async handleNotificationResponse() {},
    async joinCalendarMeeting() {},
    completeAutoEndSession: async (sessionId: any) => sessionId === "meeting-1",
    respondToAutoEndNotification: (sessionId: string, action: string) =>
      sessionId === "meeting-1" && action === "restart",
    setMicWarmHold() {},
  };

  const handlers: Map<string, (...args: any[]) => any> = registerRealHandlers({
    databaseManager: {
      getGoogleAccounts: () => [],
      getNote: () => null,
      getSpeakerMappings: () => [],
      setSpeakerMapping: () => {},
      removeSpeakerMapping: () => {},
      getSpeakerProfiles: () => [],
      upsertSpeakerProfile: () => ({ id: 1 }),
    },
    diarizationManager: { isAvailable: () => false },
    meetingDetectionEngine: engineFake,
    audioTapManager: null,
    whisperManager: { transcribeLocalWhisper: async () => ({}) },
    parakeetManager: { transcribeLocalParakeet: async () => ({}) },
    liveSpeakerIdentifier: {
      isAvailable: () => false,
      start: async () => false,
      stop: async () => ({}),
      feedAudio: async () => undefined,
      recluster: async () => [],
      setEnabled() {},
      setMaxSpeakers() {},
      getSpeakerEmbedding: () => null,
      mapSpeaker() {},
    },
    fetchRealtimeToken: async () => "token",
    resolveWhisperVadOptions: () => ({}),
    speakerEmbeddings: () => ({ cosineSimilarity: () => 0.9 }),
    getControlPanelWindow: () => null,
    getMeetingNotificationData: () => ({ kind: "auto-end", sessionId: "meeting-1", expiresAt: 1 }),
    consumePendingMeetingNoteNavigation: () => ({
      noteId: 7,
      folderId: 3,
      event: null,
      trigger: "hotkey",
    }),
    showNotificationWindow() {},
  });

  const sent: any[] = [];
  const invoked: any[] = [];
  const listeners = new Map();
  const invokeHandler = async (channel: string, ...args: any[]) => {
    invoked.push({ channel, args });
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    if (channel in responses) return responses[channel](...args);
    // Sender-scoped channels (auto-end ack/respond) read event.sender; the
    // fixture's engine fakes ignore it.
    return handler({ sender: null }, ...args);
  };
  const transport = {
    invoke: invokeHandler,
    send: (channel: string, ...args: any[]) => sent.push({ channel, args }),
    on: (channel: string, listener: any) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(listener);
    },
    removeListener: (channel: string, listener: any) => {
      listeners.get(channel)?.delete(listener);
    },
  };
  const api = loadBundledPreload(transport);
  const pushEvent = (channel: string, payload: any) => {
    for (const listener of listeners.get(channel) ?? []) listener({}, payload);
  };
  return { api, pushEvent, sent, invoked, engineFake };
}

test("command shapes cross the bundled preload and results are passed through", async () => {
  const { api } = await createFixture();

  assert.deepEqual(plain(await api.acquireRecordingLock("meeting")), { success: true });
  assert.deepEqual(plain(await api.releaseRecordingLock("meeting")), { success: true });

  const prefs = await api.meetingDetectionGetPreferences();
  assert.deepEqual(plain(prefs), { success: true, preferences: { processDetection: true, audioDetection: false } });

  assert.deepEqual(plain(await api.setSpeakerDiarizationEnabled(false)), { success: true });
  assert.deepEqual(
    plain(await api.setMeetingSessionSpeakerConfig({ enabled: true, expectedCount: 3 })),
    { success: true }
  );
  assert.deepEqual(plain(await api.joinCalendarMeeting("evt-1")), { success: true });
  assert.deepEqual(plain(await api.meetingAutoEndCompleted("meeting-1")), { success: true });
  assert.deepEqual(plain(await api.meetingAutoEndRespond("meeting-1", "restart")), {
    success: true,
  });
  assert.deepEqual(
    plain(await api.getMeetingNotificationData()),
    { kind: "auto-end", sessionId: "meeting-1", expiresAt: 1 }
  );
  assert.deepEqual(plain(await api.getPendingMeetingNoteNavigation()), {
    noteId: 7,
    folderId: 3,
    event: null,
    trigger: "hotkey",
  });
});

test("capture send crosses with source and sequencing metadata and returns its write acknowledgement", async () => {
  const { api, invoked } = await createFixture({
    responses: {
      "meeting-transcription-send": (_buffer: any, _source: any, _sessionId: any, packet: any) => ({
        success: true,
        sequence: packet.sequence,
      }),
    },
  });
  const buffer = new ArrayBuffer(8);
  const sessionId = "capture-session";
  const packet = { epochIndex: 1, epochStartFrame: 24_000, sequence: 3, sampleOffset: 120 };

  assert.deepEqual(plain(await api.meetingTranscriptionSend(buffer, "mic", sessionId, packet)), {
    success: true,
    sequence: 3,
  });
  assert.equal(invoked.length, 1);
  assert.equal(invoked[0].channel, "meeting-transcription-send");
  assert.equal(invoked[0].args[0], buffer);
  assert.deepEqual(invoked[0].args.slice(1), ["mic", sessionId, packet]);
});

test("event payloads reach callbacks and malformed ones are dropped", async () => {
  const { api, pushEvent } = await createFixture();

  const segments: any[] = [];
  const unsubscribe = api.onMeetingTranscriptionSegment?.((data: any) => segments.push(data));
  assert.equal(typeof unsubscribe, "function");

  pushEvent("meeting-transcription-segment", {
    text: "hello",
    source: "mic",
    type: "final",
    timestamp: 12,
  });
  pushEvent("meeting-transcription-segment", { text: 42, source: "mic", type: "final" });
  pushEvent("meeting-transcription-segment", null);

  assert.equal(segments.length, 1);
  assert.deepEqual(plain(segments[0]), {
    text: "hello",
    source: "mic",
    type: "final",
    timestamp: 12,
  });

  const autoEnd: any[] = [];
  const unsubscribeAutoEnd = api.onMeetingAutoEndRequested?.((request: string) => autoEnd.push(request));
  pushEvent("meeting-auto-end-requested", { sessionId: "s1", reason: "silence" });
  pushEvent("meeting-auto-end-requested", { sessionId: 7 });
  assert.deepEqual(plain(autoEnd), [{ sessionId: "s1", reason: "silence" }]);

  unsubscribe?.();
  unsubscribeAutoEnd?.();
  pushEvent("meeting-transcription-segment", {
    text: "after",
    source: "mic",
    type: "final",
  });
  assert.equal(segments.length, 1, "unsubscribe removes exactly its own listener");
});

test("payload-only listeners deliver transcript errors without the event", async () => {
  const { api, pushEvent } = await createFixture();
  const errors: any[] = [];
  api.onMeetingTranscriptionError?.((message: any) => errors.push(message));
  pushEvent("meeting-transcription-error", "provider exploded");
  pushEvent("meeting-transcription-error", 42);
  assert.deepEqual(errors, ["provider exploded"]);
});

test("a junk invoke response rejects at the preload boundary", async () => {
  const { api } = await createFixture({
    responses: {
      "meeting-auto-end-completed": () => ({ unexpected: true }),
    },
  });
  await assert.rejects(() => api.meetingAutoEndCompleted("meeting-1"));
});

test("auto-end lifecycle failures keep their reason across the bridge", async () => {
  const { api } = await createFixture();
  assert.deepEqual(plain(await api.meetingAutoEndCompleted("meeting-other")), {
    success: false,
    reason: "stale-session",
  });
});
