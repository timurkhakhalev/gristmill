const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

const START_ARGS = {
  noteId: null,
  noteTitle: null,
  folderId: null,
  autoEndEligible: false,
};

test("an unsupported system source stays unavailable instead of falling back to display capture", async (t) => {
  installMicCaptureGlobals(t);
  let displayCaptureCalls = 0;
  navigator.mediaDevices.getDisplayMedia = async () => {
    displayCaptureCalls += 1;
    throw new Error("display capture must not be requested for an unsupported source");
  };

  const stopRequests = [];
  const noopListener = () => () => {};
  const api = {
    checkSystemAudioAccess: async () => ({
      granted: false,
      status: "unsupported",
      mode: "unsupported",
      strategy: "unsupported",
    }),
    meetingTranscriptionStart: async () => ({
      success: true,
      recordingId: "00000000-0000-4000-8000-000000000001",
      originAt: new Date().toISOString(),
      systemAudioMode: "unsupported",
      systemAudioStrategy: "unsupported",
    }),
    meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
    meetingTranscriptionStop: async (request) => {
      stopRequests.push(request);
      return { success: true, captureState: "incomplete" };
    },
    meetingTranscriptionSend: async (_buffer, _source, _sessionId, packet) => ({
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
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (timer) => clearTimeout(timer),
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openhercules-meeting-system-audio-no-fallback-",
  });
  const store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");

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
