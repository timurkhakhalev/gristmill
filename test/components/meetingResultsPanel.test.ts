const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test") = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals, installHookDom } = require("../lib/rendererTestHarness.ts") as typeof import("../lib/rendererTestHarness.js");

type TestContext = import("node:test").TestContext;
interface ReactNodeLike { props?: Record<string, unknown> & { children?: unknown }; }

interface MountedCalls {
  create: Array<Record<string, unknown>>;
  export: Array<Record<string, unknown>>;
  delete: string[];
  playback: unknown[][];
  speaker: Array<Record<string, unknown>>;
  update: Array<Record<string, unknown>>;
  retry: string[];
}

function submittedSection(call: Record<string, unknown>, section: "transcription" | "summary"): Record<string, unknown> {
  const config = call.config;
  assert.ok(config && typeof config === "object" && section in config);
  const value = (config as Record<string, unknown>)[section];
  assert.ok(value && typeof value === "object");
  return value as Record<string, unknown>;
}

type GlobalWithMocks = typeof globalThis & {
  __meetingResultsConfirmDialog?: { open: boolean; onConfirm(): void };
  __meetingResultsButtonHandlers?: Array<{ label: string; onPress?: () => void }>;
};

let vitePromise: Promise<import("vite").ViteDevServer> | undefined;
const cleanup: Array<() => Promise<void>> = [];
test.after(async () => {
  for (const close of cleanup) await close();
});

const FIRST = "00000000-0000-4000-8000-000000000001";
const SECOND = "00000000-0000-4000-8000-000000000002";
const THIRD = "00000000-0000-4000-8000-000000000004";
const FOURTH = "00000000-0000-4000-8000-000000000005";
const RUN = "00000000-0000-4000-8000-000000000003";
const CONFIG = {
  transcription: { mode: "providers", provider: "elevenlabs", model: "scribe_v2", language: "en", credentialRef: "ELEVENLABS_API_KEY" },
  summary: { instruction: "Built-in summary instruction", reasoningMode: "providers", provider: "openai", model: "gpt-4o-mini", credentialRef: "OPENAI_API_KEY" },
};

interface RunBundle { run: { id: string } & Record<string, unknown>; transcript?: unknown; summary?: unknown; speakerCorrections?: unknown[]; }

function recording(id: string, groupId: string, startedAt: string, run: RunBundle | null = null, captureState = "ready") {
  return {
    recording: {
      id, groupId, startedAt, endedAt: "2026-09-25T10:01:00.000Z", durationSeconds: 60,
      captureState, captureErrorCode: captureState === "incomplete" ? "system-audio-interrupted" : null,
      audioState: "available", audioErrorCode: null, currentRunId: run?.run.id ?? null,
    },
    runs: run ? [run] : [],
  };
}

function completeRun(): RunBundle {
  return {
    run: {
      id: RUN, recordingId: FIRST, sourceRecordingIds: [FIRST, SECOND], kind: "reprocess", sourceRunId: null,
      provider: "elevenlabs", model: "scribe_v2", config: CONFIG, configError: null,
      stage: "summary", status: "complete", errorCode: null, retryAt: null, retryCount: 0,
      hasRawProviderResponse: true, hasTranscript: true, hasSummary: true,
      createdAt: "2026-09-25T10:02:00.000Z", updatedAt: "2026-09-25T10:03:00.000Z",
    },
    transcript: { text: "Discussion", segments: [{ start: 1, end: 2, speaker: "speaker-1", text: "Discussion" }] },
    summary: { text: "## Decision\nRelease on Friday.", speakerCorrectionRevision: 1 },
    speakerCorrections: [{ speakerId: "speaker-1", profileId: null, displayName: "Alice", source: "model", revision: 1 }],
  };
}

const heroMock = `
import React from "react";
const passthrough = ({children}) => React.createElement(React.Fragment, null, children);
const textOf = (value) => Array.isArray(value) ? value.map(textOf).join("") : typeof value === "string" || typeof value === "number" ? String(value) : value?.props ? textOf(value.props.children) : "";
export const Button = ({children,onPress,"aria-label":label}) => {
  const buttons = globalThis.__meetingResultsButtonHandlers;
  const text = textOf(children);
  if (buttons && text) {
    const existing = buttons.find((item) => item.label === text);
    if (existing) existing.onPress = onPress;
    else buttons.push({label:text,onPress});
  }
  return React.createElement("button", {onClick:onPress,"aria-label":label}, children);
};
export const Label = passthrough;
export const ListBox = Object.assign(passthrough,{Item:passthrough,ItemIndicator:passthrough});
export const Dropdown = Object.assign(passthrough,{Popover:passthrough,Menu:passthrough,Item:passthrough});
export const Popover = Object.assign(passthrough,{Content:passthrough,Dialog:passthrough,Heading:passthrough});
export const Select = Object.assign(passthrough,{Trigger:passthrough,Value:passthrough,Indicator:passthrough,Popover:passthrough});
export const Tabs = Object.assign(passthrough,{List:passthrough,Tab:passthrough,Indicator:passthrough});
export const Alert = Object.assign(passthrough,{Indicator:passthrough,Content:passthrough,Title:passthrough,Description:passthrough});
export const Spinner = () => null;
export const Tooltip = Object.assign(({children}) => React.createElement(React.Fragment, null, children),{Content:() => null,Trigger:passthrough});
export const Modal = Object.assign(({isOpen,children}) => isOpen ? React.createElement(React.Fragment,null,children) : null,{Backdrop:passthrough,Container:passthrough,Dialog:passthrough,CloseTrigger:passthrough,Header:passthrough,Heading:passthrough,Body:passthrough,Footer:passthrough});
`;

function findNode(tree: unknown, predicate: (node: ReactNodeLike) => boolean): ReactNodeLike | null {
  if (Array.isArray(tree)) return tree.map((item) => findNode(item, predicate)).find(Boolean) ?? null;
  if (!tree || typeof tree !== "object") return null;
  const node = tree as ReactNodeLike;
  if (predicate(node)) return node;
  // Slot props (e.g. a notice's `actions`) hold elements too, not just children.
  return Object.values(node.props ?? {}).map((value) => findNode(value, predicate)).find(Boolean) ?? null;
}

function textOf(value: unknown): string {
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (typeof value === "string" || typeof value === "number") return String(value);
  const node = value as ReactNodeLike | null | undefined;
  return node?.props ? textOf((node.props as { children?: unknown }).children) : "";
}

async function mountPanel(t: TestContext, items: unknown[], { viewMode = "raw", playback = { success: false, error: "mixer-failed" }, preview = false, mockPipeline }: {
  viewMode?: "raw" | "enhanced";
  playback?: { success: boolean; error?: string };
  preview?: boolean;
  mockPipeline?: { waitingSeconds?: number };
} = {}) {
  const calls: MountedCalls = { create: [], export: [], delete: [], update: [], playback: [], speaker: [], retry: [] };
  let listedItems = items;
  let setCapturePhase: (phase: string) => void = () => {};
  const api = {
    meetingProcessingListForNote: async () => ({ success: true, recordings: listedItems }),
    onMeetingProcessingUpdated: () => () => {},
    getSpeakerProfiles: async () => [],
    getActions: async () => [{
      id: 1,
      name: "Detailed Notes",
      description: "Meeting summary",
      prompt: CONFIG.summary.instruction,
      icon: "notepad-text",
      is_builtin: 1,
      sort_order: 1,
      translation_key: "notes.actions.builtin.detailedNotes",
      created_at: "2026-09-25T10:00:00.000Z",
      updated_at: "2026-09-25T10:00:00.000Z",
    }],
    meetingRecordingGetPlaybackPath: async (...args: unknown[]) => { calls.playback.push(args); return playback; },
    meetingRecordingExportAudio: async (input: Record<string, unknown>) => { calls.export.push(input); return { success: true }; },
    meetingRecordingDeleteAudio: async (id: string) => {
      calls.delete.push(id);
      listedItems = listedItems.map((item) => {
        const part = item as ReturnType<typeof recording>;
        return part.recording.id === id ? { ...part, recording: { ...part.recording, audioState: "deleted" } } : part;
      });
      return { success: true };
    },
    meetingProcessingCreateRun: async (input: Record<string, unknown>) => { calls.create.push(input); return { success: true, result: { run: { id: "00000000-0000-4000-8000-000000000004" } } }; },
    meetingProcessingUpdateBlockedRunConfig: async (input: Record<string, unknown>) => { calls.update.push(input); return { success: true }; },
    meetingProcessingSetSpeakerCorrection: async (input: Record<string, unknown>) => {
      calls.speaker.push(input);
      listedItems = listedItems.map((item) => {
        const part = item as ReturnType<typeof recording> & { runs: RunBundle[] };
        return { ...part, runs: part.runs.map((bundle) => {
          if (bundle.run.id !== input.runId) return bundle;
          const corrections = (bundle.speakerCorrections ?? []) as Array<Record<string, unknown>>;
          const existing = corrections.find((correction) => correction.speakerId === input.speakerId);
          return { ...bundle, speakerCorrections: [
            ...corrections.filter((correction) => correction.speakerId !== input.speakerId),
            { speakerId: input.speakerId, profileId: input.profileId, displayName: input.displayName, source: "user", revision: Number(existing?.revision ?? 0) + 1 },
          ] };
        }) };
      });
      return { success: true };
    },
    meetingProcessingRetryRun: async (id: string) => { calls.retry.push(id); return { success: true }; },
  };
  let root: ReturnType<typeof createRoot> | undefined;
  installBrowserGlobals(t, {
    window: {
      electronAPI: api,
      // The shared harness stubs setInterval; NoteNotices still calls its matching browser cleanup API.
      clearInterval: (_id: number) => {},
    },
  });
  const container = installHookDom(t);
  const mountedGlobalKeys = [
    "window",
    "document",
    "localStorage",
    "IS_REACT_ACT_ENVIRONMENT",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ] as const;
  const globalValues = globalThis as Record<string, unknown>;
  const mountedGlobals = new Map(mountedGlobalKeys.map((key) => [key, globalValues[key]] as const));
  t.after(async () => {
    const valuesBeforeUnmount = new Map(mountedGlobalKeys.map((key) => [key, globalValues[key]] as const));
    const restore = (values: Map<(typeof mountedGlobalKeys)[number], unknown>) => {
      for (const [key, value] of values) {
        if (value === undefined) delete globalValues[key];
        else globalValues[key] = value;
      }
    };
    restore(mountedGlobals);
    try {
      if (root) await React.act(async () => root.unmount());
    } finally {
      restore(valuesBeforeUnmount);
    }
  });
  // Fake-DOM document from installHookDom; structural typing at this seam.
  const document = globalThis.document as unknown as Record<string, unknown>;
  const createElement = document.createElement as (name: string) => HTMLElement;
  document.createElement = (name: string) => {
    const element = createElement(name) as HTMLElement & { pause?(): void };
    if (name === "audio") element.pause = () => {};
    return element;
  };
  const mocks = globalThis as GlobalWithMocks;
  const previousButtonHandlers = mocks.__meetingResultsButtonHandlers;
  mocks.__meetingResultsButtonHandlers = [];
  t.after(() => previousButtonHandlers === undefined
    ? delete mocks.__meetingResultsButtonHandlers
    : mocks.__meetingResultsButtonHandlers = previousButtonHandlers);
  const previousDialog = mocks.__meetingResultsConfirmDialog;
  t.after(() => previousDialog === undefined ? delete (mocks as { __meetingResultsConfirmDialog?: unknown }).__meetingResultsConfirmDialog : mocks.__meetingResultsConfirmDialog = previousDialog);
  const vite = await (vitePromise ??= createRendererServer({ after: (close: () => Promise<void>) => cleanup.push(close) } as unknown as TestContext, {
    cachePrefix: "meeting-results-panel-hero-",
    noExternal: ["@heroui/react"],
    mockModules: {
      "@heroui/react": heroMock,
      "react-i18next": `export function useTranslation() { return { t: (key, options) => options?.defaultValue ?? key }; }`,
      "/hooks/useDateTimePreferences": `export function useDateTimePreferences() { return { dateFormat: "locale", timeFormat: "locale" }; }`,
      "/ui/ProviderIcon": `export const ProviderIcon = () => null;`,
      "/ui/dialog": `export const ConfirmDialog = (props) => { globalThis.__meetingResultsConfirmDialog = props; return null; };`,
      "/helpers/meetingRecordingConfigSnapshot": `export function snapshotMeetingRecordingConfig(transcriptionOverride) { const config = ${JSON.stringify(CONFIG)}; return { config: transcriptionOverride ? { ...config, transcription: transcriptionOverride } : config, configError: null }; } export function builtinMeetingSummaryInstruction() { return "Built-in summary instruction"; }`,
    },
  }));
  const module = await vite.moduleGraph.getModuleByUrl("/components/notes/MeetingResultsPanel.tsx");
  if (module) vite.moduleGraph.invalidateModule(module);
  const { default: MeetingResultsPanel } = await vite.ssrLoadModule("/components/notes/MeetingResultsPanel.tsx");
  let tree: unknown;
  function Harness() {
    const [mode, setMode] = React.useState(viewMode);
    const [capturePhase, updateCapturePhase] = React.useState("idle");
    setCapturePhase = updateCapturePhase;
    tree = MeetingResultsPanel({ noteId: 1, locale: "en", previewRecordings: preview ? items : undefined, viewMode: mode, onViewModeChange: setMode,
      capturePhase,
      mockPipeline,
      fallbackText: { raw: "Manual notes", enhanced: "No summary", transcript: "No transcript" },
      manualContent: React.createElement("p", null, "Manual notes"), renderFallbackTranscript: () => React.createElement("p", null, "No transcript"), fallbackSummary: React.createElement("p", null, "No summary") });
    return tree;
  }
  root = createRoot(container);
  await React.act(async () => { root.render(React.createElement(Harness)); await Promise.resolve(); });
  const flush = async (action: () => void) => React.act(async () => { action(); await new Promise<void>((resolve) => setImmediate(resolve)); });
  // The popover shows the transcript first; these tests exercise the audio tab.
  await flush(() => (findNode(tree, (node) => node.props?.ariaLabel === "Transcript and audio")!.props as { onChange: (tab: string) => void }).onChange("audio"));
  return {
    calls, flush, dialog: () => mocks.__meetingResultsConfirmDialog!,
    text: () => container.textContent ?? "",
    saveRecording: async (nextItems: unknown[]) => {
      listedItems = nextItems;
      await flush(() => setCapturePhase("saved"));
    },
    button(label: string) { return findNode(tree, (node) => typeof node.props?.onPress === "function" && textOf((node.props as { children?: unknown }).children).includes(label)); },
    label(label: string) { return findNode(tree, (node) => node.props?.["aria-label"] === label); },
    async clickRenderedButton(labels: string[]) {
      const button = [...(mocks.__meetingResultsButtonHandlers ?? [])].reverse().find((item) =>
        labels.some((label) => item.label.includes(label))
      );
      assert.ok(button?.onPress, `Expected rendered button matching ${labels.join(" or ")}`);
      await flush(() => {
        button.onPress!();
      });
    },
    iconButton(label: string) { return findNode(tree, (node) => node.props?.["aria-label"] === label && typeof node.props?.onPress === "function"); },
    menu(label: string) { return findNode(tree, (node) => node.props?.["aria-label"] === label && typeof node.props?.onAction === "function"); },
    showTranscriptTab() { return flush(() => (findNode(tree, (node) => node.props?.ariaLabel === "Transcript and audio" && typeof node.props?.onChange === "function")!.props as { onChange(value: string): void }).onChange("transcript")); },
    clickSpeaker(label: string) { return flush(() => (findNode(tree, (node) => typeof node.props?.onClick === "function" && textOf(node.props.children) === label)!.props as { onClick(): void }).onClick()); },
    changeSpeakerName(value: string) { return flush(() => (findNode(tree, (node) => typeof node.props?.onChange === "function" && node.props.className === "h-9 rounded-lg px-3 text-sm")!.props as { onChange(event: { target: { value: string } }): void }).onChange({ target: { value } })); },
    saveSpeaker() { return flush(() => (findNode(tree, (node) => typeof node.props?.onPress === "function" && textOf(node.props.children) === "meetingResults.saveSpeaker")!.props as { onPress(): void }).onPress()); },
  };
}

test("manual notes stay primary while an incomplete saved audio part is visible", async (t: TestContext) => {
  const items = [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", null, "incomplete")];
  const ui = await mountPanel(t, items);
  assert.match(ui.text(), /Manual notes/);
  assert.match(ui.text(), /notes.editor.capture.incomplete/);
  assert.match(ui.text(), /Audio/);
  await ui.flush(() => (ui.iconButton("Play audio")!.props as { onPress: () => void }).onPress());
  assert.deepEqual(ui.calls.playback, [[FIRST]]);
  assert.match(ui.text(), /mixer-failed/);
});

test("audio count and list include a newly saved recording without reload", async (t: TestContext) => {
  const first = recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z");
  const second = recording(SECOND, SECOND, "2026-09-25T11:00:00.000Z");
  const ui = await mountPanel(t, [first]);
  assert.ok(ui.label("Transcript and audio 1"));
  await ui.saveRecording([first, second]);
  assert.ok(ui.label("Transcript and audio 2"));
  assert.equal(ui.text().match(/\bmin\b/g)?.length, 2);
  assert.equal(ui.text().match(/Sep 25, 2026/g)?.length, 1);
});

test("previously deleted audio is absent from the popover", async (t: TestContext) => {
  const deleted = recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z");
  deleted.recording.audioState = "deleted";
  const ui = await mountPanel(t, [deleted, recording(SECOND, SECOND, "2026-09-25T11:00:00.000Z")]);
  assert.ok(ui.label("Transcript and audio 1"));
  assert.equal(ui.text().match(/\bmin\b/g)?.length, 1);
});

test("audio part actions export a mixed MP3 and confirm deletion without a transcript", async (t: TestContext) => {
  const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z")]);
  const menu = ui.menu("Audio part actions") as { props: { onAction: (key: string) => void } } | null;
  assert.ok(menu);
  await ui.flush(() => menu!.props.onAction("export"));
  assert.deepEqual(ui.calls.export, [{ recordingId: FIRST, source: "mixed" }]);
  await ui.flush(() => menu!.props.onAction("delete"));
  assert.equal(ui.dialog().open, true);
  await ui.flush(() => ui.dialog().onConfirm());
  assert.deepEqual(ui.calls.delete, [FIRST]);
  assert.ok(ui.label("Transcript and audio 0"));
  assert.equal(ui.iconButton("Play audio"), null);
});

test("Transcribe includes every saved audio part in the note across groups", async (t: TestContext) => {
  const ui = await mountPanel(t, [
    recording(FOURTH, FOURTH, "2026-09-25T10:15:00.000Z"),
    recording(SECOND, SECOND, "2026-09-25T10:05:00.000Z", null, "incomplete"),
    recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z"),
    recording(THIRD, THIRD, "2026-09-25T10:10:00.000Z"),
  ]);
  await ui.flush(() => (ui.button("Transcribe")!.props as { onPress: () => void }).onPress());
  assert.equal(ui.calls.create.length, 1);
  assert.deepEqual((ui.calls.create[0] as Record<string, unknown>).sourceRecordingIds, [FIRST, SECOND, THIRD, FOURTH]);
  assert.equal((ui.calls.create[0] as Record<string, unknown>).recordingId, FIRST);
  assert.equal(submittedSection(ui.calls.create[0], "transcription").provider, CONFIG.transcription.provider);
  assert.equal(submittedSection(ui.calls.create[0], "transcription").model, CONFIG.transcription.model);
  assert.ok((submittedSection(ui.calls.create[0], "summary").instruction as string).includes(CONFIG.summary.instruction));
});

test("a new summary reads the saved transcript without another ASR run", async (t: TestContext) => {
  const ui = await mountPanel(t, [
    recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", completeRun()),
    recording(SECOND, SECOND, "2026-09-25T10:05:00.000Z"),
  ], { viewMode: "enhanced" });
  assert.match(ui.text(), /Release on Friday/);
  await ui.flush(() => (ui.button("meetingResults.newSummary")!.props as { onPress: () => void }).onPress());
  assert.equal(ui.calls.create.length, 1);
  assert.equal((ui.calls.create[0] as Record<string, unknown>).kind, "summary");
  assert.equal((ui.calls.create[0] as Record<string, unknown>).sourceRunId, RUN);
  assert.equal((ui.calls.create[0] as Record<string, unknown>).sourceRecordingIds, undefined);
  assert.ok((submittedSection(ui.calls.create[0], "summary").instruction as string).includes(CONFIG.summary.instruction));
});

test("persisted model provenance drives auto badge; user correction removes it and offers Summary regeneration", async (t: TestContext) => {
  const ui = await mountPanel(t, [
    recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", completeRun()),
  ], { viewMode: "enhanced" });
  await ui.showTranscriptTab();
  assert.match(ui.text(), /auto/);
  await ui.clickSpeaker("Alice");
  await ui.changeSpeakerName("Speaker 1");
  await ui.saveSpeaker();
  assert.deepEqual(ui.calls.speaker, [{ runId: RUN, speakerId: "speaker-1", displayName: "Speaker 1", profileId: null }]);
  assert.doesNotMatch(ui.text(), /auto/);
  assert.match(ui.text(), /Speaker names changed/);
  assert.match(ui.text(), /This Summary was written with the earlier names/);
  await ui.clickRenderedButton(["Regenerate Summary", "meetingResults.regenerateSummary"]);
  assert.equal(ui.calls.create.at(-1)?.kind, "summary");
  assert.equal(ui.calls.create.at(-1)?.sourceRunId, RUN);
});


test("debug preview keeps retry, export and processing away from the real API", async (t: TestContext) => {
  const run = completeRun();
  run.run.status = "failed";
  const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", run)], { preview: true });
  await ui.flush(() => (ui.button("meetingResults.retry") as { props: { onPress: () => void } })!.props.onPress());
  assert.match(ui.text(), /Mock retry queued in memory/);
  await ui.flush(() => (ui.menu("Audio part actions") as { props: { onAction: (key: string) => void } })!.props.onAction("export"));
  await ui.flush(() => (ui.button("Transcribe")!.props as { onPress: () => void }).onPress());
  assert.deepEqual(ui.calls.retry, []);
  assert.deepEqual(ui.calls.export, []);
  assert.deepEqual(ui.calls.create, []);
});

test("the live waiting state and debug preview never offer a manual gate bypass", async (t: TestContext) => {
  const waiting = completeRun();
  waiting.run.kind = "initial";
  waiting.run.sourceRecordingIds = [FIRST];
  waiting.run.stage = "prepare";
  waiting.run.status = "pending";
  waiting.run.retryAt = new Date(Date.now() + 15_000).toISOString();
  waiting.run.retryCount = 0;
  waiting.run.errorCode = null;
  waiting.run.hasRawProviderResponse = false;
  waiting.run.hasTranscript = false;
  waiting.run.hasSummary = false;
  const live = await mountPanel(t, [recording(FIRST, FIRST, new Date().toISOString(), waiting)]);
  assert.match(live.text(), /transcription starts automatically when the wait ends/i);
  assert.doesNotMatch(live.text(), /Transcribe now/);

  const preview = await mountPanel(t, [], { preview: true, mockPipeline: { waitingSeconds: 15 } });
  assert.match(preview.text(), /transcription starts automatically when the wait ends/i);
  assert.doesNotMatch(preview.text(), /Transcribe now/);
  await preview.flush(() => (preview.button("Resume recording")!.props as { onPress: () => void }).onPress());
  assert.match(preview.text(), /recording resumed, pending transcription cancelled/);
  assert.deepEqual(preview.calls.create, []);
});
