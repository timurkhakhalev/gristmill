const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");
const configPath = path.join(root, "tsconfig.main.json");

// Compiles a probe source under the strict main settings and returns all
// program diagnostics. Negative probes expect specific codes; positive
// probes expect none.
function probeDiagnostics(source) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsed.options.strict, true);
  const probe = path.join(root, "meeting-coordinator-type-probe.ts");
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...args) =>
    file === probe
      ? ts.createSourceFile(file, source, languageVersion, true)
      : readSource(file, languageVersion, ...args);
  const program = ts.createProgram([probe], { ...parsed.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  return {
    codes: diagnostics.map((d) => d.code).sort((a, b) => a - b),
    messages: diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
    cleanup: () => {
      if (fs.existsSync(probe)) fs.rmSync(probe, { force: true });
    },
  };
}

const FULL_DEPS = `
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
  meetingAecManager: null,
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
`;

test("an incomplete meeting coordinator dependency set fails compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { registerMeetingCoordinatorHandlers, type IpcMainLike } from "./src/helpers/meetingCoordinatorIpcHandlers.js";

declare const ipcMain: IpcMainLike;

registerMeetingCoordinatorHandlers(ipcMain, {
  databaseManager: {},
  meetingDetectionEngine: null,
});
`);
  try {
    assert.ok(codes.length > 0, "missing dependencies must not compile");
    assert.ok(
      codes.some((code) => [2322, 2345, 2739, 2740, 2741].includes(code)),
      `expected a property/argument diagnostic, got ${codes.join(",")}`
    );
  } finally {
    cleanup();
  }
});

test("session/note/detection id confusion fails compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import type { MeetingCoordinatorApi } from "./src/contracts/meetingCoordinator.js";

declare const api: MeetingCoordinatorApi;

// sessionId is a string, noteId a number; a detection id is never a session id.
await api.meetingTranscriptionStart?.({ sessionId: 42, autoEndEligible: true });
await api.meetingTranscriptionStop?.(123);
await api.meetingAutoEndCompleted?.(42);
await api.setMeetingSessionSpeakerConfig?.({ enabled: true, expectedCount: "3" });
`);
  try {
    assert.ok(
      codes.some((code) => [2322, 2345].includes(code)),
      `expected argument diagnostics, got ${codes.join(",")}`
    );
  } finally {
    cleanup();
  }
});

test("wrong event callback payloads fail compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import type { MeetingCoordinatorApi } from "./src/contracts/meetingCoordinator.js";

declare const api: MeetingCoordinatorApi;

api.onMeetingTranscriptionSegment?.((data) => {
  const text: number = data.text;
});
api.onMeetingAutoEndRequested?.((request) => {
  const reason: "mic-released" | undefined = request.reason;
});
`);
  try {
    assert.ok(
      codes.some((code) => [2322, 2345].includes(code)),
      `expected assignment diagnostics, got ${codes.join(",")}`
    );
  } finally {
    cleanup();
  }
});

test("the full dependency set and the renderer bridge compile clean under strict", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { registerMeetingCoordinatorHandlers, type IpcMainLike } from "./src/helpers/meetingCoordinatorIpcHandlers.js";
import { createMeetingCoordinatorBridge } from "./src/preload/meetingCoordinatorBridge.js";

declare const ipcMain: IpcMainLike;
declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
};

${FULL_DEPS}

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
`);
  try {
    assert.deepEqual(codes, [], `positive graph must compile clean, got: ${codes.join(",")}`);
  } finally {
    cleanup();
  }
});
