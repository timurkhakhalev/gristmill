const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals, installHookDom } = require("../lib/rendererTestHarness");

const RECORDING_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "00000000-0000-4000-8000-000000000002";
const UPDATED_RUN_ID = "00000000-0000-4000-8000-000000000003";
const currentConfig = {
  transcription: {
    mode: "providers",
    provider: "elevenlabs",
    model: "scribe_v2",
    language: "en",
    credentialRef: "ELEVENLABS_API_KEY",
  },
  summary: null,
};

function resultDto({ status = "complete", captureState = "ready", transcript = { text: "Hello", segments: [] }, summary = null, hasRawProviderResponse = true } = {}) {
  return {
    recording: {
      id: RECORDING_ID,
      captureState,
      captureErrorCode: captureState === "incomplete" ? "system-audio-interrupted" : null,
      audioState: "available",
      audioErrorCode: null,
      currentRunId: RUN_ID,
      startedAt: "2026-09-24T10:00:00.000Z",
      endedAt: "2026-09-24T10:01:00.000Z",
    },
    runs: [{
      run: {
        id: RUN_ID,
        recordingId: RECORDING_ID,
        kind: "initial",
        sourceRunId: null,
        provider: "elevenlabs",
        model: "scribe_v2",
        config: null,
        configError: null,
        stage: "summary",
        status,
        errorCode: status === "blocked" ? "missing-summary-config" : null,
        retryAt: null,
        retryCount: 0,
        hasRawProviderResponse,
        hasTranscript: transcript !== null,
        hasSummary: summary !== null,
        createdAt: "2026-09-24T10:00:30.000Z",
        updatedAt: "2026-09-24T10:01:00.000Z",
      },
      transcript,
      summary,
      speakerCorrections: [],
    }],
  };
}

async function mountPanel(t, recordings, { playbackResponse = { success: false, error: "not requested" } } = {}) {
  const exportCalls = [];
  const createRunCalls = [];
  const updateConfigCalls = [];
  const api = {
    meetingProcessingListForNote: async () => ({ success: true, recordings }),
    onMeetingProcessingUpdated: () => () => {},
    getSpeakerProfiles: async () => [],
    meetingRecordingGetPlaybackPath: async () => playbackResponse,
    meetingProcessingCreateRun: async (input) => {
      createRunCalls.push(input);
      return { success: true, result: { run: { id: UPDATED_RUN_ID } } };
    },
    meetingProcessingUpdateBlockedRunConfig: async (input) => {
      updateConfigCalls.push(input);
      return { success: true };
    },
    meetingRecordingExportAudio: async (input) => {
      exportCalls.push(input);
      return { success: true };
    },
  };
  installBrowserGlobals(t, { window: { electronAPI: api } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "meeting-results-panel-review-",
    mockModules: {
      "react-i18next": "export function useTranslation() { return { t: (key) => key }; }",
      "/ui/dialog": "export const ConfirmDialog = () => null;",
      "/helpers/meetingRecordingConfigSnapshot": `export function snapshotMeetingRecordingConfig() { return ${JSON.stringify({ config: currentConfig, configError: null })}; }`,
    },
  });
  const { default: MeetingResultsPanel } = await vite.ssrLoadModule("/components/notes/MeetingResultsPanel.tsx");
  let tree;
  function Harness() {
    tree = MeetingResultsPanel({ noteId: 1, locale: "en" });
    return tree;
  }
  const root = createRoot(container);
  t.after(async () => React.act(async () => root.unmount()));
  await React.act(async () => {
    root.render(React.createElement(Harness));
    await Promise.resolve();
  });
  return {
    exportCalls,
    createRunCalls,
    updateConfigCalls,
    markup: () => renderToStaticMarkup(tree),
    findButton(label) {
      function find(node) {
        if (Array.isArray(node)) return node.map(find).find(Boolean) ?? null;
        if (!node || typeof node !== "object") return null;
        if (node.props?.onClick && node.props?.children === label) return node;
        return find(node.props?.children);
      }
      return find(tree);
    },
  };
}

test("incomplete capture remains visible after the processing run completes", async (t) => {
  const ui = await mountPanel(t, [resultDto({ captureState: "incomplete" })]);
  const markup = ui.markup();
  assert.match(markup, /meetingResults\.captureIncomplete/);
  assert.match(markup, /meetingResults\.status\.complete/);
  assert.match(markup, /system-audio-interrupted/);
});

test("source WAV export is available for saved audio without a transcript or playback path", async (t) => {
  const ui = await mountPanel(t, [resultDto({ status: "blocked", transcript: null })]);
  const micExport = ui.findButton("meetingResults.exportMic");
  const systemExport = ui.findButton("meetingResults.exportSystem");
  assert.ok(micExport);
  assert.ok(systemExport);
  await React.act(async () => micExport.props.onClick());
  assert.deepEqual(ui.exportCalls, [{ recordingId: RECORDING_ID, source: "mic" }]);
});

test("New transcription uses the current recording when no transcript is selectable", async (t) => {
  const ui = await mountPanel(t, [resultDto({ status: "blocked", transcript: null })]);
  const newAsr = ui.findButton("meetingResults.newAsr");
  assert.ok(newAsr);
  await React.act(async () => newAsr.props.onClick());
  assert.deepEqual(ui.createRunCalls, [{
    recordingId: RECORDING_ID,
    kind: "reprocess",
    config: currentConfig,
    configError: null,
  }]);
});

test("blocked initial run exposes an action that sends the current validated settings snapshot", async (t) => {
  const ui = await mountPanel(t, [resultDto({
    status: "blocked",
    transcript: null,
    hasRawProviderResponse: false,
  })]);
  const updateSettings = ui.findButton("meetingResults.updateRunSettings");
  assert.ok(updateSettings);
  await React.act(async () => updateSettings.props.onClick());
  assert.deepEqual(ui.updateConfigCalls, [{
    runId: RUN_ID,
    config: currentConfig,
    configError: null,
  }]);
});

test("a valid empty transcript has a distinct no-speech message", async (t) => {
  const ui = await mountPanel(t, [resultDto({ transcript: { text: "", segments: [] } })]);
  assert.match(ui.markup(), /notes\.upload\.noSpeechDetected/);
});

test("a fulfilled playback failure is visible in Notes", async (t) => {
  const ui = await mountPanel(t, [resultDto()], {
    playbackResponse: { success: false, error: "mixer-failed" },
  });
  assert.match(ui.markup(), /meetingResults\.playbackError/);
});
