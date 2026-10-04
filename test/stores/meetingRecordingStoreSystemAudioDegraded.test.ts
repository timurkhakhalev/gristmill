const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
}: typeof import("../lib/rendererTestHarness.ts") = require("../lib/rendererTestHarness.ts");

type TestContext = import("node:test").TestContext;

const START_ARGS = {
  noteId: null,
  noteTitle: null,
  folderId: null,
  autoEndEligible: false,
};

test("an unsupported system source stays unavailable instead of falling back to display capture", async (t: TestContext) => {
  installMicCaptureGlobals(t);
  let displayCaptureCalls = 0;
  navigator.mediaDevices.getDisplayMedia = async () => {
    displayCaptureCalls += 1;
    throw new Error("display capture must not be requested for an unsupported source");
  };

  const stopRequests: Array<{ incomplete?: boolean; errorCode?: string | null }> = [];
  const noopListener = () => () => {};
  const api = {
    checkSystemAudioAccess: async () => ({
      granted: false,
      status: "unsupported",
      mode: "unsupported",
      strategy: "unsupported",
    }),
    onMeetManualMute: () => () => {},
    onMeetPlatformMute: () => () => {},
    meetingTranscriptionStart: async () => ({
      success: true,
      recordingId: "00000000-0000-4000-8000-000000000001",
      originAt: new Date().toISOString(),
      systemAudioMode: "unsupported",
      systemAudioStrategy: "unsupported",
    }),
    meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
    meetingTranscriptionStop: async (request: { incomplete?: boolean; errorCode?: string | null }) => {
      stopRequests.push(request);
      return { success: true, captureState: "incomplete" };
    },
    meetingTranscriptionSend: async (_buffer: unknown, _source: unknown, _sessionId: unknown, packet: { sequence: number }) => ({
      success: true,
      sequence: packet.sequence,
    }),
    onMeetingTranscriptionError: noopListener,
    onMeetingTranscriptionFatalError: noopListener,
    onMeetingSystemAudioSilent: noopListener,
    onMeetingSystemAudioInterrupted: noopListener,
    onMeetingSystemAudioResumed: noopListener,
  };
  installBrowserGlobals(t, {
    window: {
      electronAPI: api,
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "gristmill-meeting-system-audio-no-fallback-",
  });
  const store = (await vite.ssrLoadModule("/stores/meetingRecordingStore.ts") as typeof import("../../src/stores/meetingRecordingStore.ts"));

  assert.equal(await store.startRecording(START_ARGS), true);
  const state = store.useMeetingRecordingStore.getState();
  assert.equal(state.micCaptureStatus, "active");
  assert.equal(state.systemCaptureStatus, "unavailable");
  assert.equal(state.captureErrorCode, "system-source-unavailable");
  assert.equal(displayCaptureCalls, 0);

  await store.stopRecording();
  assert.equal(stopRequests.length, 1);
  assert.equal(stopRequests[0].incomplete, true);
  assert.equal(stopRequests[0].errorCode, "system-source-unavailable");
});
