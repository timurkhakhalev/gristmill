const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
}: typeof import("../lib/rendererTestHarness.ts") = require("../lib/rendererTestHarness.ts");

type TestContext = import("node:test").TestContext;

interface StopRequest {
  suppressProcessing?: boolean;
  sessionId?: string;
  lastSequence?: { mic: number; system: number };
  incomplete?: boolean;
  errorCode?: string | null;
}

interface RecordingEntry {
  recording: {
    id: string;
    groupId: string | null;
    audioState: string;
    captureState: string;
    startedAt: string;
  };
  runs: Array<{ run: Record<string, unknown>; transcript?: { text: string } }>;
}

interface MeetingElectronAPI {
  getActions(): Promise<[]>;
  onMeetManualMute(): () => void;
  onMeetPlatformMute(): () => void;
  finishPausedMeetRecording(recordingId: string): Promise<{ success: boolean }>;
  checkSystemAudioAccess(): Promise<{
    granted: boolean;
    status: string;
    mode: string;
    strategy: string;
  }>;
  meetingTranscriptionStart(options: { groupId: string }): Promise<{
    success: boolean;
    recordingId: string;
    originAt: string;
    systemAudioMode: string;
    systemAudioStrategy: string;
  }>;
  meetingTranscriptionSetSystemAudioAvailable(): Promise<{ success: boolean }>;
  meetingTranscriptionStop(request: StopRequest): Promise<unknown>;
  meetingTranscriptionSend(
    _buffer: unknown,
    _source: unknown,
    _sessionId: unknown,
    packet: { sequence: number }
  ): Promise<{ success: boolean; sequence: number }>;
  getNote(id: number): Promise<{ id: number; transcript: string } | null>;
  updateNote(id: number, value: Record<string, unknown>): Promise<{ success: boolean }>;
  meetingProcessingListForNote(): Promise<{ success: boolean; recordings: RecordingEntry[] }>;
  meetingProcessingFinishForNote(noteId: number): Promise<{ success: boolean; error?: string }>;
  onMeetingTranscriptionError(listener: (error: string) => void): () => void;
  onMeetingTranscriptionFatalError(listener: (error: string) => void): () => void;
  onMeetingSystemAudioSilent(listener: (data: { systemAudioStrategy: string }) => void): () => void;
  onMeetingDiarizationComplete(listener: (data: unknown) => void): () => void;
  onMeetingSystemAudioInterrupted(listener: (data: unknown) => void): () => void;
  onMeetingSystemAudioResumed(listener: () => void): () => void;
  onMeetingTranscriptionStopRequested(listener: (request: unknown) => void): () => void;
}

interface ElectronAPIHarness {
  startRequests: Array<{ groupId: string }>;
  stopRequests: StopRequest[];
  noteUpdates: Array<{ id: number; value: Record<string, unknown> }>;
  recordings: RecordingEntry[];
  processingRequests: number[];
  api: MeetingElectronAPI;
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
    cachePrefix: "gristmill-meeting-capture-stop-test-",
  }));
}

const RECORDING_ID = "a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1";

const RUN_ID = "b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2";

const SECOND_RECORDING_ID = "d4d4d4d4-4444-4444-8444-d4d4d4d4d4d4";

const START_ARGS = {
  noteId: 11,
  noteTitle: "Standup",
  folderId: null,
  autoEndEligible: true,
};

function createElectronAPI({ stopResult }: { stopResult: () => unknown }) {
  const noopListener = () => () => {};

  const notes = new Map<number, { id: number; transcript: string }>([
    [11, { id: 11, transcript: "Keep this transcript" }],
  ]);

  const api: ElectronAPIHarness = {
    startRequests: [],
    stopRequests: [],
    noteUpdates: [],
    recordings: [],
    processingRequests: [],
    api: {
      checkSystemAudioAccess: async () => ({
        granted: true,
        status: "granted",
        mode: "native",
        strategy: "native",
      }),
      onMeetManualMute: () => () => {},
      onMeetPlatformMute: () => () => {},
      getActions: async () => [],
      meetingTranscriptionStart: async (options) => {
        api.startRequests.push(options);

        return {
          success: true,
          recordingId: RECORDING_ID,
          originAt: new Date().toISOString(),
          systemAudioMode: "native",
          systemAudioStrategy: "native",
        };
      },
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
      meetingProcessingListForNote: async () => ({ success: true, recordings: api.recordings }),
      finishPausedMeetRecording: async () => ({ success: true }),
      meetingProcessingFinishForNote: async (noteId) => {
        api.processingRequests.push(noteId);

        return { success: true };
      },
      onMeetingTranscriptionError: noopListener,
      onMeetingTranscriptionFatalError: noopListener,
      onMeetingSystemAudioSilent: noopListener,
      onMeetingDiarizationComplete: noopListener,
      onMeetingSystemAudioInterrupted: noopListener,
      onMeetingSystemAudioResumed: noopListener,
      onMeetingTranscriptionStopRequested: noopListener,
    },
  };

  return api;
}

async function loadStore(t: TestContext, api: ElectronAPIHarness) {
  installMicCaptureGlobals(t);
  installBrowserGlobals(t, {
    window: { electronAPI: api.api },
  });
  const vite = await getVite();
  const module = await vite.moduleGraph.getModuleByUrl("/stores/meetingRecordingStore.ts");

  if (module) vite.moduleGraph.invalidateModule(module);

  return vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
}

const finalized = (captureState = "ready") => ({
  success: true,
  recordingId: RECORDING_ID,
  initialRunId: RUN_ID,
  captureState,
  errorCode: captureState === "ready" ? null : "system-source-unavailable",
});

test("ending a paused call sends its Note identity without stopping capture again", async (t: TestContext) => {
  const api = createElectronAPI({ stopResult: () => finalized() });
  const store = await loadStore(t, api);
  const initial = store.useMeetingRecordingStore.getState();
  assert.deepEqual(initial.segments, []);
  assert.equal(initial.micPartial, "");
  assert.equal(initial.systemPartial, "");
  assert.equal(await store.startRecording(START_ARGS), true);
  const groupId = store.useMeetingRecordingStore.getState().meetingGroupId;
  api.recordings = [
    {
      recording: {
        id: RECORDING_ID,
        groupId,
        audioState: "available",
        captureState: "ready",
        startedAt: new Date().toISOString(),
      },
      runs: [
        {
          run: {
            id: RUN_ID,
            kind: "initial",
            errorCode: null,
            config: {
              transcription: {
                mode: "providers",
                provider: "elevenlabs",
                model: "scribe_v2",
                language: "en",
              },
            },
            configError: null,
          },
        },
      ],
    },
  ];
  assert.equal(await store.pauseMeeting(), true);
  assert.equal(api.stopRequests[0].suppressProcessing, true);
  assert.equal(store.useMeetingRecordingStore.getState().capturePhase, "paused");
  assert.equal(await store.finishMeeting(), true);
  assert.equal(api.stopRequests.length, 1, "paused call has no active capture to stop again");
  assert.deepEqual(api.processingRequests, [START_ARGS.noteId]);
  await store.queueMeetingNoteProcessing(START_ARGS.noteId);
  assert.deepEqual(
    api.processingRequests,
    [START_ARGS.noteId, START_ARGS.noteId],
    "main owns repeated-Finish deduplication"
  );
  assert.equal(store.useMeetingRecordingStore.getState().capturePhase, "saved");
});

test("ending a paused call leaves empty-source decisions to main", async (t: TestContext) => {
  const api = createElectronAPI({ stopResult: () => finalized() });
  const store = await loadStore(t, api);
  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal(await store.pauseMeeting(), true);
  assert.equal(await store.finishMeeting(), true);
  assert.deepEqual(api.processingRequests, [START_ARGS.noteId]);
  assert.equal(store.useMeetingRecordingStore.getState().capturePhase, "saved");
});

test("processing a Note delegates source chronology and config selection to main", async (t: TestContext) => {
  const api = createElectronAPI({ stopResult: () => finalized() });
  const store = await loadStore(t, api);

  const runs = [
    {
      run: {
        kind: "initial",
        errorCode: null,
        config: {
          transcription: {
            mode: "providers",
            provider: "elevenlabs",
            model: "scribe_v2",
            language: "en",
          },
        },
      },
    },
  ];

  api.recordings = [
    {
      recording: {
        id: SECOND_RECORDING_ID,
        groupId: "new-group",
        audioState: "available",
        captureState: "ready",
        startedAt: "2026-09-30T10:30:00.000Z",
      },
      runs: [...runs],
    },
    {
      recording: {
        id: RECORDING_ID,
        groupId: "old-group",
        audioState: "available",
        captureState: "incomplete",
        startedAt: "2026-09-30T10:07:00.000Z",
      },
      runs: [
        { run: { kind: "initial", config: null, errorCode: "detailed-notes-action-missing" } },
      ],
    },
  ];
  await store.queueMeetingNoteProcessing(START_ARGS.noteId);
  assert.deepEqual(api.processingRequests, [START_ARGS.noteId]);
});

test("resume adds a second saved part to one whole-meeting processing run", async (t: TestContext) => {
  let stopCount = 0;

  const api = createElectronAPI({
    stopResult: () => ({
      ...finalized(),
      recordingId: ++stopCount === 1 ? RECORDING_ID : SECOND_RECORDING_ID,
    }),
  });

  const store = await loadStore(t, api);
  assert.equal(await store.startRecording(START_ARGS), true);
  const groupId = store.useMeetingRecordingStore.getState().meetingGroupId;
  api.recordings = [
    {
      recording: {
        id: RECORDING_ID,
        groupId,
        audioState: "available",
        captureState: "ready",
        startedAt: "2026-09-25T10:00:00.000Z",
      },
      runs: [
        {
          run: {
            kind: "initial",
            errorCode: null,
            config: {
              transcription: {
                mode: "providers",
                provider: "elevenlabs",
                model: "scribe_v2",
                language: "en",
              },
            },
          },
        },
      ],
    },
  ];
  assert.equal(await store.pauseMeeting(), true);
  api.api.meetingTranscriptionStart = async () => ({
    success: true,
    recordingId: SECOND_RECORDING_ID,
    originAt: new Date().toISOString(),
    systemAudioMode: "native",
    systemAudioStrategy: "native",
  });
  assert.equal(await store.resumeMeeting(START_ARGS), true);
  assert.equal(store.useMeetingRecordingStore.getState().meetingGroupId, groupId);
  api.recordings.push({
    recording: {
      id: SECOND_RECORDING_ID,
      groupId,
      audioState: "available",
      captureState: "ready",
      startedAt: "2026-09-25T10:01:00.000Z",
    },
    runs: [{ run: { kind: "initial", errorCode: null, config: null } }],
  });
  assert.equal(await store.finishMeeting(), true);
  assert.deepEqual(api.processingRequests, [START_ARGS.noteId]);
  assert.deepEqual(
    api.stopRequests.map((request) => request.suppressProcessing),
    [true, true]
  );
  assert.equal(api.processingRequests.length, 1);
});

test("normal stop drains and finalizes one raw recording without writing the note transcript", async (t: TestContext) => {
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

test("a failed Finish queue keeps the paused Note available for Retry", async (t: TestContext) => {
  const api = createElectronAPI({ stopResult: () => finalized() });
  const store = await loadStore(t, api);
  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal(await store.pauseMeeting(), true);
  const groupId = store.useMeetingRecordingStore.getState().meetingGroupId;
  api.api.meetingProcessingFinishForNote = async () => ({
    success: false,
    error: "queue unavailable",
  });
  assert.equal(await store.finishMeeting(), false);
  assert.equal(store.useMeetingRecordingStore.getState().capturePhase, "paused");
  assert.equal(store.useMeetingRecordingStore.getState().meetingGroupId, groupId);
  api.api.meetingProcessingFinishForNote = async () => ({ success: true });
  assert.equal(await store.finishMeeting(), true);
});

test("a failed main finalization is surfaced as incomplete", async (t: TestContext) => {
  const api = createElectronAPI({
    stopResult: () => ({ success: false, error: "audio tail could not be finalized" }),
  });

  const store = await loadStore(t, api);

  await store.startRecording(START_ARGS);
  const result = await store.stopRecording();

  assert.equal(result.stopped, false);
  assert.equal(store.useMeetingRecordingStore.getState().capturePhase, "incomplete");
  assert.equal(
    store.useMeetingRecordingStore.getState().captureErrorCode,
    "capture-finalize-failed"
  );
  assert.deepEqual(api.noteUpdates, []);
});

test("restarting the same note after capture failure keeps its group until End call", async (t: TestContext) => {
  let stops = 0;

  const api = createElectronAPI({
    stopResult: () => finalized(++stops === 1 ? "incomplete" : "ready"),
  });

  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  const groupId = api.startRequests[0].groupId;
  assert.equal((await store.stopRecording()).stopped, true);
  assert.equal(store.useMeetingRecordingStore.getState().capturePhase, "incomplete");

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal(api.startRequests[1].groupId, groupId);
  assert.equal((await store.stopRecording()).stopped, true);
  assert.equal(store.useMeetingRecordingStore.getState().capturePhase, "saved");

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal(api.startRequests[2].groupId, groupId);
  assert.equal(await store.finishMeeting(), true);

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.notEqual(api.startRequests[3].groupId, groupId);
});

test("a stale stop and a rejected stop do not claim success", async (t: TestContext) => {
  const staleApi = createElectronAPI({
    stopResult: () => ({ success: false, reason: "stale-session" }),
  });

  const staleStore = await loadStore(t, staleApi);
  await staleStore.startRecording(START_ARGS);
  assert.equal((await staleStore.stopRecording()).stopped, false);

  const failedApi = createElectronAPI({
    stopResult: () => {
      throw new Error("ipc channel closed");
    },
  });

  const failedStore = await loadStore(t, failedApi);
  await failedStore.startRecording(START_ARGS);
  assert.equal((await failedStore.stopRecording()).stopped, false);
});

test("empty stop preserves existing note text and transcript", async (t: TestContext) => {
  const api = createElectronAPI({ stopResult: () => finalized() });
  const store = await loadStore(t, api);

  assert.equal((await store.stopRecording()).stopped, false);
  assert.deepEqual(api.noteUpdates, []);
});

test("a scoped stop for another session leaves capture active", async (t: TestContext) => {
  const api = createElectronAPI({ stopResult: () => finalized() });
  const store = await loadStore(t, api);

  await store.startRecording(START_ARGS);
  assert.equal((await store.stopRecording("some-other-session")).stopped, false);
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, true);
  await store.stopRecording();
});
