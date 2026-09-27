// @probe-name "the full dependency set and the renderer bridge compile clean under strict"
// @probe-codes []
// @probe-origin test/scripts/meetingCoordinatorTypeProbe.test.js
import { registerMeetingCoordinatorHandlers, type IpcMainLike } from "./src/helpers/meetingCoordinatorIpcHandlers.js";
import { createMeetingCoordinatorBridge } from "./src/preload/meetingCoordinatorBridge.js";

declare const ipcMain: IpcMainLike;
declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
};


async function fetchRealtimeToken(
  event: { sender: import("electron").WebContents },
  options: import("./src/helpers/meetingStreamingProviders.js").MeetingConnectionOptions
): Promise<string>;
async function fetchRealtimeToken(
  event: { sender: import("electron").WebContents },
  options: import("./src/helpers/meetingStreamingProviders.js").MeetingConnectionOptions,
  extra: { streams: 2 }
): Promise<[string, string]>;
async function fetchRealtimeToken(
  event: { sender: import("electron").WebContents },
  options: import("./src/helpers/meetingStreamingProviders.js").MeetingConnectionOptions,
  extra?: { streams: 2 }
): Promise<string | [string, string]> {
  return extra?.streams === 2 ? ["a", "b"] : "a";
}

const deps: import("./src/helpers/meetingCoordinatorIpcHandlers.js").MeetingCoordinatorDeps = {
  databaseManager: {
    createMeetingRecording: () => ({} as import("./src/contracts/meetingRecording.js").MeetingRecordingDto),
    createMeetingRecordingEpoch: () => undefined,
    updateMeetingRecordingEpochRecovery: () => undefined,
    markMeetingRecordingFinalizing: () => undefined,
    finalizeMeetingRecording: () => ({
      recording: {} as import("./src/contracts/meetingRecording.js").MeetingRecordingDto,
      initialRun: { id: "run-1" },
    }),
    getSpeakerProfiles: () => [],
    getSpeakerMappings: () => [],
    setSpeakerMapping: () => undefined,
    removeSpeakerMapping: () => undefined,
    getNote: () => null,
    getGoogleAccounts: () => [],
    upsertSpeakerProfile: () => ({ id: 1 }),
  },
  meetingRecordingStorage: {
    openEpochWriter: () => undefined,
    appendEpochSamples: () => undefined,
    closeEpochWriter: () => undefined,
    recoverEpoch: () => ({ frameCount: 0, ignoredTrailingBytes: 0, errorCode: null }),
  },
  diarizationManager: {
    isAvailable: () => false,
    convertRawPcmToWav: async () => "/tmp/x.wav",
    diarize: async () => [],
    capSpeakerClusters: (segments) => segments,
    mergeWithTranscript: (segments) => segments,
  },
  meetingDetectionEngine: null,
  audioTapManager: null,
  whisperManager: { transcribeLocalWhisper: async () => ({ success: true, text: "" }) },
  parakeetManager: { transcribeLocalParakeet: async () => ({ success: true, text: "" }) },
  liveSpeakerIdentifier: {
    isAvailable: () => false,
    start: async () => false,
    stop: async () => ({}),
    feedAudio: async () => undefined,
    recluster: async () => [],
    setEnabled: () => undefined,
    setMaxSpeakers: () => undefined,
    getSpeakerEmbedding: () => null,
    mapSpeaker: () => undefined,
  },
  fetchRealtimeToken,
  resolveWhisperVadOptions: () => ({}),
  speakerEmbeddings: () => ({
    isAvailable: () => false,
    extractEmbedding: async () => null,
    computeCentroid: (embeddings) => embeddings[0] ?? new Float32Array(),
    cosineSimilarity: () => 0,
  }),
};


const runtime = registerMeetingCoordinatorHandlers(ipcMain, deps);
runtime.linkRecordingSessionToNote(42);
runtime.refreshMeetingSpeakerConfigFromNote(42, { participants: "[]" });
runtime.resolveOneOnOneOtherParticipant("[]");

const api = createMeetingCoordinatorBridge(ipcRendererLike);
async function usage(): Promise<void> {
  const prepared = await api.meetingTranscriptionPrepare?.();
  if (prepared?.success) {
    const started = await api.meetingTranscriptionStart?.({
      sessionId: "meeting-1",
      noteId: null,
      autoEndEligible: true,
    });
    if (started?.success && started.systemAudioStrategy && started.systemAudioStrategy !== "unsupported") {
      const strategy: "native" | "loopback" | "pipewire-loopback" | "wasapi-loopback" | "unsupported" =
        started.systemAudioStrategy;
      void strategy;
    }
    await api.meetingTranscriptionStop?.({ sessionId: "meeting-1", lastSequence: {} });
  }
  api.meetingTranscriptionSend?.(new ArrayBuffer(4), "mic", "meeting-1", {
    epochIndex: 0,
    epochStartFrame: 0,
    sequence: 0,
    sampleOffset: 0,
  });
  const unsubscribe = api.onMeetingTranscriptionSegment?.((data) => {
    const source: "mic" | "system" = data.source;
    void source;
  });
  unsubscribe?.();
  const navigation = await api.getPendingMeetingNoteNavigation?.();
  if (navigation) {
    const noteId: number = navigation.noteId;
    void noteId;
  }
}
void usage;
