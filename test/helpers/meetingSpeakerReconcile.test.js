const test = require("node:test");
const assert = require("node:assert/strict");
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

const broadcasts = [];

// The publication module pulls the coordinator graph; stub the process
// boundaries and capture broadcasts so the exported functions and the
// coordinator runtime can run against fakes.
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") {
    return electronStub;
  }
  if (request === "./windowBroadcast" || request === "./windowBroadcast.js") {
    return {
      broadcastToWindows: (channel, payload) => {
        broadcasts.push({ channel, payload });
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const publication = require("../../src/helpers/meetingDiarizationPublication");
const {
  registerMeetingCoordinatorHandlers,
} = require("../../src/helpers/meetingCoordinatorIpcHandlers");

Module._load = originalLoad;

const NOTE_ID = 42;
const embedding = Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0));

function createMappingRecorder(existingMappings) {
  const calls = { set: [], remove: [] };
  const databaseManager = {
    getSpeakerMappings: () => existingMappings,
    setSpeakerMapping: (noteId, speakerId, profileId, displayName) => {
      calls.set.push({ noteId, speakerId, profileId, displayName });
    },
    removeSpeakerMapping: (noteId, speakerId) => {
      calls.remove.push({ noteId, speakerId });
    },
  };
  return { calls, databaseManager };
}

const fakeEmbeddings = () => ({ cosineSimilarity: () => 0.9 });

function reconcile(databaseManager, liveSpeakerId) {
  const deps = { databaseManager, speakerEmbeddings: fakeEmbeddings };
  const liveState = {
    [liveSpeakerId]: {
      displayName: "Alice",
      profileId: 5,
      noteId: NOTE_ID,
      embedding,
    },
  };
  const segments = [];
  return publication.reconcileLiveSpeakerState(deps, liveState, { speaker_0: embedding }, segments);
}

test("reconciliation keeps the mapping when live and offline ids already match", () => {
  const { calls, databaseManager } = createMappingRecorder([
    { speaker_id: "speaker_0", display_name: "Alice", profile_id: 5 },
  ]);

  reconcile(databaseManager, "speaker_0");

  assert.equal(calls.set.length, 1);
  assert.deepEqual(calls.set[0], {
    noteId: NOTE_ID,
    speakerId: "speaker_0",
    profileId: 5,
    displayName: "Alice",
  });
  assert.deepEqual(
    calls.remove,
    [],
    "removing the row that was just upserted deletes the user's identification"
  );
});

test("reconciliation migrates the mapping when the offline id differs", () => {
  const { calls, databaseManager } = createMappingRecorder([
    { speaker_id: "speaker_3", display_name: "Alice", profile_id: 5 },
  ]);

  reconcile(databaseManager, "speaker_3");

  assert.equal(calls.set.length, 1);
  assert.equal(calls.set[0].speakerId, "speaker_0");
  assert.deepEqual(calls.remove, [{ noteId: NOTE_ID, speakerId: "speaker_3" }]);
});

const THREE_ATTENDEES = [
  { email: "one@example.com" },
  { email: "two@example.com" },
  { email: "three@example.com" },
];

// The refresh only fires while a recording has linked its session to the
// note. Seed the session through the registered session-speaker-config
// handler and the runtime link, then drive the refresh like the notes
// vertical does.
function refreshConfig(explicit, { expectedCount = 2, attendees = THREE_ATTENDEES } = {}) {
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

  const liveSpeaker = {
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
  };

  const handlers = new Map();
  const runtime = registerMeetingCoordinatorHandlers(
    {
      handle: (channel, listener) => handlers.set(channel, listener),
      on: () => {},
    },
    {
      databaseManager,
      diarizationManager: {},
      meetingDetectionEngine: null,
      audioTapManager: null,
      whisperManager: { transcribeLocalWhisper: async () => ({}) },
      parakeetManager: { transcribeLocalParakeet: async () => ({}) },
      liveSpeakerIdentifier: liveSpeaker,
      fetchRealtimeToken: async () => "token",
      resolveWhisperVadOptions: () => ({}),
      speakerEmbeddings: fakeEmbeddings,
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
  return { runtime, handlers, liveSpeaker };
}

test("roster changes refresh an auto-derived speaker config", () => {
  const { liveSpeaker } = refreshConfig(false);

  assert.equal(liveSpeaker.maxSpeakers, 3);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].channel, "meeting-session-speaker-config-updated");
  assert.deepEqual(broadcasts[0].payload, { enabled: true, expectedCount: 4 });
});

test("an explicit stepper count is never overridden by roster changes", () => {
  refreshConfig(true);

  assert.deepEqual(broadcasts, []);
});

// Lowering the cap below the clusters already discovered makes the identifier
// fold every later voice onto an existing speaker — the collapse this refresh
// exists to prevent. A shrinking or emptied roster must be ignored.
test("a shrinking roster leaves the speaker cap untouched", () => {
  refreshConfig(false, {
    expectedCount: 4,
    attendees: [{ email: "one@example.com" }],
  });
  assert.deepEqual(broadcasts, []);

  refreshConfig(false, { expectedCount: 4, attendees: [] });
  assert.deepEqual(broadcasts, []);
});

function makeExpectationResolver() {
  return (args) =>
    publication.resolveSpeakerExpectation({
      deps: {
        databaseManager: { getNote: () => (args.note === undefined ? null : args.note) },
      },
      sessionConfig: args.sessionConfig ?? null,
      noteId: args.noteId ?? null,
      observedSpeakerIds: args.observedSpeakerIds ?? new Set(),
      diarizedSource: args.diarizedSource,
    });
}

// System mode: only system audio reaches the diarizer (the mic track is "you"),
// so every branch must report `cap` as a count of other speakers (total - 1).
// The no-signal fallback used to return the total itself, which let one remote
// voice split across two labels.
test("speaker expectation reports cap as other-speaker count in every system-mode branch", () => {
  const resolve = makeExpectationResolver();

  assert.deepEqual(
    resolve({ sessionConfig: { expectedCount: 3, explicit: true } }),
    { numSpeakers: 2, cap: 2 },
    "an explicit count of 3 means 2 other speakers"
  );
  assert.deepEqual(
    resolve({ noteId: NOTE_ID, note: { expected_speaker_count: 4 } }),
    { numSpeakers: 3, cap: 3 },
    "a note count outranks a non-explicit session config"
  );
  assert.deepEqual(
    resolve({ observedSpeakerIds: new Set(["speaker_0", "speaker_1"]) }),
    { numSpeakers: 2, cap: 2 },
    "observed ids are already other-speaker ids"
  );
  assert.deepEqual(
    resolve({}),
    { numSpeakers: -1, cap: 1 },
    "the default total of 2 means a single other speaker, not 2"
  );
});

// Mic mode (in-person session): the user is one of the diarized voices, so the
// expected total applies without the -1 the system-mode branches use.
test("mic mode counts the user among the expected speakers", () => {
  const resolve = makeExpectationResolver();

  assert.deepEqual(
    resolve({ sessionConfig: { expectedCount: 3, explicit: true }, diarizedSource: "mic" }),
    { numSpeakers: 3, cap: 3 },
    "an explicit total of 3 stays 3, not total - 1"
  );
  assert.deepEqual(
    resolve({ diarizedSource: "mic" }),
    { numSpeakers: -1, cap: 2 },
    "the no-signal fallback caps at the default expected total, user included"
  );
});
