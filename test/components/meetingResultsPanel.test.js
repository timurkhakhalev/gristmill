const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals, installHookDom } = require("../lib/rendererTestHarness");

const FIRST = "00000000-0000-4000-8000-000000000001";
const SECOND = "00000000-0000-4000-8000-000000000002";
const RUN = "00000000-0000-4000-8000-000000000003";
const CONFIG = {
  transcription: { mode: "providers", provider: "elevenlabs", model: "scribe_v2", language: "en", credentialRef: "ELEVENLABS_API_KEY" },
  summary: { instruction: "Built-in summary instruction", reasoningMode: "providers", provider: "openai", model: "gpt-4o-mini", credentialRef: "OPENAI_API_KEY" },
};

function recording(id, groupId, startedAt, run = null, captureState = "ready") {
  return {
    recording: {
      id, groupId, startedAt, endedAt: "2026-09-25T10:01:00.000Z", durationSeconds: 60,
      captureState, captureErrorCode: captureState === "incomplete" ? "system-audio-interrupted" : null,
      audioState: "available", audioErrorCode: null, currentRunId: run?.run.id ?? null,
    },
    runs: run ? [run] : [],
  };
}

function completeRun() {
  return {
    run: {
      id: RUN, recordingId: FIRST, sourceRecordingIds: [FIRST, SECOND], kind: "reprocess", sourceRunId: null,
      provider: "elevenlabs", model: "scribe_v2", config: CONFIG, configError: null,
      stage: "summary", status: "complete", errorCode: null, retryAt: null, retryCount: 0,
      hasRawProviderResponse: true, hasTranscript: true, hasSummary: true,
      createdAt: "2026-09-25T10:02:00.000Z", updatedAt: "2026-09-25T10:03:00.000Z",
    },
    transcript: { text: "Discussion", segments: [{ start: 1, end: 2, speaker: "speaker-1", text: "Discussion" }] },
    summary: { text: "## Decision\nRelease on Friday." },
    speakerCorrections: [],
  };
}

const heroMock = `
import React from "react";
const passthrough = ({children}) => React.createElement(React.Fragment, null, children);
export const Button = ({children,onPress,"aria-label":label}) => React.createElement("button", {onClick:onPress,"aria-label":label}, children);
export const Label = passthrough;
export const ListBox = Object.assign(passthrough,{Item:passthrough,ItemIndicator:passthrough});
export const Dropdown = Object.assign(passthrough,{Popover:passthrough,Menu:passthrough,Item:passthrough});
export const Popover = Object.assign(passthrough,{Content:passthrough,Dialog:passthrough,Heading:passthrough});
export const Select = Object.assign(passthrough,{Trigger:passthrough,Value:passthrough,Indicator:passthrough,Popover:passthrough});
export const Tabs = Object.assign(passthrough,{List:passthrough,Tab:passthrough,Indicator:passthrough});
export const Modal = Object.assign(({isOpen,children}) => isOpen ? React.createElement(React.Fragment,null,children) : null,{Backdrop:passthrough,Container:passthrough,Dialog:passthrough,CloseTrigger:passthrough,Header:passthrough,Heading:passthrough,Body:passthrough,Footer:passthrough});
`;

function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.map((item) => find(item, predicate)).find(Boolean) ?? null;
  if (!tree || typeof tree !== "object") return null;
  if (predicate(tree)) return tree;
  return find(tree.props?.children, predicate);
}

function textOf(value) {
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (typeof value === "string" || typeof value === "number") return String(value);
  return value?.props ? textOf(value.props.children) : "";
}

async function mountPanel(t, items, { viewMode = "raw", config = CONFIG, playback = { success: false, error: "mixer-failed" }, preview = false } = {}) {
  const calls = { create: [], export: [], delete: [], update: [], playback: [], speaker: [], retry: [] };
  const api = {
    meetingProcessingListForNote: async () => ({ success: true, recordings: items }),
    onMeetingProcessingUpdated: () => () => {},
    getSpeakerProfiles: async () => [],
    meetingRecordingGetPlaybackPath: async (...args) => { calls.playback.push(args); return playback; },
    meetingRecordingExportAudio: async (input) => { calls.export.push(input); return { success: true }; },
    meetingRecordingDeleteAudio: async (id) => { calls.delete.push(id); return { success: true }; },
    meetingProcessingCreateRun: async (input) => { calls.create.push(input); return { success: true, result: { run: { id: "00000000-0000-4000-8000-000000000004" } } }; },
    meetingProcessingUpdateBlockedRunConfig: async (input) => { calls.update.push(input); return { success: true }; },
    meetingProcessingSetSpeakerCorrection: async (input) => { calls.speaker.push(input); return { success: true }; },
    meetingProcessingSelectRun: async () => ({ success: true }),
    meetingProcessingRetryRun: async (id) => { calls.retry.push(id); return { success: true }; },
  };
  let root;
  t.after(async () => { if (root) await React.act(async () => root.unmount()); });
  installBrowserGlobals(t, { window: { electronAPI: api } });
  const container = installHookDom(t);
  const document = globalThis.document;
  const createElement = document.createElement.bind(document);
  document.createElement = (name) => {
    const element = createElement(name);
    if (name === "audio") element.pause = () => {};
    return element;
  };
  const previousDialog = globalThis.__meetingResultsConfirmDialog;
  t.after(() => previousDialog === undefined ? delete globalThis.__meetingResultsConfirmDialog : globalThis.__meetingResultsConfirmDialog = previousDialog);
  const vite = await createRendererServer(t, {
    cachePrefix: "meeting-results-panel-hero-",
    noExternal: ["@heroui/react"],
    mockModules: {
      "@heroui/react": heroMock,
      "react-i18next": `export function useTranslation() { return { t: (key, options) => options?.defaultValue ?? key }; }`,
      "/ui/dialog": `export const ConfirmDialog = (props) => { globalThis.__meetingResultsConfirmDialog = props; return null; };`,
      "/helpers/meetingRecordingConfigSnapshot": `export function snapshotMeetingRecordingConfig(transcriptionOverride) { const config = ${JSON.stringify(config)}; return { config: transcriptionOverride ? { ...config, transcription: transcriptionOverride } : config, configError: null }; } export function builtinMeetingSummaryInstruction() { return "Built-in summary instruction"; }`,
    },
  });
  const { default: MeetingResultsPanel } = await vite.ssrLoadModule("/components/notes/MeetingResultsPanel.tsx");
  let tree;
  function Harness() {
    const [mode, setMode] = React.useState(viewMode);
    tree = MeetingResultsPanel({ noteId: 1, locale: "en", previewRecordings: preview ? items : undefined, viewMode: mode, onViewModeChange: setMode,
      manualContent: React.createElement("p", null, "Manual notes"), fallbackTranscript: React.createElement("p", null, "No transcript"), fallbackSummary: React.createElement("p", null, "No summary") });
    return tree;
  }
  root = createRoot(container);
  await React.act(async () => { root.render(React.createElement(Harness)); await Promise.resolve(); });
  const flush = async (action) => React.act(async () => { action(); await new Promise((resolve) => setImmediate(resolve)); });
  return {
    calls, flush, dialog: () => globalThis.__meetingResultsConfirmDialog,
    text: () => container.textContent,
    button(label) { return find(tree, (node) => typeof node.props?.onPress === "function" && textOf(node.props.children).includes(label)); },
    iconButton(label) { return find(tree, (node) => node.props?.["aria-label"] === label && typeof node.props?.onPress === "function"); },
    menu(label) { return find(tree, (node) => node.props?.["aria-label"] === label && typeof node.props?.onAction === "function"); },
  };
}

test("manual notes stay primary while an incomplete saved audio part is visible", async (t) => {
  const items = [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", null, "incomplete")];
  const ui = await mountPanel(t, items);
  assert.match(ui.text(), /Manual notes/);
  assert.match(ui.text(), /Capture ended early/);
  assert.match(ui.text(), /Audio/);
  await ui.flush(() => ui.iconButton("Play audio").props.onPress());
  assert.deepEqual(ui.calls.playback, [[FIRST]]);
  assert.match(ui.text(), /mixer-failed/);
});

test("audio part actions export original tracks and confirm deletion without a transcript", async (t) => {
  const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z")]);
  const menu = ui.menu("Audio part actions");
  assert.ok(menu);
  await ui.flush(() => menu.props.onAction("mic"));
  assert.deepEqual(ui.calls.export, [{ recordingId: FIRST, source: "mic" }]);
  await ui.flush(() => menu.props.onAction("delete"));
  assert.equal(ui.dialog().open, true);
  await ui.flush(() => ui.dialog().onConfirm());
  assert.deepEqual(ui.calls.delete, [FIRST]);
});

test("whole-meeting reprocess uses both saved parts and leaves defaults untouched", async (t) => {
  const ui = await mountPanel(t, [
    recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z"),
    recording(SECOND, FIRST, "2026-09-25T10:05:00.000Z"),
  ]);
  await ui.flush(() => ui.button("Transcribe whole meeting").props.onPress());
  await ui.flush(() => ui.button("Create version").props.onPress());
  assert.equal(ui.calls.create.length, 1);
  assert.deepEqual(ui.calls.create[0].sourceRecordingIds, [FIRST, SECOND]);
  assert.equal(ui.calls.create[0].recordingId, FIRST);
  assert.equal(ui.calls.create[0].config.transcription.provider, CONFIG.transcription.provider);
  assert.equal(ui.calls.create[0].config.transcription.model, CONFIG.transcription.model);
  assert.equal(ui.calls.create[0].config.summary.instruction, CONFIG.summary.instruction);
});

test("summary version reads the saved transcript without another ASR run", async (t) => {
  const ui = await mountPanel(t, [
    recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", completeRun()),
    recording(SECOND, FIRST, "2026-09-25T10:05:00.000Z"),
  ], { viewMode: "enhanced" });
  assert.match(ui.text(), /Release on Friday/);
  await ui.flush(() => ui.menu("Result actions").props.onAction("summary"));
  await ui.flush(() => ui.button("Create version").props.onPress());
  assert.equal(ui.calls.create.length, 1);
  assert.equal(ui.calls.create[0].kind, "summary");
  assert.equal(ui.calls.create[0].sourceRunId, RUN);
  assert.equal(ui.calls.create[0].sourceRecordingIds, undefined);
  assert.equal(ui.calls.create[0].config.summary.instruction, CONFIG.summary.instruction);
});


test("debug preview keeps retry, export and processing away from the real API", async (t) => {
  const run = completeRun();
  run.run.status = "failed";
  const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", run)], { preview: true });
  await ui.flush(() => ui.button("Retry").props.onPress());
  assert.match(ui.text(), /Mock retry queued in memory/);
  await ui.flush(() => ui.menu("Audio part actions").props.onAction("mic"));
  await ui.flush(() => ui.button("Transcribe whole meeting").props.onPress());
  await ui.flush(() => ui.button("Create version").props.onPress());
  assert.deepEqual(ui.calls.retry, []);
  assert.deepEqual(ui.calls.export, []);
  assert.deepEqual(ui.calls.create, []);
});
