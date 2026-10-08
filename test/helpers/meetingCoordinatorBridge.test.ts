// The real bundled preload talks to the real typed meeting coordinator over
// fakes: command shapes crossing the wire, event payloads reaching callbacks
// with malformed ones dropped, payload-only listeners, unsubscribe removing
// exactly its own listener, and junk invoke responses rejected at the preload
// boundary. Run pnpm run build:main first so dist-main/preload.js exists.
const test: typeof import("node:test") = require("node:test");

const { loadBundledPreload: loadPreload, plain }: typeof import("./harness/bundledPreload.ts") = require("./harness/bundledPreload.ts");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const Module = require("node:module");

import type { MeetingCoordinatorDeps } from "../../src/helpers/meetingCoordinatorIpcHandlers.ts";
import type {
  MeetingAutoEndRequest,
  MeetingCoordinatorApi,
  MeetingSegmentEvent,
} from "../../src/contracts/meetingCoordinator.ts";

const requiredMethods = [
  "finishPausedMeetRecording",
  "getMeetIntegrationSetup",
  "configureMeetIntegration",
  "respondMeetContextReminder",
  "claimMeetingAutoEnd",
  "getMeetCompanionStatus",
  "confirmMeetCompanionBinding",
  "onMeetCompanionStatus",
  "onMeetManualMute",
  "onMeetPlatformMute",
  "acquireRecordingLock",
  "releaseRecordingLock",
  "meetingDetectionGetPreferences",
  "setMeetingSessionSpeakerConfig",
  "joinCalendarMeeting",
  "findCalendarEventNote",
  "createCalendarEventNote",
  "meetingAutoEndCompleted",
  "meetingAutoEndRespond",
  "getMeetingNotificationData",
  "getPendingMeetingNoteNavigation",
  "meetingTranscriptionSend",
  "onMeetingTranscriptionSegment",
  "onMeetingAutoEndRequested",
  "onMeetingTranscriptionError",
] as const satisfies readonly (keyof MeetingCoordinatorApi)[];

type TestedApi = MeetingCoordinatorApi &
  Required<Pick<MeetingCoordinatorApi, (typeof requiredMethods)[number]>>;

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

function unused(): never {
  throw new Error("Unexpected coordinator dependency call");
}

function registerRealHandlers(deps: MeetingCoordinatorDeps) {
  Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === "electron") return electronStub;

    if (request === "./windowBroadcast" || request === "./windowBroadcast.js") {
      return { broadcastToWindows: () => {} };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const {
      registerMeetingCoordinatorHandlers,
    }: typeof import("../../src/helpers/meetingCoordinatorIpcHandlers") = require("../../src/helpers/meetingCoordinatorIpcHandlers");

    const handlers = new Map();
    registerMeetingCoordinatorHandlers(
      {
        handle: (channel: string, listener: unknown) => handlers.set(channel, listener),
        on: () => {},
      },
      deps
    );

    return handlers;
  } finally {
    Module._load = originalLoad;
  }
}

function loadBundledPreload(transport: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}): TestedApi {
  const api = loadPreload<TestedApi>(transport);

  for (const method of requiredMethods) {
    assert.equal(
      typeof Reflect.get(api, method),
      "function",
      `${method} must be exposed`
    );
  }

  return api;
}

async function createFixture({
  responses = {},
  engine,
}: {
  responses?: Record<string, (...args: unknown[]) => unknown>;
  engine?: MeetingCoordinatorDeps["meetingDetectionEngine"];
} = {}) {

  const engineFake = engine ?? {
    getPreferences: () => ({ processDetection: true, audioDetection: false }),
    setPreferences() {},
    async handleNotificationResponse() {},
    async joinCalendarMeeting() {},
    findCalendarEventNote: (eventId: string) =>
      eventId === "evt-1" ? { noteId: 42, folderId: 7 } : null,
    createCalendarEventNote: (eventId: string, initial: { content?: string }) =>
      eventId === "evt-2" && initial.content === "Hi" ? { noteId: 43, folderId: 7 } : null,
    completeAutoEndSession: async (sessionId: string) => sessionId === "meeting-1",
    respondToAutoEndNotification: (sessionId: string, action: string) =>
      sessionId === "meeting-1" && action === "restart",
    setMicWarmHold() {},
    setUserRecording: unused,
    beginRecordingSession: unused,
    endRecordingSession: unused,
    recordMeetingAudioChunk: unused,
    setRecordingSystemAudioAvailable: unused,
  };

  const handlers: Map<string, (...args: unknown[]) => unknown> = registerRealHandlers({
    databaseManager: {
      saveMeetingPlatformObservation() {},
      saveMeetingAudioClockAnchor() {},
      setMeetingPlatformCoverage() {},
      getGoogleAccounts: () => [],
      getNote: () => null,
      setMeetingRecordingMicIntentionallyEmpty: unused,
      createMeetingRecording: unused,
      createMeetingRecordingEpoch: unused,
      updateMeetingRecordingEpochRecovery: unused,
      addMeetingRecordingEpochAlignment: () =>
        ({}) as import("../../src/contracts/meetingRecording.js").MeetingRecordingEpochDto,
      markMeetingRecordingEpochAlignmentUnknown() {},
      openMeetingIntentionalInterval: () => ({
        id: "interval-1",
        recordingId: "recording-1",
        source: "mic",
        sourceGeneration: 1,
        sourceStartFrame: 0,
        sourceEndFrame: null,
        timelineStartFrame: 0,
        timelineEndFrame: null,
        startAlignment: null,
        endAlignment: null,
        reason: "manual-muted",
      }),
      closeMeetingIntentionalInterval: () => null,
      listMeetingIntentionalIntervals: () => [],
      markMeetingRecordingFinalizing: unused,
      finalizeMeetingRecording: unused,
    },
    meetingRecordingStorage: {
      openEpochWriter: unused,
      appendEpochSamples: unused,
      closeEpochWriter: unused,
      recoverEpoch: unused,
    },
    meetingDetectionEngine: engineFake,
    audioTapManager: null,
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

  const sent: { channel: string; args: unknown[] }[] = [];
  const invoked: { channel: string; args: unknown[] }[] = [];
  const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>();

  const invokeHandler = async (channel: string, ...args: unknown[]) => {
    invoked.push({ channel, args });

    if (channel in responses) return responses[channel](...args);
    const handler = handlers.get(channel);

    if (!handler) throw new Error(`No handler for ${channel}`);

    // Sender-scoped channels (auto-end ack/respond) read event.sender; real
    // invoke events always carry one, so the fixture provides a stand-in and
    // the engine fakes ignore it.
    return handler({ sender: { isDestroyed: () => false } }, ...args);
  };

  const transport = {
    invoke: invokeHandler,
    send: (channel: string, ...args: unknown[]) => {
      sent.push({ channel, args });
    },
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      const channelListeners =
        listeners.get(channel) ?? new Set<(event: unknown, payload: unknown) => void>();

      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
    },
    removeListener: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      listeners.get(channel)?.delete(listener);
    },
  };

  const api = loadBundledPreload(transport);

  const pushEvent = (channel: string, payload: unknown) => {
    for (const listener of listeners.get(channel) ?? []) listener({}, payload);
  };

  return { api, pushEvent, sent, invoked, engineFake };
}

test("command shapes cross the bundled preload and results are passed through", async () => {
  const { api } = await createFixture();

  assert.deepEqual(plain(await api.acquireRecordingLock("meeting")), { success: true });
  assert.deepEqual(plain(await api.releaseRecordingLock("meeting")), { success: true });

  const prefs = await api.meetingDetectionGetPreferences();
  assert.deepEqual(plain(prefs), {
    success: true,
    preferences: { processDetection: true, audioDetection: false },
  });

  assert.deepEqual(
    plain(await api.setMeetingSessionSpeakerConfig({ enabled: true, expectedCount: 3 })),
    { success: true }
  );
  assert.deepEqual(plain(await api.joinCalendarMeeting("evt-1")), { success: true });
  assert.deepEqual(plain(await api.findCalendarEventNote("evt-1")), { noteId: 42, folderId: 7 });
  assert.equal(await api.findCalendarEventNote("missing"), null);
  assert.deepEqual(plain(await api.createCalendarEventNote("evt-2", { content: "Hi" })), {
    noteId: 43,
    folderId: 7,
  });
  assert.deepEqual(plain(await api.meetingAutoEndCompleted("meeting-1")), { success: true });
  assert.deepEqual(plain(await api.meetingAutoEndRespond("meeting-1", "restart")), {
    success: true,
  });
  assert.deepEqual(plain(await api.getMeetingNotificationData()), {
    kind: "auto-end",
    sessionId: "meeting-1",
    expiresAt: 1,
  });
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
      "meeting-transcription-send": (
        _buffer: unknown,
        _source: unknown,
        _sessionId: unknown,
        packet: any
      ) => ({
        success: true,
        sequence: packet.sequence,
      }),
    },
  });

  const buffer = new ArrayBuffer(8);
  const sessionId = "capture-session";

  const packet = {
    epochIndex: 1,
    epochSourceStartFrame: 24_000,
    sourceFrameStart: 24_120,
    alignment: null,
    alignmentErrorCode: "audio-alignment-unavailable",
    sourceGeneration: 1,
    sequence: 3,
    sampleOffset: 120,
  };

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

  const segments: MeetingSegmentEvent[] = [];

  const unsubscribe = api.onMeetingTranscriptionSegment((data) => {
    segments.push(data);
  });

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

  const autoEnd: MeetingAutoEndRequest[] = [];

  const unsubscribeAutoEnd = api.onMeetingAutoEndRequested((request) => {
    autoEnd.push(request);
  });

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
  const errors: string[] = [];
  api.onMeetingTranscriptionError((message) => {
    errors.push(message);
  });
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

test("Companion commands use the desktop contract and report unavailable/stale state", async () => {
  const setup = {
    enabled: false,
    installed: false,
    extensionPath: "/isolated/companion",
    channel: "development",
  };

  const { api, invoked } = await createFixture({
    responses: {
      "meet-integration-setup": () => setup,
      "meet-integration-configure": () => ({ success: false, error: "Owned profile mismatch" }),
    },
  });

  assert.deepEqual(plain(await api.getMeetIntegrationSetup()), setup);
  assert.deepEqual(plain(await api.configureMeetIntegration("enable")), {
    success: false,
    error: "Owned profile mismatch",
  });
  const status = await api.getMeetCompanionStatus();
  assert.equal(status.binding, null);

  const scope = {
    recordingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  };

  assert.deepEqual(plain(await api.respondMeetContextReminder({ ...scope, action: "stop" })), {
    success: false,
  });
  assert.deepEqual(plain(await api.finishPausedMeetRecording(scope.recordingId)), {
    success: false,
  });
  assert.deepEqual(plain(await api.claimMeetingAutoEnd(scope.sessionId)), { success: false });
  assert.deepEqual(
    plain(
      await api.confirmMeetCompanionBinding({
        expected: scope,
        candidate: {
          connectionId: scope.recordingId,
          ref: {
            platform: "google-meet",
            installationId: scope.recordingId,
            sessionId: scope.sessionId,
            tabId: 1,
            documentId: "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa",
            callId: "abc-defg-hij",
          },
        },
      })
    ),
    { success: false }
  );
  assert.deepEqual(plain(invoked[1]), { channel: "meet-integration-configure", args: ["enable"] });
});

test("Companion events validate scope and unsubscribe only their own listeners", async () => {
  const { api, pushEvent } = await createFixture();
  const events: unknown[] = [];
  const retained: unknown[] = [];

  const cleanups = [
    api.onMeetCompanionStatus((value) => events.push(value)),
    api.onMeetManualMute((value) => events.push(value)),
    api.onMeetPlatformMute((value) => events.push(value)),
  ];

  const retain = api.onMeetManualMute((value) => retained.push(value));
  const status = await api.getMeetCompanionStatus();

  const mute = {
    recordingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    muted: true,
  };

  pushEvent("meet-companion-status", {});
  pushEvent("meet-manual-mute", { ...mute, recordingId: "invalid" });
  pushEvent("meet-platform-mute", { ...mute, sessionId: "invalid" });
  assert.equal(events.length, 0);
  pushEvent("meet-companion-status", status);
  pushEvent("meet-manual-mute", mute);
  pushEvent("meet-platform-mute", mute);
  assert.deepEqual(plain(events), [plain(status), mute, mute]);
  cleanups.forEach((cleanup) => cleanup());
  pushEvent("meet-companion-status", status);
  pushEvent("meet-manual-mute", mute);
  pushEvent("meet-platform-mute", mute);
  assert.equal(events.length, 3);
  assert.equal(retained.length, 2);
  retain();
});

test("Companion malformed invoke results reject at the bundled preload", async () => {
  const { api } = await createFixture({
    responses: {
      "meet-integration-setup": () => ({ enabled: false }),
      "meet-companion-status": () => ({ enabled: false }),
      "meet-integration-configure": () => ({ error: "missing success" }),
    },
  });

  await assert.rejects(() => api.getMeetIntegrationSetup());
  await assert.rejects(() => api.getMeetCompanionStatus());
  await assert.rejects(() => api.configureMeetIntegration("enable"));
});
