const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const { createRendererServer, installBrowserGlobals, installMicCaptureGlobals } =
  require("../../../lib/rendererTestHarness.ts") as typeof import("../../../lib/rendererTestHarness.js");

test("settings switch the live microphone without stopping or replacing the recording", async (t) => {
  let starts = 0;
  let stops = 0;
  const noopListener = () => () => {};

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        checkSystemAudioAccess: async () => ({
          granted: true,
          status: "granted",
          mode: "native",
          strategy: "native",
        }),
        onMeetManualMute: () => () => {},
        onMeetPlatformMute: () => () => {},
        getActions: async () => [],
        meetingTranscriptionStart: async () => {
          starts += 1;

          return {
            success: true,
            recordingId: "a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1",
            originAt: new Date().toISOString(),
            systemAudioMode: "native",
            systemAudioStrategy: "native",
          };
        },
        meetingTranscriptionStop: async () => {
          stops += 1;

          return { success: true, captureState: "ready" };
        },
        meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
        meetingTranscriptionSetMicIntent: async (request: {
          sequence: number;
          sourceGeneration: number;
          manualMuted: boolean;
          platformMuted: boolean;
          boundaryFrame: number;
        }) => ({
          success: true,
          sequence: request.sequence,
          sourceGeneration: request.sourceGeneration,
          effectiveMuted: request.manualMuted || request.platformMuted,
          boundaryFrame: request.boundaryFrame,
        }),
        onMeetingTranscriptionError: noopListener,
        onMeetingTranscriptionFatalError: noopListener,
        onMeetingSystemAudioSilent: noopListener,
        onMeetingSystemAudioInterrupted: noopListener,
        onMeetingSystemAudioResumed: noopListener,
      },
    },
  });
  installMicCaptureGlobals(t);

  const devices = ["mic-1", "mic-2"].map((id) => ({
    kind: "audioinput",
    deviceId: id,
    groupId: id,
    label: id,
  }));

  devices.push({
    kind: "audiooutput",
    deviceId: "default",
    groupId: "speakers",
    label: "MacBook Pro Speakers",
  });
  const deviceListeners = new Set<() => void>();
  navigator.mediaDevices.addEventListener = (_type: string, listener: (() => void) | object) => {
    if (typeof listener === "function") deviceListeners.add(listener as () => void);
  };

  navigator.mediaDevices.removeEventListener = (_type: string, listener: (() => void) | object) => {
    if (typeof listener === "function") deviceListeners.delete(listener as () => void);
  };

  const acquired: string[] = [];
  const retired: string[] = [];
  navigator.mediaDevices.enumerateDevices = async () => devices as MediaDeviceInfo[];
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const audio = constraints?.audio;

    const id =
      typeof audio === "object" && typeof audio.deviceId === "object" && "exact" in audio.deviceId
        ? String(audio.deviceId.exact)
        : "mic-1";

    acquired.push(id);

    const track = {
      readyState: "live",
      muted: false,
      label: id,
      getSettings: () => ({ deviceId: id, groupId: id }),
      stop: () => {
        retired.push(id);
      },
    };

    return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  };

  const vite = await createRendererServer(t);

  const settings = (await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  )) as typeof import("../../../../src/stores/settingsStore.js");

  settings.useSettingsStore.setState({
    microphoneSelectionMode: "specific",
    selectedMicDeviceId: "mic-1",
    selectedMicDeviceLabel: "mic-1",
  });

  const store = (await vite.ssrLoadModule(
    "/stores/meetingRecordingStore.ts"
  )) as typeof import("../../../../src/stores/meetingRecordingStore.js");

  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  try {
    assert.equal(
      await store.startRecording({
        noteId: 1,
        noteTitle: "Meeting",
        folderId: null,
        autoEndEligible: false,
      }),
      true
    );
    const { recordingId, meetingGroupId } = store.useMeetingRecordingStore.getState();
    await flush();
    assert.equal(store.useMeetingRecordingStore.getState().micCaptureDeviceLabel, "mic-1");
    assert.equal(
      store.useMeetingRecordingStore.getState().systemAudioOutputDeviceLabel,
      "MacBook Pro Speakers"
    );
    settings.getSettings().setSelectedMicDevice("mic-2", "mic-2");
    await flush();
    assert.equal(acquired.at(-1), "mic-2");
    assert.ok(retired.includes("mic-1"), "the old stream closes after the new graph is attached");
    assert.equal(store.useMeetingRecordingStore.getState().micCaptureStatus, "active");
    assert.equal(store.useMeetingRecordingStore.getState().micCaptureDeviceLabel, "mic-2");
    assert.equal(store.useMeetingRecordingStore.getState().recordingId, recordingId);
    assert.equal(store.useMeetingRecordingStore.getState().meetingGroupId, meetingGroupId);
    assert.equal(starts, 1);
    assert.equal(stops, 0);
    devices.at(-1)!.label = "AirPods Pro";
    deviceListeners.forEach((listener) => listener());
    await flush();
    assert.equal(
      store.useMeetingRecordingStore.getState().systemAudioOutputDeviceLabel,
      "AirPods Pro"
    );
    const count = acquired.length;
    settings.useSettingsStore.setState({ theme: "light" });
    await flush();
    assert.equal(acquired.length, count, "unrelated preferences cannot restart capture");
    await store.stopRecording();
    assert.equal(deviceListeners.size, 0, "stopped sessions remove device-change listeners");
    settings.getSettings().setSelectedMicDevice("mic-1", "mic-1");
    await flush();
    assert.equal(acquired.length, count, "stopped sessions unsubscribe from settings");
  } finally {
    await store.stopRecording();
  }
});
