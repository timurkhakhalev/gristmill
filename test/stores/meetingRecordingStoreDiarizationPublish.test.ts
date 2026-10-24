const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
}: typeof import("../lib/rendererTestHarness.ts") = require("../lib/rendererTestHarness.ts");

type TestContext = import("node:test").TestContext;

interface DiarizationEvent {
  noteId: number;
  sessionId: string;
  segments: Array<{ id: string; text: string; speaker: string; speakerName: string }>;
}

// Delayed diarization is always persisted to the note that owns its session.
// Publishing it to the UI is separate, and must not happen while a recording is
// still appending to that same note: the editor prefers a published overlay to
// the note's own text, so the live half would look like it had vanished.

const NOTE_ID = 11;

const START_ARGS = { noteId: NOTE_ID, noteTitle: "Standup", folderId: null, autoEndEligible: true };

function createElectronAPI() {
  const noopListener = () => () => {};

  const state: {
    diarizationCallback: ((data: DiarizationEvent) => void) | null;
    updatedTranscripts: Array<{ id: number; transcript: string }>;
  } = { diarizationCallback: null, updatedTranscripts: [] };

  const notes = new Map<number, { id: number; transcript: string }>([
    [NOTE_ID, { id: NOTE_ID, transcript: "" }],
  ]);

  const api = {
    checkSystemAudioAccess: async () => ({
      granted: true,
      status: "granted",
      mode: "native",
      strategy: "native",
    }),
    onMeetManualMute: () => () => {},
    onMeetPlatformMute: () => () => {},
    getActions: async () => [],
    meetingTranscriptionStart: async () => ({
      success: true,
      recordingId: "00000000-0000-4000-8000-000000000001",
      originAt: new Date().toISOString(),
      systemAudioMode: "native",
      systemAudioStrategy: "native",
    }),
    meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
    meetingTranscriptionStop: async () => ({ success: true, diarizationSessionId: null }),
    meetingTranscriptionSend: () => {},
    getNote: async (id: number) => notes.get(id) ?? null,
    updateNote: async (id: number, patch: { transcript: string }) => {
      state.updatedTranscripts.push({ id, transcript: patch.transcript });
      const note = notes.get(id);

      if (note) note.transcript = patch.transcript;

      return { success: true };
    },
    saveNoteSpeakerEmbeddings: async () => ({ success: true }),
    onMeetingDiarizationComplete: (callback: (data: DiarizationEvent) => void) => {
      state.diarizationCallback = callback;

      return () => {
        state.diarizationCallback = null;
      };
    },
    onMeetingTranscriptionSegment: noopListener,
    onMeetingSpeakerIdentified: noopListener,
    onMeetingSpeakersMerged: noopListener,
    onMeetingSessionSpeakerConfigUpdated: noopListener,
    onMeetingTranscriptionError: noopListener,
    onMeetingTranscriptionFatalError: noopListener,
    onMeetingSystemAudioSilent: noopListener,
  };

  return { api, state };
}

async function loadStore(t: TestContext, api: Record<string, unknown>) {
  installMicCaptureGlobals(t);
  installBrowserGlobals(t, {
    window: { electronAPI: api, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) },
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-diarization-publish-test-",
  });

  return vite.ssrLoadModule("/stores/meetingRecordingStore.ts") as Promise<
    typeof import("../../src/stores/meetingRecordingStore.ts")
  >;
}

const ENRICHED = [{ id: "d0", text: "hello there", speaker: "speaker_0", speakerName: "Ada" }];

// The serial queue behind the listener awaits getNote and updateNote.
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

test("a finished session's diarization is not published over the recording that resumed its note", async (t: TestContext) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);
  assert.equal(typeof state.diarizationCallback, "function");

  assert.equal(await store.startRecording(START_ARGS), true);
  state.updatedTranscripts.length = 0;

  state.diarizationCallback!({
    noteId: NOTE_ID,
    sessionId: "diar-before-restart",
    segments: ENRICHED,
  });
  await settle();

  assert.equal(
    store.useMeetingRecordingStore.getState().completedDiarization,
    null,
    "the finished half must not paint over the live recording"
  );
  // Suppressing the overlay must not cost the enrichment its write.
  assert.equal(state.updatedTranscripts.length, 1);
  assert.match(state.updatedTranscripts[0].transcript, /Ada/);

  await store.stopRecording();
});

test("the same result publishes normally once the recording has stopped", async (t: TestContext) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  await store.stopRecording();

  state.diarizationCallback!({
    noteId: NOTE_ID,
    sessionId: "diar-after-stop",
    segments: ENRICHED,
  });
  await settle();

  const published = store.useMeetingRecordingStore.getState().completedDiarization;
  assert.equal(published?.noteId, NOTE_ID);
  assert.equal(published?.segments.length, 1);
});

test("a live recording on another note does not suppress the publish", async (t: TestContext) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording({ ...START_ARGS, noteId: 99 }), true);

  state.diarizationCallback!({
    noteId: NOTE_ID,
    sessionId: "diar-other-note",
    segments: ENRICHED,
  });
  await settle();

  assert.equal(store.useMeetingRecordingStore.getState().completedDiarization?.noteId, NOTE_ID);
  await store.stopRecording();
});
