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

declare const productionDatabase: import("./src/helpers/database.js").DatabaseManager;
const checkedDatabase: import("./src/helpers/meetingCoordinatorIpcHandlers.js").MeetingCoordinatorDeps["databaseManager"] = productionDatabase;
void checkedDatabase;

const deps: import("./src/helpers/meetingCoordinatorIpcHandlers.js").MeetingCoordinatorDeps = {
  databaseManager: {
      saveMeetingPlatformObservation() {},
      saveMeetingAudioClockAnchor() {},
      setMeetingPlatformCoverage() {},
    createMeetingRecording: () => ({} as import("./src/contracts/meetingRecording.js").MeetingRecordingDto),
    createMeetingRecordingEpoch: () => undefined,
    updateMeetingRecordingEpochRecovery: () => undefined,
    addMeetingRecordingEpochAlignment: () => undefined,
    markMeetingRecordingEpochAlignmentUnknown: () => undefined,
    openMeetingIntentionalInterval: () => ({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", recordingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", source: "mic", sourceGeneration: 1,
      sourceStartFrame: 0, sourceEndFrame: null, timelineStartFrame: null, timelineEndFrame: null,
      startAlignment: null, endAlignment: null, reason: "manual-muted" }),
    closeMeetingIntentionalInterval: () => null,
    listMeetingIntentionalIntervals: () => [],
    markMeetingRecordingFinalizing: () => undefined,
    finalizeMeetingRecording: () => ({
      recording: {} as import("./src/contracts/meetingRecording.js").MeetingRecordingDto,
      initialRun: { id: "run-1" },
    }),
    getNote: () => null,
    getGoogleAccounts: () => [],
  },
  meetingRecordingStorage: {
    openEpochWriter: () => undefined,
    appendEpochSamples: () => undefined,
    closeEpochWriter: () => undefined,
    recoverEpoch: () => ({ frameCount: 0, ignoredTrailingBytes: 0, errorCode: null }),
  },
  meetingDetectionEngine: null,
  audioTapManager: null,
  liveSpeakerIdentifier: {
    setEnabled: () => undefined,
    setMaxSpeakers: () => undefined,
  },
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
    epochSourceStartFrame: 0,
    sourceFrameStart: 0,
    sourceGeneration: 1,
    alignment: null,
    alignmentErrorCode: "clock-unavailable",
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
