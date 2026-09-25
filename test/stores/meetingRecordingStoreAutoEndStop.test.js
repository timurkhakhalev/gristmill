const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

const RECORDING_ID = "a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1";
const RUN_ID = "b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2";
const START_ARGS = {
  noteId: 11,
  noteTitle: "Standup",
  folderId: null,
  autoEndEligible: true,
};

function createElectronAPI({ stopResult }) {
  const noopListener = () => () => {};
  const notes = new Map([[11, { id: 11, transcript: "Keep this transcript" }]]);
  const api = {
    stopRequests: [],
    noteUpdates: [],
    api: null,
  };
  api.api = {
    checkSystemAudioAccess: async () => ({
      granted: true,
      status: "granted",
      mode: "native",
      strategy: "native",
    }),
    meetingTranscriptionStart: async () => ({
      success: true,
      recordingId: RECORDING_ID,
      originAt: new Date().toISOString(),
      systemAudioMode: "native",
      systemAudioStrategy: "native",
    }),
    meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
    meetingTranscriptionStop: async (request) => {
      api.stopRequests.push(request);
      return stopResult();
    },
    meetingTranscriptionSend: async (_buffer, _source, _sessionId, packet) => ({
      success: true,
      sequence: packet.sequence,
    }),
    getNote: async (id) => notes.get(id) ?? null,
    updateNote: async (id, value) => {
      api.noteUpdates.push({ id, value });
      return { success: true };
    },
    onMeetingTranscriptionError: noopListener,
    onMeetingTranscriptionFatalError: noopListener,
    onMeetingSystemAudioSilent: noopListener,
    onMeetingDiarizationComplete: noopListener,
    onMeetingSystemAudioInterrupted: noopListener,
    onMeetingSystemAudioResumed: noopListener,
    onMeetingTranscriptionStopRequested: noopListener,
  };
  return api;
}

async function loadStore(t, api) {
  installMicCaptureGlobals(t);
  installBrowserGlobals(t, {
    window: { electronAPI: api.api },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openhercules-meeting-capture-stop-test-",
  });
  return vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
}

const finalized = (captureState = "ready") => ({
  success: true,
  recordingId: RECORDING_ID,
  initialRunId: RUN_ID,
  captureState,
  errorCode: captureState === "ready" ? null : "system-source-unavailable",
});

test("normal stop drains and finalizes one raw recording without writing the note transcript", async (t) => {
  const api = createElectronAPI({ stopResult: () => finalized() });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal(store.useMeetingRecordingStore.getState().capturePhase, "recording");
  const result = await store.stopRecording();

  assert.equal(result.stopped, true);
  assert.equal(store.useMeetingRecordingStore.getState().capturePhase, "saved");
  assert.equal(api.stopRequests.length, 1);
  assert.equal(typeof api.stopRequests[0].sessionId, "string");
  assert.deepEqual(api.stopRequests[0].lastSequence, { mic: -1, system: -1 });
  assert.equal(api.stopRequests[0].incomplete, false);
  assert.deepEqual(api.noteUpdates, []);
});

test("a failed main finalization is surfaced as incomplete", async (t) => {
  const api = createElectronAPI({
    stopResult: () => ({ success: false, error: "audio tail could not be finalized" }),
  });
  const store = await loadStore(t, api);

  await store.startRecording(START_ARGS);
  const result = await store.stopRecording();

  assert.equal(result.stopped, false);
  assert.equal(store.useMeetingRecordingStore.getState().capturePhase, "incomplete");
  assert.equal(store.useMeetingRecordingStore.getState().captureErrorCode, "capture-finalize-failed");
  assert.deepEqual(api.noteUpdates, []);
});

test("a stale stop and a rejected stop do not claim success", async (t) => {
  const staleApi = createElectronAPI({ stopResult: () => ({ success: false, reason: "stale-session" }) });
  const staleStore = await loadStore(t, staleApi);
  await staleStore.startRecording(START_ARGS);
  assert.equal((await staleStore.stopRecording()).stopped, false);

  const failedApi = createElectronAPI({ stopResult: () => { throw new Error("ipc channel closed"); } });
  const failedStore = await loadStore(t, failedApi);
  await failedStore.startRecording(START_ARGS);
  assert.equal((await failedStore.stopRecording()).stopped, false);
});

test("empty stop preserves existing note text and transcript", async (t) => {
  const api = createElectronAPI({ stopResult: () => finalized() });
  const store = await loadStore(t, api);

  assert.equal((await store.stopRecording()).stopped, false);
  assert.deepEqual(api.noteUpdates, []);
});

test("a scoped stop for another session leaves capture active", async (t) => {
  const api = createElectronAPI({ stopResult: () => finalized() });
  const store = await loadStore(t, api);

  await store.startRecording(START_ARGS);
  assert.equal((await store.stopRecording("some-other-session")).stopped, false);
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, true);
  await store.stopRecording();
});
