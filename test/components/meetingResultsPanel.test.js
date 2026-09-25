const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
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

function resultDto({
  recordingId = RECORDING_ID,
  runId = RUN_ID,
  status = "complete",
  stage = "summary",
  errorCode = status === "blocked" ? "missing-summary-config" : null,
  captureState = "ready",
  audioState = "available",
  startedAt = "2026-09-24T10:00:00.000Z",
  transcript = { text: "Hello", segments: [] },
  summary = null,
  config = null,
  hasRawProviderResponse = true,
} = {}) {
  return {
    recording: {
      id: recordingId,
      captureState,
      captureErrorCode: captureState === "incomplete" ? "system-audio-interrupted" : null,
      audioState,
      audioErrorCode: null,
      currentRunId: runId,
      startedAt,
      endedAt: "2026-09-24T10:01:00.000Z",
    },
    runs: [{
      run: {
        id: runId,
        recordingId,
        kind: "initial",
        sourceRunId: null,
        provider: "elevenlabs",
        model: "scribe_v2",
        config,
        configError: null,
        stage,
        status,
        errorCode,
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

async function mountPanel(t, recordings, {
  playbackResponse = { success: false, error: "not requested" },
  snapshotConfig = currentConfig,
  onDeleteAudio = async () => ({ success: true }),
  onRetryDelete = async () => ({ success: true }),
} = {}) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const exportCalls = [];
  const createRunCalls = [];
  const updateConfigCalls = [];
  const deleteCalls = [];
  const retryDeleteCalls = [];
  const selectRunCalls = [];
  const playbackCalls = [];
  const listRecordings = typeof recordings === "function" ? recordings : () => recordings;
  let notifyUpdated = () => {};
  const previousDialog = globalThis.__meetingResultsConfirmDialog;
  t.after(() => {
    if (previousDialog === undefined) delete globalThis.__meetingResultsConfirmDialog;
    else globalThis.__meetingResultsConfirmDialog = previousDialog;
  });
  const api = {
    meetingProcessingListForNote: async () => ({ success: true, recordings: listRecordings() }),
    onMeetingProcessingUpdated: (callback) => {
      notifyUpdated = callback;
      return () => { notifyUpdated = () => {}; };
    },
    getSpeakerProfiles: async () => [],
    meetingRecordingGetPlaybackPath: async (...args) => {
      playbackCalls.push(args);
      return playbackResponse;
    },
    meetingProcessingSelectRun: async (recordingId, runId) => {
      selectRunCalls.push({ recordingId, runId });
      const selectedRecording = listRecordings().find((item) => item.recording.id === recordingId);
      if (selectedRecording) selectedRecording.recording.currentRunId = runId;
      return { success: true };
    },
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
    meetingRecordingDeleteAudio: async (recordingId) => {
      deleteCalls.push(recordingId);
      return onDeleteAudio(recordingId);
    },
    meetingRecordingRetryAudioDeletion: async (recordingId) => {
      retryDeleteCalls.push(recordingId);
      return onRetryDelete(recordingId);
    },
  };
  installBrowserGlobals(t, { window: { electronAPI: api } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "meeting-results-panel-review-",
    mockModules: {
      "react-i18next": "export function useTranslation() { return { t: (key) => key }; }",
      "/ui/dialog": "export const ConfirmDialog = (props) => { globalThis.__meetingResultsConfirmDialog = props; return null; };",
      "/helpers/meetingRecordingConfigSnapshot": `export function snapshotMeetingRecordingConfig(transcriptionOverride) { const snapshot = ${JSON.stringify({ config: snapshotConfig, configError: null })}; return transcriptionOverride && snapshot.config ? { ...snapshot, config: { ...snapshot.config, transcription: transcriptionOverride } } : snapshot; }`,
    },
  });
  const { default: MeetingResultsPanel } = await vite.ssrLoadModule("/components/notes/MeetingResultsPanel.tsx");
  let tree;
  function Harness() {
    tree = MeetingResultsPanel({ noteId: 1, locale: "en" });
    return tree;
  }
  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
    await Promise.resolve();
  });
  return {
    exportCalls,
    createRunCalls,
    updateConfigCalls,
    deleteCalls,
    retryDeleteCalls,
    selectRunCalls,
    playbackCalls,
    notifyUpdated: () => notifyUpdated(),
    textContent: () => container.textContent,
    findButton(label) {
      function find(node) {
        if (Array.isArray(node)) return node.map(find).find(Boolean) ?? null;
        if (!node || typeof node !== "object") return null;
        if (node.props?.onClick && node.props?.children === label) return node;
        return find(node.props?.children);
      }
      return find(tree);
    },
    findSelect(label) {
      function find(node) {
        if (Array.isArray(node)) return node.map(find).find(Boolean) ?? null;
        if (!node || typeof node !== "object") return null;
        if (node.type === "select" && node.props?.["aria-label"] === label) return node;
        return find(node.props?.children);
      }
      return find(tree);
    },
    findSelectByValue(value) {
      function find(node) {
        if (Array.isArray(node)) return node.map(find).find(Boolean) ?? null;
        if (!node || typeof node !== "object") return null;
        if (node.type === "select" && node.props?.value === value) return node;
        return find(node.props?.children);
      }
      return find(tree);
    },
    dialog: () => globalThis.__meetingResultsConfirmDialog,
  };
}

test("incomplete capture remains visible after the processing run completes", async (t) => {
  const ui = await mountPanel(t, [resultDto({ captureState: "incomplete" })]);
  const text = ui.textContent();
  assert.match(text, /meetingResults\.captureIncomplete/);
  assert.match(text, /meetingResults\.status\.complete/);
  assert.match(text, /system-audio-interrupted/);
});

test("source WAV export is available for saved audio without a transcript or playback path", async (t) => {
  const ui = await mountPanel(t, [resultDto({ status: "blocked", transcript: null })]);
  assert.match(ui.textContent(), /meetingResults\.exportMic/);
  assert.match(ui.textContent(), /meetingResults\.exportSystem/);
  const micExport = ui.findButton("meetingResults.exportMic");
  const systemExport = ui.findButton("meetingResults.exportSystem");
  assert.ok(micExport);
  assert.ok(systemExport);
  await React.act(async () => micExport.props.onClick());
  assert.deepEqual(ui.exportCalls, [{ recordingId: RECORDING_ID, source: "mic" }]);
});

test("New transcription uses the current recording when no transcript is selectable", async (t) => {
  const ui = await mountPanel(t, [resultDto({ status: "blocked", transcript: null })]);
  assert.match(ui.textContent(), /meetingResults\.newAsr/);
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
  assert.match(ui.textContent(), /meetingResults\.updateRunSettings/);
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
  assert.match(ui.textContent(), /notes\.upload\.noSpeechDetected/);
});

test("a fulfilled playback failure is visible in Notes", async (t) => {
  const ui = await mountPanel(t, [resultDto()], {
    playbackResponse: { success: false, error: "mixer-failed" },
  });
  assert.match(ui.textContent(), /meetingResults\.playbackError/);
});

test("audio-only deletion works without a transcript, can be cancelled, and can retry after failure", async (t) => {
  let recording = resultDto({
    status: "blocked",
    stage: "asr",
    errorCode: "missing-config",
    transcript: null,
    hasRawProviderResponse: false,
  });
  const ui = await mountPanel(t, () => [recording], {
    onDeleteAudio: async () => {
      recording = resultDto({ ...recordingOptions(recording), audioState: "deleting" });
      return { success: false, error: "disk-busy" };
    },
    onRetryDelete: async () => {
      recording = resultDto({ ...recordingOptions(recording), audioState: "deleted" });
      return { success: true };
    },
  });
  assert.match(ui.textContent(), /meetingResults\.deleteAudio/);

  await React.act(async () => ui.findButton("meetingResults.deleteAudio").props.onClick());
  const cancelledDialog = ui.dialog();
  assert.equal(cancelledDialog.open, true);
  await React.act(async () => cancelledDialog.onOpenChange(false));
  assert.deepEqual(ui.deleteCalls, [], "cancelling confirmation leaves the recording untouched");

  await React.act(async () => ui.findButton("meetingResults.deleteAudio").props.onClick());
  const deleteDialog = ui.dialog();
  await React.act(async () => {
    await deleteDialog.onConfirm();
    deleteDialog.onOpenChange(false);
  });
  assert.deepEqual(ui.deleteCalls, [RECORDING_ID]);
  assert.match(ui.textContent(), /disk-busy/);
  assert.ok(ui.findButton("meetingResults.retryDelete"));

  await React.act(async () => ui.findButton("meetingResults.retryDelete").props.onClick());
  const retryDialog = ui.dialog();
  await React.act(async () => {
    await retryDialog.onConfirm();
    retryDialog.onOpenChange(false);
  });
  assert.deepEqual(ui.retryDeleteCalls, [RECORDING_ID]);
  assert.equal(ui.textContent().includes("meetingResults.retryDelete"), false);
});

function recordingOptions(recording) {
  const run = recording.runs[0];
  return {
    recordingId: recording.recording.id,
    runId: run.run.id,
    status: run.run.status,
    stage: run.run.stage,
    errorCode: run.run.errorCode,
    captureState: recording.recording.captureState,
    audioState: recording.recording.audioState,
    startedAt: recording.recording.startedAt,
    transcript: run.transcript,
    summary: run.summary,
    config: run.run.config,
    hasRawProviderResponse: run.run.hasRawProviderResponse,
  };
}

test("selecting one of multiple recordings scopes status, results, and actions to that recording", async (t) => {
  const olderRecordingId = "00000000-0000-4000-8000-000000000011";
  const olderRunId = "00000000-0000-4000-8000-000000000012";
  const olderPendingRunId = "00000000-0000-4000-8000-000000000013";
  const newerRecordingId = "00000000-0000-4000-8000-000000000021";
  const newerRunId = "00000000-0000-4000-8000-000000000022";
  const older = resultDto({
    recordingId: olderRecordingId,
    runId: olderRunId,
    startedAt: "2026-09-23T10:00:00.000Z",
    transcript: { text: "Older saved result", segments: [] },
  });
  older.runs[0].run.createdAt = "2026-09-23T10:00:30.000Z";
  older.runs[0].run.updatedAt = "2026-09-23T10:01:00.000Z";
  const newer = resultDto({
    recordingId: newerRecordingId,
    runId: newerRunId,
    startedAt: "2026-09-24T10:00:00.000Z",
    captureState: "incomplete",
    status: "blocked",
    stage: "asr",
    errorCode: "missing-config",
    transcript: null,
    hasRawProviderResponse: false,
  });
  const pendingRun = {
    ...older.runs[0],
    run: {
      ...older.runs[0].run,
      id: olderPendingRunId,
      kind: "reprocess",
      stage: "asr",
      status: "pending",
      errorCode: null,
      hasRawProviderResponse: false,
      hasTranscript: false,
      hasSummary: false,
      createdAt: "2026-09-23T10:02:00.000Z",
      updatedAt: "2026-09-23T10:02:00.000Z",
    },
    transcript: null,
    summary: null,
  };
  let currentRecordings = [newer, {
    ...older,
    recording: { ...older.recording, currentRunId: olderPendingRunId },
    runs: [older.runs[0], pendingRun],
  }];
  const ui = await mountPanel(t, () => currentRecordings, {
    playbackResponse: { success: true, path: "/managed/older-run.wav" },
  });
  assert.match(ui.textContent(), /meetingResults\.captureIncomplete/);
  assert.equal(ui.textContent().includes("Older saved result"), false);

  await React.act(async () => ui.findButton("meetingResults.exportMic").props.onClick());
  assert.deepEqual(ui.exportCalls, [{ recordingId: newerRecordingId, source: "mic" }]);
  await React.act(async () => ui.findButton("meetingResults.newAsr").props.onClick());
  assert.equal(ui.createRunCalls[0].recordingId, newerRecordingId);
  await React.act(async () => ui.findButton("meetingResults.updateRunSettings").props.onClick());
  assert.deepEqual(ui.updateConfigCalls.map(({ runId }) => runId), [newerRunId]);
  await React.act(async () => ui.findButton("meetingResults.deleteAudio").props.onClick());
  const deleteDialog = ui.dialog();
  await React.act(async () => {
    await deleteDialog.onConfirm();
    deleteDialog.onOpenChange(false);
  });
  assert.deepEqual(ui.deleteCalls, [newerRecordingId]);

  let recordingSelect = ui.findSelect("meetingResults.recording");
  assert.ok(recordingSelect);
  await React.act(async () => {
    recordingSelect.props.onChange({ target: { value: olderRecordingId } });
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.match(ui.textContent(), /Older saved result/);
  assert.match(ui.textContent(), /meetingResults\.status\.pending/);
  assert.deepEqual(ui.selectRunCalls, [], "switching recordings does not persist an old transcript selection");
  assert.deepEqual(ui.playbackCalls.at(-1), [olderRecordingId, olderRunId]);
  const mixedExport = ui.findButton("meetingResults.exportMixed");
  assert.ok(mixedExport, "the displayed older result keeps mixed export available");
  await React.act(async () => mixedExport.props.onClick());
  assert.deepEqual(ui.exportCalls.at(-1), {
    recordingId: olderRecordingId,
    runId: olderRunId,
    source: "mixed",
  });

  const completedPendingRun = {
    ...pendingRun,
    run: {
      ...pendingRun.run,
      stage: "summary",
      status: "complete",
      hasRawProviderResponse: true,
      hasTranscript: true,
      hasSummary: true,
      updatedAt: "2026-09-23T10:03:00.000Z",
    },
    transcript: { text: "Newest pending result", segments: [] },
    summary: { text: "Newest pending summary" },
  };
  currentRecordings = [newer, {
    ...older,
    recording: { ...older.recording, currentRunId: olderPendingRunId },
    runs: [older.runs[0], completedPendingRun],
  }];
  await React.act(async () => {
    ui.notifyUpdated();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.match(ui.textContent(), /Newest pending result/);
  assert.deepEqual(ui.selectRunCalls, [], "refresh follows the persisted current run without selecting another version");

  const versionSelect = ui.findSelectByValue(olderPendingRunId);
  assert.ok(versionSelect);
  await React.act(async () => {
    versionSelect.props.onChange({ target: { value: olderRunId } });
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.match(ui.textContent(), /Older saved result/);
  assert.deepEqual(ui.selectRunCalls, [{ recordingId: olderRecordingId, runId: olderRunId }]);

  recordingSelect = ui.findSelect("meetingResults.recording");
  await React.act(async () => {
    recordingSelect.props.onChange({ target: { value: newerRecordingId } });
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.match(ui.textContent(), /meetingResults\.captureIncomplete/);
  assert.equal(ui.textContent().includes("Older saved result"), false);
  assert.deepEqual(ui.selectRunCalls, [{ recordingId: olderRecordingId, runId: olderRunId }], "switching away leaves the explicit version selection unchanged");
});

test("summary-only settings correction keeps the selected run's saved transcription route", async (t) => {
  const savedConfig = {
    transcription: { ...currentConfig.transcription, provider: "deepgram", model: "nova-3", credentialRef: "DEEPGRAM_API_KEY" },
    summary: null,
  };
  const currentSettings = {
    ...currentConfig,
    transcription: { ...currentConfig.transcription, language: "fr" },
    summary: {
      actionId: "notes.actions.builtin.detailedNotes",
      instruction: "Summarize the meeting accurately.",
      reasoningMode: "providers",
      provider: "openai",
      model: "gpt-4o-mini",
      credentialRef: "OPENAI_API_KEY",
    },
  };
  const ui = await mountPanel(t, [resultDto({
    status: "blocked",
    errorCode: "missing-summary-config",
    config: savedConfig,
    hasRawProviderResponse: true,
  })], { snapshotConfig: currentSettings });
  const updateSettings = ui.findButton("meetingResults.updateRunSettings");
  assert.ok(updateSettings);
  await React.act(async () => updateSettings.props.onClick());
  assert.deepEqual(ui.updateConfigCalls, [{
    runId: RUN_ID,
    config: { transcription: savedConfig.transcription, summary: currentSettings.summary },
    configError: null,
  }]);
});
