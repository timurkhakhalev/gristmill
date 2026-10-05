const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const Module = require("node:module");

const originalLoad = Module._load;

const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  BrowserWindow: class BrowserWindow {
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

const broadcasts: { channel: string; payload: unknown }[] = [];

// Stub process boundaries and capture coordinator broadcasts.
Module._load = function loadWithMocks(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return electronStub;
  }

  if (request === "./windowBroadcast" || request === "./windowBroadcast.js") {
    return {
      broadcastToWindows: (channel: string, payload: unknown) => {
        broadcasts.push({ channel, payload });
      },
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

const {
  registerMeetingCoordinatorHandlers,
} = require("../../src/helpers/meetingCoordinatorIpcHandlers");

Module._load = originalLoad;

const NOTE_ID = 42;

const THREE_ATTENDEES = [
  { email: "one@example.com" },
  { email: "two@example.com" },
  { email: "three@example.com" },
];

// The refresh only fires while a recording has linked its session to the
// note. Seed the session through the registered session-speaker-config
// handler and the runtime link, then drive the refresh like the notes
// vertical does.
function refreshConfig(explicit: unknown, { expectedCount = 2, attendees = THREE_ATTENDEES } = {}) {
  const databaseManager = {
    getGoogleAccounts: () => [],
    getNote: () => null,
    getSpeakerMappings: () => [],
    setSpeakerMapping: () => {},
    removeSpeakerMapping: () => {},
    getSpeakerProfiles: () => [],
    upsertSpeakerProfile: () => ({ id: 1 }),
  };

  broadcasts.length = 0;

  const handlers = new Map();

  const runtime = registerMeetingCoordinatorHandlers(
    {
      handle: (channel: string, listener: unknown) => handlers.set(channel, listener),
      on: () => {},
    },
    {
      databaseManager,
      diarizationManager: {},
      meetingDetectionEngine: null,
      audioTapManager: null,
      whisperManager: { transcribeLocalWhisper: async () => ({}) },
      parakeetManager: { transcribeLocalParakeet: async () => ({}) },
      fetchRealtimeToken: async () => "token",
      resolveWhisperVadOptions: () => ({}),
    }
  );

  handlers.get("meeting-set-session-speaker-config")(null, {
    enabled: true,
    expectedCount,
    countIsExplicit: explicit,
  });
  // Recording start links the session to the note before any roster refresh.
  runtime.linkRecordingSessionToNote(NOTE_ID);

  runtime.refreshMeetingSpeakerConfigFromNote(NOTE_ID, {
    participants: JSON.stringify(attendees),
  });

  return { runtime, handlers };
}

test("roster changes refresh an auto-derived speaker config", () => {
  refreshConfig(false);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].channel, "meeting-session-speaker-config-updated");
  assert.deepEqual(broadcasts[0].payload, { enabled: true, expectedCount: 4 });
});

test("an explicit stepper count is never overridden by roster changes", () => {
  refreshConfig(true);

  assert.deepEqual(broadcasts, []);
});

// A smaller roster must not discard a previously observed participant count.
test("a shrinking roster leaves the speaker cap untouched", () => {
  refreshConfig(false, {
    expectedCount: 4,
    attendees: [{ email: "one@example.com" }],
  });
  assert.deepEqual(broadcasts, []);

  refreshConfig(false, { expectedCount: 4, attendees: [] });
  assert.deepEqual(broadcasts, []);
});
