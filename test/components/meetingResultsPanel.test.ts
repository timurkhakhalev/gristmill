const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const test: typeof import("node:test") = require("node:test");

const React = require("react");

const { createRoot } = require("react-dom/client");

const { createRendererServer, installBrowserGlobals, installHookDom } =
  require("../lib/rendererTestHarness.ts") as typeof import("../lib/rendererTestHarness.js");

type TestContext = import("node:test").TestContext;

interface ReactNodeLike {
  props?: Record<string, unknown> & { children?: unknown };
}

interface SummaryActionState {
  available: boolean;
  isGenerating: boolean;
  onGenerate: () => void;
}

interface MountedCalls {
  create: Array<Record<string, unknown>>;
  export: Array<Record<string, unknown>>;
  delete: string[];
  playback: unknown[][];
  speaker: Array<Record<string, unknown>>;
  summaryActions: Array<Record<string, unknown>>;
  update: Array<Record<string, unknown>>;
  retry: string[];
  cancel: string[];
}

function submittedSection(
  call: Record<string, unknown>,
  section: "transcription" | "summary"
): Record<string, unknown> {
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
  transcription: {
    mode: "providers",
    provider: "elevenlabs",
    model: "scribe_v2",
    language: "en",
    credentialRef: "ELEVENLABS_API_KEY",
  },
  summary: {
    instruction: "Built-in summary instruction",
    reasoningMode: "providers",
    provider: "openai",
    model: "gpt-4o-mini",
    credentialRef: "OPENAI_API_KEY",
  },
};

interface RunBundle {
  run: { id: string } & Record<string, unknown>;
  transcript?: unknown;
  summary?: unknown;
  speakerCorrections?: unknown[];
  speakerCorrectionRevision?: number;
}

function recording(
  id: string,
  groupId: string,
  startedAt: string,
  run: RunBundle | null = null,
  captureState = "ready"
) {
  return {
    recording: {
      id,
      groupId,
      startedAt,
      endedAt: "2026-09-25T10:01:00.000Z",
      durationSeconds: 60,
      captureState,
      captureErrorCode: captureState === "incomplete" ? "system-audio-interrupted" : null,
      audioState: "available",
      audioErrorCode: null,
      currentRunId: run?.run.id ?? null,
    },
    runs: run ? [run] : [],
  };
}

function completeRun(): RunBundle {
  return {
    run: {
      id: RUN,
      recordingId: FIRST,
      sourceRecordingIds: [FIRST, SECOND],
      hasExplicitAudioParts: true,
      omittedRecordingIds: [],
      kind: "reprocess",
      sourceRunId: null,
      provider: "elevenlabs",
      model: "scribe_v2",
      config: CONFIG,
      configError: null,
      stage: "summary",
      status: "complete",
      errorCode: null,
      speakerNamingErrorCode: null,
      retryAt: null,
      retryCount: 0,
      hasRawProviderResponse: true,
      hasTranscript: true,
      hasSummary: true,
      createdAt: "2026-09-25T10:02:00.000Z",
      updatedAt: "2026-09-25T10:03:00.000Z",
    },
    transcript: {
      text: "Discussion",
      segments: [{ start: 1, end: 2, speaker: "speaker-1", text: "Discussion" }],
    },
    summary: { text: "## Decision\nRelease on Friday.", speakerCorrectionRevision: 1 },
    speakerCorrections: [
      {
        speakerId: "speaker-1",
        profileId: null,
        displayName: "Alice",
        source: "model",
        revision: 1,
      },
    ],
    speakerCorrectionRevision: 1,
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

function findNode(
  tree: unknown,
  predicate: (node: ReactNodeLike) => boolean
): ReactNodeLike | null {
  if (Array.isArray(tree))
    return tree.map((item) => findNode(item, predicate)).find(Boolean) ?? null;

  if (!tree || typeof tree !== "object") return null;
  const node = tree as ReactNodeLike;

  if (predicate(node)) return node;

  // Slot props (e.g. a notice's `actions`) hold elements too, not just children.
  return (
    Object.values(node.props ?? {})
      .map((value) => findNode(value, predicate))
      .find(Boolean) ?? null
  );
}

function findNodes(tree: unknown, predicate: (node: ReactNodeLike) => boolean): ReactNodeLike[] {
  if (Array.isArray(tree)) return tree.flatMap((item) => findNodes(item, predicate));

  if (!tree || typeof tree !== "object") return [];
  const node = tree as ReactNodeLike;

  return [
    ...(predicate(node) ? [node] : []),
    ...Object.values(node.props ?? {}).flatMap((value) => findNodes(value, predicate)),
  ];
}

function textOf(value: unknown): string {
  if (Array.isArray(value)) return value.map(textOf).join("");

  if (typeof value === "string" || typeof value === "number") return String(value);
  const node = value as ReactNodeLike | null | undefined;

  return node?.props ? textOf((node.props as { children?: unknown }).children) : "";
}

async function mountPanel(
  t: TestContext,
  items: unknown[],
  {
    viewMode = "raw",
    playback = { success: false, error: "mixer-failed" },
    preview = false,
    mockPipeline,
    summaryAction,
    initialCapturePhase = "idle",
    noteTranscript,
    failRefreshAfterCorrection = false,
    failParticipants = false,
  }: {
    viewMode?: "raw" | "enhanced";
    playback?: { success: boolean; error?: string };
    preview?: boolean;
    mockPipeline?: { waitingSeconds?: number };
    summaryAction?: (
      input: Record<string, unknown>
    ) => Promise<{ success: boolean; error?: string }>;
    initialCapturePhase?: string;
    noteTranscript?: import("../../src/contracts/noteRead.js").NoteTranscript;
    // Simulates a post-save re-read that fails (main busy, transient IPC error):
    // the correction is persisted but the panel cannot observe it, so only its
    // own optimistic update can flag the Summary stale.
    failRefreshAfterCorrection?: boolean;
    failParticipants?: boolean;
  } = {}
) {
  const calls: MountedCalls = {
    create: [],
    export: [],
    delete: [],
    update: [],
    playback: [],
    speaker: [],
    summaryActions: [],
    retry: [],
    cancel: [],
  };

  let participantLoads = 0;
  const notifications: string[] = [];
  let listedItems = items;
  let correctionSaved = false;
  let setCapturePhase: (phase: string) => void = () => {};

  const api = {
    meetingProcessingListForNote: async () => {
      if (failRefreshAfterCorrection && correctionSaved)
        return { success: false, error: "list-failed" };

      return { success: true, recordings: listedItems };
    },
    onMeetingProcessingUpdated: () => () => {},
    getSpeakerProfiles: async () => [],
    getNote: async () => {
      participantLoads++;
      if (failParticipants) throw new Error("participant-load-failed");
      return { participants: JSON.stringify([{ email: "person@example.com" }]) };
    },
    onNoteUpdated: () => () => {},
    getNoteOutput: async (request: { noteId: number; scope: "note" | "run"; runId?: string }) => {
      if (request.scope === "note")
        return {
          noteId: request.noteId,
          scope: "note",
          summary: null,
          transcript: noteTranscript ?? null,
          summaryFreshness: { status: "unknown", reasons: [] },
          diagnostics: [],
        };

      const result = listedItems
        .flatMap((item) => (item as { runs: RunBundle[] }).runs)
        .find((bundle) => bundle.run.id === request.runId);

      const summaryRevision = (
        result?.summary as { speakerCorrectionRevision?: number } | undefined
      )?.speakerCorrectionRevision;

      return {
        noteId: request.noteId,
        scope: "run",
        runId: request.runId,
        result: result ?? null,
        summaryFreshness: {
          status:
            summaryRevision !== undefined && summaryRevision !== result?.speakerCorrectionRevision
              ? "stale"
              : "unknown",
          reasons: [],
        },
        diagnostics: [],
      };
    },
    getContactProfiles: async () => [],
    getActions: async () => [
      {
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
      },
    ],
    meetingRecordingGetPlaybackPath: async (...args: unknown[]) => {
      calls.playback.push(args);

      return playback;
    },
    meetingRecordingReleasePlayback: async () => ({ success: true }),
    meetingRecordingExportAudio: async (input: Record<string, unknown>) => {
      calls.export.push(input);

      return { success: true };
    },
    meetingRecordingDeleteAudio: async (id: string) => {
      calls.delete.push(id);
      listedItems = listedItems.map((item) => {
        const part = item as ReturnType<typeof recording>;

        return part.recording.id === id
          ? { ...part, recording: { ...part.recording, audioState: "deleted" } }
          : part;
      });

      return { success: true };
    },
    meetingProcessingCreateRun: async (input: Record<string, unknown>) => {
      calls.create.push(input);

      return { success: true, result: { run: { id: "00000000-0000-4000-8000-000000000004" } } };
    },
    meetingProcessingUpdateBlockedRunConfig: async (input: Record<string, unknown>) => {
      calls.update.push(input);

      return { success: true };
    },
    meetingProcessingSetSpeakerCorrection: async (input: Record<string, unknown>) => {
      calls.speaker.push(input);
      correctionSaved = true;
      // Main persists the correction, so the panel's post-task refresh (runTask
      // awaits refresh) reads the new revision back from list-for-note.
      listedItems = listedItems.map((item) => {
        const part = item as ReturnType<typeof recording> & { runs: RunBundle[] };

        return {
          ...part,
          runs: part.runs.map((bundle) => {
            if (bundle.run.id !== input.runId) return bundle;
            const corrections = (bundle.speakerCorrections ?? []) as Array<Record<string, unknown>>;

            const existing = corrections.find(
              (correction) => correction.speakerId === input.speakerId
            );

            return {
              ...bundle,
              speakerCorrectionRevision: (bundle.speakerCorrectionRevision ?? 0) + 1,
              speakerCorrections: [
                ...corrections.filter((correction) => correction.speakerId !== input.speakerId),
                {
                  speakerId: input.speakerId,
                  profileId: input.profileId,
                  displayName: input.displayName,
                  source: "user",
                  revision: Number(existing?.revision ?? 0) + 1,
                },
              ],
            };
          }),
        };
      });

      return { success: true };
    },
    meetingProcessingRunSummaryAction: async (input: Record<string, unknown>) => {
      calls.summaryActions.push(input);

      return summaryAction ? summaryAction(input) : { success: true };
    },
    meetingProcessingRetryRun: async (id: string) => {
      calls.retry.push(id);

      return { success: true };
    },
    meetingProcessingCancelRun: async (id: string) => {
      calls.cancel.push(id);
      listedItems = listedItems.map((item) => {
        const part = item as ReturnType<typeof recording> & { runs: RunBundle[] };

        return {
          ...part,
          runs: part.runs.map((bundle) =>
            bundle.run.id === id
              ? {
                  ...bundle,
                  run: {
                    ...bundle.run,
                    status: "cancelled",
                    errorCode: "processing-cancelled",
                    retryAt: null,
                  },
                }
              : bundle
          ),
        };
      });

      return { success: true };
    },
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
    const valuesBeforeUnmount = new Map(
      mountedGlobalKeys.map((key) => [key, globalValues[key]] as const)
    );

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
    const element = createElement(name) as HTMLElement & { pause?(): void; load?(): void };

    if (name === "audio") {
      element.pause = () => {};

      element.load = () => {};
    }

    return element;
  };

  const mocks = globalThis as GlobalWithMocks;
  const previousButtonHandlers = mocks.__meetingResultsButtonHandlers;
  mocks.__meetingResultsButtonHandlers = [];
  t.after(() =>
    previousButtonHandlers === undefined
      ? delete mocks.__meetingResultsButtonHandlers
      : (mocks.__meetingResultsButtonHandlers = previousButtonHandlers)
  );
  const previousDialog = mocks.__meetingResultsConfirmDialog;
  t.after(() =>
    previousDialog === undefined
      ? delete (mocks as { __meetingResultsConfirmDialog?: unknown }).__meetingResultsConfirmDialog
      : (mocks.__meetingResultsConfirmDialog = previousDialog)
  );

  const vite = await (vitePromise ??= createRendererServer(
    { after: (close: () => Promise<void>) => cleanup.push(close) } as unknown as TestContext,
    {
      cachePrefix: "meeting-results-panel-hero-",
      noExternal: ["@heroui/react"],
      mockModules: {
        "@heroui/react": heroMock,
        "react-i18next": `const t = (key, options) => options?.defaultValue ?? key; export function useTranslation() { return { t }; }`,
        "/hooks/useDateTimePreferences": `export function useDateTimePreferences() { return { dateFormat: "locale", timeFormat: "locale" }; }`,
        "/ui/ProviderIcon": `export const ProviderIcon = () => null;`,
        "/ui/dialog": `export const ConfirmDialog = (props) => { globalThis.__meetingResultsConfirmDialog = props; return null; };`,
        "/helpers/meetingRecordingConfigSnapshot": `export async function snapshotMeetingRecordingConfig(transcriptionOverride) { const config = ${JSON.stringify(CONFIG)}; return { config: transcriptionOverride ? { ...config, transcription: transcriptionOverride } : config, configError: null }; } export function builtinMeetingSummaryInstruction() { return "Built-in summary instruction"; }`,
      },
    }
  ));

  const module = await vite.moduleGraph.getModuleByUrl("/components/notes/MeetingResultsPanel.tsx");

  if (module) vite.moduleGraph.invalidateModule(module);

  const { default: MeetingResultsPanel } = await vite.ssrLoadModule(
    "/components/notes/MeetingResultsPanel.tsx"
  );

  const { default: NoteRecordControl } = await vite.ssrLoadModule(
    "/components/notes/NoteRecordControl.tsx"
  );

  const actions = (selectedSummaryAction: SummaryActionState) =>
    React.createElement(NoteRecordControl, {
      isRecording: false,
      isProcessing: false,
      isGeneratingSummary: selectedSummaryAction.isGenerating,
      capturePhase: "idle",
      captureStartedAt: null,
      showSummaryAction: selectedSummaryAction.available,
      onStart: () => {},
      onStop: () => {},
      onGenerateSummary: selectedSummaryAction.onGenerate,
    });

  let tree: unknown;

  function Harness() {
    const [mode, setMode] = React.useState(viewMode);
    const [capturePhase, updateCapturePhase] = React.useState(initialCapturePhase);
    setCapturePhase = updateCapturePhase;
    tree = MeetingResultsPanel({
      noteId: 1,
      locale: "en",
      previewRecordings: preview ? items : undefined,
      viewMode: mode,
      onViewModeChange: setMode,
      capturePhase,
      actions,
      mockPipeline,
      fallbackText: { raw: "Manual notes", enhanced: "", transcript: "" },
      manualContent: React.createElement("p", null, "Manual notes"),
      renderFallbackTranscript: () => React.createElement("p", null, "No transcript"),
      fallbackSummary: (selectedSummaryAction: SummaryActionState) =>
        React.createElement(
          "p",
          null,
          selectedSummaryAction.available ? "Summary can be created" : "No summary"
        ),
    });

    return tree;
  }

  const { ToastContext } = await vite.ssrLoadModule("/components/ui/useToast.ts");
  function ToastHarness() {
    const [toastCount, setToastCount] = React.useState(0);
    const toast = React.useCallback((props: { title: string }) => {
      notifications.push(props.title);
      setToastCount((count: number) => count + 1);
      return String(notifications.length);
    }, []);
    return React.createElement(ToastContext.Provider, {
      value: { toast, toastCount, dismiss: () => {} },
    }, React.createElement(Harness));
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(failParticipants ? ToastHarness : Harness));
    await Promise.resolve();
  });

  const flush = async (action: () => void) =>
    React.act(async () => {
      action();
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

  // The popover shows the transcript first; these tests exercise the audio tab.
  await flush(() =>
    (
      findNode(tree, (node) => node.props?.ariaLabel === "Transcript and audio")!.props as {
        onChange: (tab: string) => void;
      }
    ).onChange("audio")
  );

  return {
    calls,
    notifications,
    participantLoads: () => participantLoads,
    flush,
    tree: () => tree,
    dialog: () => mocks.__meetingResultsConfirmDialog!,
    text: () => container.textContent ?? "",
    saveRecording: async (nextItems: unknown[]) => {
      listedItems = nextItems;
      await flush(() => setCapturePhase("saved"));
    },
    setCapturePhase: (phase: string) => flush(() => setCapturePhase(phase)),
    button(label: string) {
      return findNode(
        tree,
        (node) =>
          typeof node.props?.onPress === "function" &&
          textOf((node.props as { children?: unknown }).children).includes(label)
      );
    },
    label(label: string) {
      return findNode(tree, (node) => node.props?.["aria-label"] === label);
    },
    async clickRenderedButton(labels: string[]) {
      const button = [...(mocks.__meetingResultsButtonHandlers ?? [])]
        .reverse()
        .find((item) => labels.some((label) => item.label.includes(label)));

      assert.ok(button?.onPress, `Expected rendered button matching ${labels.join(" or ")}`);
      await flush(() => {
        button.onPress!();
      });
    },
    async clickRenderedButtonExact(label: string) {
      const button = [...(mocks.__meetingResultsButtonHandlers ?? [])]
        .reverse()
        .find((item) => item.label === label);

      assert.ok(button?.onPress, `Expected rendered button exactly matching ${label}`);
      await flush(() => button.onPress!());
    },
    renderedButtonLabels() {
      return (mocks.__meetingResultsButtonHandlers ?? []).map((item) => item.label);
    },
    iconButton(label: string) {
      return findNode(
        tree,
        (node) => node.props?.["aria-label"] === label && typeof node.props?.onPress === "function"
      );
    },
    menu(label: string) {
      return findNode(
        tree,
        (node) => node.props?.["aria-label"] === label && typeof node.props?.onAction === "function"
      );
    },
    showTranscriptTab() {
      return flush(() =>
        (
          findNode(
            tree,
            (node) =>
              node.props?.ariaLabel === "Transcript and audio" &&
              typeof node.props?.onChange === "function"
          )!.props as { onChange(value: string): void }
        ).onChange("transcript")
      );
    },
    clickSpeaker(label: string) {
      return flush(() =>
        (
          findNode(
            tree,
            (node) =>
              typeof node.props?.onClick === "function" && textOf(node.props.children) === label
          )!.props as { onClick(): void }
        ).onClick()
      );
    },
    changeSpeakerName(value: string) {
      return flush(() =>
        (
          findNode(
            tree,
            (node) =>
              typeof node.props?.onChange === "function" &&
              node.props.className === "h-9 rounded-lg px-3 text-sm"
          )!.props as { onChange(event: { target: { value: string } }): void }
        ).onChange({ target: { value } })
      );
    },
    saveSpeaker() {
      return flush(() =>
        (
          findNode(
            tree,
            (node) =>
              typeof node.props?.onPress === "function" &&
              textOf(node.props.children) === "meetingResults.saveSpeaker"
          )!.props as { onPress(): void }
        ).onPress()
      );
    },
    progressStart() {
      return findNode(tree, (node) => typeof node.props?.progressStartedAt === "number")?.props
        ?.progressStartedAt;
    },
    warningIcons() {
      const count = (node: typeof container): number =>
        Number(
          Boolean(node.attributes.get("aria-label")?.startsWith("notes.editor.capture.incomplete"))
        ) + node.childNodes.reduce((total, child) => total + count(child), 0);

      return count(container);
    },
  };
}

for (const timeZone of ["Asia/Tokyo", "America/New_York"]) {
  test(`processing clock treats SQLite timestamps as UTC in ${timeZone}`, async (t: TestContext) => {
    const previousTz = process.env.TZ;
    process.env.TZ = timeZone;
    t.after(() => {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    });
    const run = completeRun();
    run.run.stage = "asr";
    run.run.status = "running";
    run.run.createdAt = "2026-09-29 08:24:54";
    const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", run)]);
    assert.equal(ui.progressStart(), Date.parse("2026-09-29T08:24:54Z"));
  });
}

test("interrupted recordings keep audio and transcript available without capture warnings", async (t: TestContext) => {
  const items = [
    recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", null, "incomplete"),
    recording(SECOND, SECOND, "2026-09-25T11:00:00.000Z"),
    recording(THIRD, THIRD, "2026-09-25T12:00:00.000Z", null, "incomplete"),
  ];

  const ui = await mountPanel(t, items, {
    noteTranscript: {
      note_id: 1,
      status: "partial",
      text: "Saved discussion",
      segments: null,
      speakers: [],
      timeline: {
        unit: "ms",
        duration_ms: 180000,
        basis: "concatenated_recording_time",
        intentional_pauses: "excluded",
      },
      diagnostics: [`part-capture-incomplete:${FIRST}`, `part-uncovered:${THIRD}`],
    },
  });

  assert.match(ui.text(), /Manual notes/);
  assert.equal(ui.warningIcons(), 0);
  assert.doesNotMatch(ui.text(), /notes.editor.capture.incomplete/);
  assert.match(ui.text(), /Audio/);
  await ui.flush(() => (ui.iconButton("Play audio")!.props as { onPress: () => void }).onPress());
  assert.deepEqual(ui.calls.playback, [[THIRD]]);
  assert.match(ui.text(), /mixer-failed/);
  await ui.showTranscriptTab();
  assert.match(ui.text(), /Saved discussion/);
  assert.doesNotMatch(
    ui.text(),
    /This Note transcript is incomplete|part-capture-incomplete|part-uncovered/
  );
});

test("audio list includes a newly saved recording without reload", async (t: TestContext) => {
  const first = recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z");
  const second = recording(SECOND, SECOND, "2026-09-25T11:00:00.000Z");
  const ui = await mountPanel(t, [first]);
  assert.equal(ui.warningIcons(), 0);
  assert.ok(ui.label("Transcript and audio"));
  await ui.saveRecording([first, second]);
  assert.ok(ui.label("Transcript and audio"));
  assert.equal(ui.text().match(/\bmin\b/g)?.length, 2);
  assert.equal(ui.text().match(/Sep 25, 2026/g)?.length, 1);
});

test("previously deleted audio is absent from the popover", async (t: TestContext) => {
  const deleted = recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z");
  deleted.recording.audioState = "deleted";
  const ui = await mountPanel(t, [deleted, recording(SECOND, SECOND, "2026-09-25T11:00:00.000Z")]);
  assert.ok(ui.label("Transcript and audio"));
  assert.equal(ui.text().match(/\bmin\b/g)?.length, 1);
});

test("audio part actions export a mixed MP3 and confirm deletion without a transcript", async (t: TestContext) => {
  const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z")]);

  const menu = ui.menu("Audio part actions") as {
    props: { onAction: (key: string) => void };
  } | null;

  assert.ok(menu);
  await ui.flush(() => menu!.props.onAction("export"));
  assert.deepEqual(ui.calls.export, [{ recordingId: FIRST, source: "mixed" }]);
  await ui.flush(() => menu!.props.onAction("delete"));
  assert.equal(ui.dialog().open, true);
  await ui.flush(() => ui.dialog().onConfirm());
  assert.deepEqual(ui.calls.delete, [FIRST]);
  assert.ok(ui.label("Transcript and audio"));
  assert.equal(ui.iconButton("Play audio"), null);
});

test("Transcribe & Summary includes every saved audio part in the note across groups", async (t: TestContext) => {
  const ui = await mountPanel(t, [
    recording(FOURTH, FOURTH, "2026-09-25T10:15:00.000Z"),
    recording(SECOND, SECOND, "2026-09-25T10:05:00.000Z", null, "incomplete"),
    recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z"),
    recording(THIRD, THIRD, "2026-09-25T10:10:00.000Z"),
  ]);

  await ui.flush(() =>
    (ui.button("Transcribe & Summary")!.props as { onPress: () => void }).onPress()
  );
  assert.equal(ui.calls.create.length, 1);
  assert.equal((ui.calls.create[0].config as Record<string, unknown>).generateSummary, true);
  assert.deepEqual((ui.calls.create[0] as Record<string, unknown>).sourceRecordingIds, [
    FIRST,
    SECOND,
    THIRD,
    FOURTH,
  ]);
  assert.equal((ui.calls.create[0] as Record<string, unknown>).recordingId, FIRST);
  assert.equal(
    submittedSection(ui.calls.create[0], "transcription").provider,
    CONFIG.transcription.provider
  );
  assert.equal(
    submittedSection(ui.calls.create[0], "transcription").model,
    CONFIG.transcription.model
  );
  assert.ok(
    (submittedSection(ui.calls.create[0], "summary").instruction as string).includes(
      CONFIG.summary.instruction
    )
  );
});

test("a new summary reads the saved transcript without another ASR run", async (t: TestContext) => {
  const ui = await mountPanel(
    t,
    [
      recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", completeRun()),
      recording(SECOND, SECOND, "2026-09-25T10:05:00.000Z"),
    ],
    { viewMode: "enhanced" }
  );

  assert.match(ui.text(), /Release on Friday/);
  assert.match(ui.text(), /openai · gpt-4o-mini/);
  await ui.flush(() =>
    (ui.button("meetingResults.newSummary")!.props as { onPress: () => void }).onPress()
  );
  assert.equal(ui.calls.create.length, 1);
  assert.equal((ui.calls.create[0] as Record<string, unknown>).kind, "summary");
  assert.equal((ui.calls.create[0] as Record<string, unknown>).sourceRunId, RUN);
  assert.equal((ui.calls.create[0] as Record<string, unknown>).sourceRecordingIds, undefined);
  assert.ok(
    (submittedSection(ui.calls.create[0], "summary").instruction as string).includes(
      CONFIG.summary.instruction
    )
  );
});

test("Summary labels show the saved provider, including BB runs", async (t: TestContext) => {
  const bbRun = completeRun();
  bbRun.run.config = {
    ...CONFIG,
    summary: {
      instruction: "Built-in summary instruction",
      reasoningMode: "agent",
      agentProvider: "acp-opencode",
      model: "cpa/glm-5.3-flash",
      agentReasoningLevel: "high",
    },
  };

  const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", bbRun)], {
    viewMode: "enhanced",
  });

  assert.match(ui.text(), /bb · cpa\/glm-5\.3-flash/);
});

test("running Summary elapsed time reads SQLite timestamps as UTC", async (t: TestContext) => {
  const running = completeRun();
  const startedAt = Date.now() - 120_000;
  running.run.createdAt = new Date(startedAt).toISOString().slice(0, 19).replace("T", " ");
  running.run.status = "running";
  running.run.hasSummary = false;
  running.summary = undefined;
  const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", running)]);
  const notice = findNode(ui.tree(), (node) => typeof node.props?.progressStartedAt === "number");
  assert.ok(notice);
  assert.ok(Math.abs(Number(notice.props?.progressStartedAt) - startedAt) < 1000);
});

// Regression (#177): the DB keeps a cleared (display_name = '') tombstone for a
// revoked model proposal, so the authoritative revision is 2 while the display
// list is empty. The panel must read the authoritative revision from the result
// DTO, not sum the visible corrections — otherwise a fresh Summary written at
// revision 2 looks stale forever.
test("a revoked model name does not mark a fresh Summary stale", async (t: TestContext) => {
  const run = completeRun();
  // Revoked proposal: no visible correction, authoritative revision 2, and the
  // Summary was regenerated at exactly revision 2.
  run.speakerCorrections = [];
  run.speakerCorrectionRevision = 2;
  run.summary = { text: "## Decision\nRelease on Friday.", speakerCorrectionRevision: 2 };

  const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", run)], {
    viewMode: "enhanced",
  });

  assert.match(ui.text(), /Release on Friday/);
  assert.doesNotMatch(
    ui.text(),
    /Speaker names changed/,
    "a fresh Summary at the authoritative revision is not stale"
  );
});

// Regression (#177): a new user correction bumps the authoritative revision, so
// the same Summary written at the older revision must show stale again.
test("a new user correction marks the Summary stale", async (t: TestContext) => {
  const run = completeRun();
  run.speakerCorrections = [
    { speakerId: "speaker-1", profileId: null, displayName: "Alice", source: "model", revision: 2 },
  ];
  run.speakerCorrectionRevision = 2;
  run.summary = { text: "## Decision\nRelease on Friday.", speakerCorrectionRevision: 2 };

  const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", run)], {
    viewMode: "enhanced",
  });

  await ui.showTranscriptTab();
  assert.doesNotMatch(ui.text(), /Speaker names changed/);
  await ui.clickSpeaker("Alice");
  await ui.changeSpeakerName("Alice Smith");
  await ui.saveSpeaker();
  assert.deepEqual(ui.calls.speaker, [
    { runId: RUN, speakerId: "speaker-1", displayName: "Alice Smith", profileId: null },
  ]);
  assert.match(
    ui.text(),
    /Speaker names changed/,
    "a correction past the Summary's revision shows stale"
  );
});

// Regression (#177 R177-2): the live branch must flag the stale Summary from its
// own optimistic update, not rely on the post-task re-read. Here the re-read
// fails after the write is persisted, so without the optimism the notice never
// appears — the panel's optimistic revision is the only thing that can turn the
// Summary stale.
test("a new user correction shows stale even when the post-save re-read fails", async (t: TestContext) => {
  const run = completeRun();
  run.speakerCorrections = [
    { speakerId: "speaker-1", profileId: null, displayName: "Alice", source: "model", revision: 2 },
  ];
  run.speakerCorrectionRevision = 2;
  run.summary = { text: "## Decision\nRelease on Friday.", speakerCorrectionRevision: 2 };

  const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", run)], {
    viewMode: "enhanced",
    failRefreshAfterCorrection: true,
  });

  await ui.showTranscriptTab();
  assert.doesNotMatch(ui.text(), /Speaker names changed/);
  await ui.clickSpeaker("Alice");
  await ui.changeSpeakerName("Alice Smith");
  await ui.saveSpeaker();
  assert.match(
    ui.text(),
    /Speaker names changed/,
    "the panel's own update must show stale without a fresh re-read"
  );
});

test("persisted model provenance drives auto badge; user correction removes it and offers Summary regeneration", async (t: TestContext) => {
  const ui = await mountPanel(
    t,
    [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", completeRun())],
    { viewMode: "enhanced" }
  );

  await ui.showTranscriptTab();
  assert.match(ui.text(), /auto/);
  await ui.clickSpeaker("Alice");
  await ui.changeSpeakerName("Speaker 1");
  await ui.saveSpeaker();
  assert.deepEqual(ui.calls.speaker, [
    { runId: RUN, speakerId: "speaker-1", displayName: "Speaker 1", profileId: null },
  ]);
  assert.doesNotMatch(ui.text(), /auto/);
  assert.match(ui.text(), /Speaker names changed/);
  assert.match(ui.text(), /This Summary was written with the earlier names/);
  await ui.clickRenderedButton(["Regenerate Summary", "meetingResults.regenerateSummary"]);
  assert.equal(ui.calls.create.at(-1)?.kind, "summary");
  assert.equal(ui.calls.create.at(-1)?.sourceRunId, RUN);
});

test("persisted task status shows a retry without replacing the saved Summary", async (t: TestContext) => {
  const run = completeRun();
  run.summary = {
    text: "## TLDR\nSaved Summary.",
    taskStatus: "section-error",
    taskErrorCode: "meeting-summary-section-invalid",
  };

  const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", run)], {
    viewMode: "enhanced",
  });

  assert.match(ui.text(), /Saved Summary/);
  assert.match(ui.text(), /Action items were found but not added/);
  await ui.clickRenderedButton(["Retry tasks"]);
  assert.deepEqual(ui.calls.summaryActions, [{ runId: RUN, action: "tasks" }]);
  assert.match(ui.text(), /Saved Summary/);
});

test("Recap is a manual Summary action with a visible retryable error", async (t: TestContext) => {
  let finishAction!: (result: { success: boolean; error?: string }) => void;

  const actionResult = new Promise<{ success: boolean; error?: string }>((resolve) => {
    finishAction = resolve;
  });

  const run = completeRun();
  run.summary = {
    text: "## Decision\nRelease on Friday.",
    speakerCorrectionRevision: 1,
    taskStatus: "zero",
  };

  const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", run)], {
    viewMode: "enhanced",
    summaryAction: async () => actionResult,
  });

  await ui.clickRenderedButton(["New recap"]);
  assert.match(ui.text(), /Creating recap/);
  assert.match(ui.text(), /Release on Friday/);
  finishAction({ success: false, error: "meeting-recap-json-invalid" });
  await ui.flush(() => {});
  assert.deepEqual(ui.calls.summaryActions, [{ runId: RUN, action: "recap" }]);
  assert.match(ui.text(), /The model reply didn't match the expected format/);
  assert.match(ui.text(), /Release on Friday/);
});

test("debug preview keeps retry, export and processing away from the real API", async (t: TestContext) => {
  const run = completeRun();
  run.run.status = "failed";

  const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", run)], {
    preview: true,
  });

  await ui.flush(() =>
    (ui.button("meetingResults.retry") as { props: { onPress: () => void } })!.props.onPress()
  );
  assert.match(ui.text(), /Mock retry queued in memory/);
  await ui.flush(() =>
    (ui.menu("Audio part actions") as {
      props: { onAction: (key: string) => void };
    })!.props.onAction("export")
  );
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
  assert.doesNotMatch(live.text(), /Preparing audio|meetingResults.stage.prepare/);
  assert.doesNotMatch(live.text(), /Transcribe now/);
  const waitingTranscribe = live.button("Transcribe & Summary")!;
  assert.equal(waitingTranscribe.props?.isDisabled, true);
  await live.flush(() => (waitingTranscribe.props as { onPress: () => void }).onPress());
  assert.deepEqual(live.calls.create, []);

  for (const phase of ["preparing", "recording", "paused", "saving"]) {
    await live.setCapturePhase(phase);
    assert.doesNotMatch(
      live.text(),
      /transcription starts automatically|The recording is saved|Preparing audio|Waiting to start|meetingResults.stage.prepare|meetingResults.progress.pending/i,
      phase
    );
  }

  await live.setCapturePhase("saved");
  assert.match(live.text(), /transcription starts automatically when the wait ends/i);

  // Once the gate expires, pending work still waits for the active capture.
  const queued = {
    ...waiting,
    run: { ...waiting.run, retryAt: new Date(Date.now() - 1_000).toISOString() },
  };

  const active = await mountPanel(
    t,
    [recording(FIRST, FIRST, new Date(Date.now() - 60_000).toISOString(), queued)],
    { initialCapturePhase: "recording" }
  );

  assert.doesNotMatch(
    active.text(),
    /Preparing audio|Waiting to start|meetingResults.stage.prepare|meetingResults.progress.pending/i
  );
  await active.setCapturePhase("saved");
  assert.match(active.text(), /meetingResults.stage.prepare/i);

  const preview = await mountPanel(t, [], { preview: true, mockPipeline: { waitingSeconds: 15 } });
  assert.match(preview.text(), /transcription starts automatically when the wait ends/i);
  assert.doesNotMatch(preview.text(), /Transcribe now/);
  await preview.flush(() =>
    (preview.button("Resume recording")!.props as { onPress: () => void }).onPress()
  );
  assert.match(preview.text(), /recording resumed, pending transcription cancelled/);
  assert.deepEqual(preview.calls.create, []);
});

test("live manual transcription controls stay disabled while recording or paused", async (t: TestContext) => {
  for (const capturePhase of ["recording", "paused"]) {
    const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z")], {
      initialCapturePhase: capturePhase,
    });

    const wholeMeeting = ui.button("Transcribe & Summary");
    assert.ok(wholeMeeting, `${capturePhase} keeps the whole-meeting control visible`);
    assert.equal(wholeMeeting.props?.isDisabled, true);
    await ui.flush(() => (wholeMeeting.props as { onPress: () => void }).onPress());

    const menu = ui.menu("Audio part actions");
    assert.ok(menu);
    const perPartAsr = findNode(ui.tree(), (node) => node.props?.id === "asr");
    assert.ok(perPartAsr);
    assert.equal(perPartAsr.props?.isDisabled, true);
    await ui.flush(() => (menu!.props as { onAction(key: string): void }).onAction("asr"));
    assert.deepEqual(
      ui.calls.create,
      [],
      `${capturePhase} cannot enqueue ASR through either control`
    );
  }
});

test("a newer group's gate blocks its ASR while an older completed group remains manually reprocessable", async (t: TestContext) => {
  const olderRun = completeRun();
  olderRun.run.sourceRecordingIds = [FIRST];
  const newerGateRun = completeRun();
  Object.assign(newerGateRun.run, {
    recordingId: SECOND,
    sourceRecordingIds: [SECOND],
    kind: "initial",
    stage: "prepare",
    status: "pending",
    retryAt: new Date(Date.now() + 15_000).toISOString(),
    retryCount: 0,
    errorCode: null,
    hasRawProviderResponse: false,
    hasTranscript: false,
    hasSummary: false,
  });
  newerGateRun.transcript = undefined;
  newerGateRun.summary = undefined;
  const olderPart = recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", olderRun);

  const newerPart = recording(
    SECOND,
    SECOND,
    new Date(Date.now() - 60_000).toISOString(),
    newerGateRun
  );

  newerPart.recording.endedAt = new Date().toISOString();
  const ui = await mountPanel(t, [olderPart, newerPart]);

  const wholeMeeting = ui.button("Transcribe");
  assert.ok(wholeMeeting, "the whole-meeting control stays visible in the audio view");
  assert.equal(
    wholeMeeting.props?.isDisabled,
    true,
    "whole-meeting reprocessing includes the gated current group"
  );
  await ui.flush(() => (wholeMeeting.props as { onPress: () => void }).onPress());
  assert.equal(
    ui.calls.create.length,
    0,
    "the whole-meeting handler cannot bypass the current group's gate"
  );

  const menus = findNodes(
    ui.tree(),
    (node) =>
      node.props?.["aria-label"] === "Audio part actions" &&
      typeof node.props?.onAction === "function"
  );

  assert.equal(menus.length, 2);
  const asrItems = menus.map((menu) => findNode(menu, (node) => node.props?.id === "asr"));
  assert.equal(asrItems[0]?.props?.isDisabled, true, "newest group remains gated");
  assert.equal(
    asrItems[1]?.props?.isDisabled,
    false,
    "older group is no longer blocked by the newer gate"
  );

  await ui.flush(() => (menus[0].props as { onAction(key: string): void }).onAction("asr"));
  assert.equal(ui.calls.create.length, 0);
  await ui.flush(() => (menus[1].props as { onAction(key: string): void }).onAction("asr"));
  assert.equal(ui.calls.create.at(-1)?.recordingId, FIRST);
  assert.deepEqual(ui.calls.create.at(-1)?.sourceRecordingIds, [FIRST]);
});

test("Results Summary action is unavailable during capture and resumes for the selected transcript afterward", async (t: TestContext) => {
  for (const capturePhase of ["preparing", "recording", "paused", "saving"]) {
    const olderRun = completeRun();
    olderRun.run.sourceRecordingIds = [FIRST];
    const olderPart = recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", olderRun);

    const ui = await mountPanel(t, [olderPart], {
      viewMode: "enhanced",
      initialCapturePhase: capturePhase,
    });

    const summaryAction = ui.button("meetingResults.newSummary");
    assert.ok(summaryAction, `${capturePhase} keeps the selected older transcript visible`);
    assert.equal(
      summaryAction.props?.isDisabled,
      true,
      `${capturePhase} cannot offer an actionable Summary request`
    );
    assert.equal(ui.calls.create.length, 0);

    await ui.setCapturePhase("idle");
    const eligibleAction = ui.button("meetingResults.newSummary");
    assert.ok(eligibleAction);
    assert.equal(
      eligibleAction.props?.isDisabled,
      false,
      "the action is available when capture no longer blocks it"
    );
    await ui.flush(() => (eligibleAction.props as { onPress: () => void }).onPress());
    assert.equal(ui.calls.create.at(-1)?.kind, "summary");
    assert.equal(
      ui.calls.create.at(-1)?.sourceRunId,
      RUN,
      "the action still targets the selected transcript run"
    );
  }
});

test("short live transcript keeps the owning toolbar action on the selected run Summary path", async (t: TestContext) => {
  const short = completeRun();
  short.run.status = "complete";
  short.run.stage = "summary";
  short.run.hasSummary = false;
  short.summary = undefined;
  short.transcript = {
    text: "Short transcript",
    segments: [{ start: 1, end: 2, speaker: "speaker-1", text: "Short transcript" }],
  };
  short.run.id = FOURTH;
  short.run.createdAt = "2026-09-25T10:03:00.000Z";
  short.run.config = {
    ...CONFIG,
    transcription: { ...CONFIG.transcription, provider: "deepgram", model: "nova-3" },
  };
  const previous = completeRun();
  previous.run.createdAt = "2026-09-25T10:02:00.000Z";
  const part = recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", short);
  part.runs = [previous, short];
  const ui = await mountPanel(t, [part], { viewMode: "raw" });
  assert.match(ui.text(), /Automatic Summary skipped/);
  assert.match(ui.text(), /180 seconds of recorded audio and 2,500 transcript characters/);
  assert.ok(
    ui.renderedButtonLabels().includes("Summary"),
    "the owning toolbar exposes manual Summary for a short ready transcript"
  );
  await ui.clickRenderedButtonExact("Summary");
  assert.equal(ui.calls.create.length, 1);
  assert.equal(ui.calls.create[0].kind, "summary");
  assert.equal(
    ui.calls.create[0].sourceRunId,
    FOURTH,
    "the toolbar uses the current selected transcript run"
  );
  assert.equal(ui.calls.create[0].recordingId, FIRST);
  const config = ui.calls.create[0].config as typeof CONFIG;
  assert.equal(
    config.transcription.provider,
    "deepgram",
    "the selected run supplies its transcript route snapshot"
  );
  assert.equal(config.summary.instruction, CONFIG.summary.instruction);
  assert.equal(config.summary.model, CONFIG.summary.model);
});

test("an empty saved transcript projection exposes no manual Summary action", async (t: TestContext) => {
  const empty = completeRun();
  empty.run.status = "complete";
  empty.run.stage = "summary";
  empty.run.hasSummary = false;
  empty.summary = undefined;
  empty.transcript = { text: "", segments: [] };

  const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", empty)], {
    viewMode: "raw",
  });

  assert.doesNotMatch(ui.text(), /Automatic Summary skipped|create a Summary manually now/i);
  assert.ok(
    !ui.renderedButtonLabels().includes("Summary"),
    "the main toolbar hides its Summary button for an empty saved transcript"
  );
  assert.ok(
    !ui.renderedButtonLabels().includes("meetingResults.newSummary"),
    "Results hides its manual Summary action for an empty transcript"
  );
});

test("invalid saved calendar participants show a specific live processing error", async (t: TestContext) => {
  const failed = completeRun();
  failed.run.status = "failed";
  failed.run.errorCode = "calendar-participants-invalid";
  failed.run.hasSummary = false;
  failed.summary = undefined;
  const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", failed)]);
  assert.match(ui.text(), /Stored calendar participant data is invalid/);
});

test("calendar participant naming error stays visible with the completed Summary", async (t: TestContext) => {
  const namedWithError = completeRun();
  namedWithError.run.speakerNamingErrorCode = "calendar-participants-invalid";

  const ui = await mountPanel(
    t,
    [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", namedWithError)],
    { viewMode: "enhanced" }
  );

  assert.match(ui.text(), /Stored calendar participant data is invalid/);
  assert.match(ui.text(), /Automatic speaker naming was skipped/);
  assert.match(ui.text(), /Release on Friday/);
});

test("a recognized speaker can be linked to an email-only calendar participant from the transcript", async (t: TestContext) => {
  const ui = await mountPanel(t, [
    recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", completeRun()),
  ]);

  await ui.showTranscriptTab();
  assert.match(ui.text(), /Remember these names for future meetings/);
  await ui.clickRenderedButton(["Alice · Link participant"]);

  const choice = findNode(
    ui.tree(),
    (node) => node.props?.label === "Remember name for calendar participant"
  );

  assert.ok(choice);
  const options = choice.props?.options as Array<{ id: string; label: string }>;
  assert.ok(options.some((option) => option.id === "person@example.com"));
  await ui.flush(() =>
    (choice.props as { onChange(value: string): void }).onChange("person@example.com")
  );
  await ui.saveSpeaker();
  assert.deepEqual(ui.calls.speaker, [
    {
      runId: RUN,
      speakerId: "speaker-1",
      displayName: "Alice",
      profileId: null,
      participantEmail: "person@example.com",
    },
  ]);
});

test("saved Summary separates transcription-only from Summary-only actions", async (t: TestContext) => {
  const ui = await mountPanel(t, [
    recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", completeRun()),
  ]);

  assert.equal(ui.button("Transcribe & Summary"), null);
  assert.ok(ui.button("Summary"));
  await ui.flush(() => (ui.button("Transcribe")!.props as { onPress: () => void }).onPress());
  assert.equal(ui.calls.create[0].kind, "reprocess");
  assert.equal((ui.calls.create[0].config as Record<string, unknown>).generateSummary, false);
  await ui.flush(() =>
    (
      findNode(ui.tree(), (node) => node.props?.ariaLabel === "Transcript and audio")!.props as {
        onChange: (tab: string) => void;
      }
    ).onChange("audio")
  );
  await ui.flush(() => (ui.button("Summary")!.props as { onPress: () => void }).onPress());
  assert.equal(ui.calls.create[1].kind, "summary");
  assert.equal(ui.calls.create[1].sourceRunId, RUN);
  assert.equal(ui.calls.create[1].sourceRecordingIds, undefined);
});

test("processing can be cancelled during the countdown and after ASR starts", async (t) => {
  for (const status of ["pending", "running"]) {
    const run = completeRun();
    run.run.status = status;
    run.run.stage = status === "pending" ? "prepare" : "asr";
    run.run.kind = "initial";
    run.run.retryAt = status === "pending" ? new Date(Date.now() + 15_000).toISOString() : null;
    run.run.retryCount = 0;
    run.run.errorCode = null;

    const panel = await mountPanel(t, [recording(FIRST, FIRST, new Date().toISOString(), run)], {
      viewMode: "enhanced",
    });

    const cancel = panel.button("Cancel processing");
    assert.ok(cancel, status);
    assert.equal(cancel.props?.isDisabled, false);
    await panel.flush(() => (cancel.props as { onPress: () => void }).onPress());
    assert.deepEqual(panel.calls.cancel, [run.run.id]);
    assert.match(panel.text(), /Processing cancelled/);
    assert.doesNotMatch(panel.text(), /Transcription starts in/);
    assert.equal(
      panel.label("Play audio")?.props?.isDisabled,
      false,
      "saved audio remains available"
    );
    assert.match(panel.text(), /Release on Friday/, "existing summary remains available");
  }
});

for (const viewMode of ["raw", "enhanced"] as const) {
  for (const platform of ["zoom", "google-meet"] as const) {
    test(`${platform} ${viewMode} suggestion shows its source and manual rename removes the badge`, async (t: TestContext) => {
      const run = completeRun();
      run.speakerCorrections = [
        {
          speakerId: "speaker-1",
          profileId: null,
          displayName: "Alice",
          source: "platform",
          platform,
          revision: 1,
        },
      ];

      const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", run)], {
        viewMode,
      });

      await ui.showTranscriptTab();
      const label = platform === "google-meet" ? "Google Meet" : "Zoom";
      assert.match(ui.text(), new RegExp(label));
      await ui.clickSpeaker("Alice");
      await ui.changeSpeakerName("Chosen name");
      await ui.saveSpeaker();
      assert.match(ui.text(), /Chosen name/);
      assert.doesNotMatch(ui.text(), new RegExp(label));
      assert.equal(ui.calls.speaker.length, 1);
    });
  }
}

for (const taskStatus of [undefined, "pending", "running", "complete", "provider-error"] as const) {
  test(`opening and reopening Summary with task status ${taskStatus} never schedules tasks`, async (t) => {
    const run = completeRun();
    run.summary = {
      text: "## Summary\nSaved result.\n\n## Action Items\n- Ship release",
      taskStatus,
    };

    for (const opening of ["open", "reopen"]) {
      await t.test(opening, async (mounted) => {
        const ui = await mountPanel(
          mounted,
          [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", run)],
          { viewMode: "enhanced" }
        );

        await ui.flush(() => {});
        assert.deepEqual(ui.calls.summaryActions, []);
        assert.match(ui.text(), /Saved result/);

        if (taskStatus === "pending" || taskStatus === "running") {
          assert.match(ui.text(), /Prioritizing action items/);
          assert.doesNotMatch(ui.text(), /Couldn't extract action items/);
        }
      });
    }
  });
}

test("calendar participant failure shows one toast without restarting the request", async (t: TestContext) => {
  const ui = await mountPanel(t, [], { failParticipants: true });
  await ui.flush(() => {});
  assert.equal(ui.participantLoads(), 1);
  assert.deepEqual(ui.notifications, ["Could not load calendar participants."]);
  await ui.setCapturePhase("recording");
  assert.equal(ui.participantLoads(), 1);
  assert.equal(ui.notifications.length, 1);
});

for (const [code, description] of [
  ["audio-preparation-disk-full", "Your audio is saved. Free disk space before retrying audio preparation."],
  ["audio-preparation-failed", "Your audio is saved. Check local storage and retry. If audio preparation still fails, reinstall Gristmill."],
] as const) {
  test(`persisted ${code} reaches the existing processing notice`, async (t: TestContext) => {
    const { createDb } = require("../helpers/harness/db.ts") as typeof import("../helpers/harness/db.ts");
    const { getUserDataDir } = require("../helpers/harness/electronStub.ts") as typeof import("../helpers/harness/electronStub.ts");
    const { MeetingRecordingStorage } = require("../../src/helpers/meetingRecordingStorage.ts") as typeof import("../../src/helpers/meetingRecordingStorage.ts");
    const { MeetingProcessingWorker } = require("../../src/helpers/meetingProcessing.ts") as typeof import("../../src/helpers/meetingProcessing.ts");
    const { savePcmEpoch } = require("../lib/meetingAudioFixture.ts") as typeof import("../lib/meetingAudioFixture.ts");
    const db = createDb(t); assert.ok(db);
    const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
    const note = db.saveNote("Synthetic preparation failure", "", "meeting").note!;
    const capture = db.createMeetingRecording(note.id, { config: CONFIG });
    for (const source of ["mic", "system"] as const) {
      db.createMeetingRecordingEpoch(capture.id, source, 0, 1, 0, 0);
      savePcmEpoch(storage, capture.id, source, 0, Buffer.alloc(4800));
      db.updateMeetingRecordingEpochRecovery(capture.id, source, 0, storage.recoverEpoch(capture.id, source, 0));
    }
    db.markMeetingRecordingFinalizing(capture.id);
    const { initialRun } = db.finalizeMeetingRecording(capture.id, { captureState: "ready", endedAt: new Date(Date.parse(capture.startedAt) + 1000).toISOString() });
    db.setMeetingProcessingRunState(initialRun.id, { stage: "prepare", status: "pending", retryAt: null });
    const worker = new MeetingProcessingWorker({ database: db, storage, isCaptureActive: () => false,
      getCredential: () => "synthetic-key", summarize: async () => "unused",
      transcribeRemote: async () => { throw new Error("provider must not be called"); },
      transcribeLocal: async () => { throw new Error("local transcription must not be called"); },
      diarizeLocal: async () => [],
      mixAudio: async () => { throw Object.assign(new Error("Local preparation failed"), { code }); },
    });
    t.after(() => worker.stop());
    worker.onRetentionReady(); await worker.waitForIdle();
    const saved = db.getMeetingProcessingRun(initialRun.id)!;
    assert.equal(saved.status, "failed"); assert.equal(saved.errorCode, code); assert.equal(saved.retryAt, null);
    const failed = completeRun();
    Object.assign(failed.run, { stage: saved.stage, status: saved.status, errorCode: saved.errorCode, hasRawProviderResponse: false, hasTranscript: false, hasSummary: false });
    failed.transcript = undefined; failed.summary = undefined;
    const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", failed)]);
    assert.ok(ui.text().includes(description));
    assert.ok(ui.button("meetingResults.retry"));
    assert.deepEqual(ui.calls.retry, []);
  });
}

test("a recording with every part omitted explains that audio is saved and offers Retry", async (t: TestContext) => {
  const failed = completeRun();
  failed.run.status = "failed";
  failed.run.stage = "prepare";
  failed.run.errorCode = "audio-alignment-unavailable";
  failed.run.omittedRecordingIds = [FIRST];
  failed.run.sourceRecordingIds = [FIRST];
  failed.run.hasRawProviderResponse = false;
  failed.run.hasTranscript = false;
  failed.run.hasSummary = false;
  failed.transcript = undefined;
  failed.summary = undefined;
  const part = recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", failed);
  const ui = await mountPanel(t, [part]);
  assert.match(ui.text(), /Could not prepare the recording/);
  assert.match(ui.text(), /could not be prepared for transcription/);
  assert.doesNotMatch(ui.text(), /connection|API key|waiting for settings/);
  assert.deepEqual(ui.calls.retry, [], "opening an old error must not send audio");
  const retry = ui.button("meetingResults.retry");
  assert.ok(retry, "a later app version can prepare the omitted part");
  await ui.flush(() => (retry.props as { onPress(): void }).onPress());
  assert.deepEqual(ui.calls.retry, [RUN]);
  assert.equal(ui.button("Review audio parts"), null);
  assert.deepEqual(ui.calls.delete, []);
});

for (const errorCode of [
  "audio-alignment-unavailable",
  "capture-write-failed",
  "mic-source-unavailable",
]) {
  test(`an unprepared saved recording offers one explicit recovery action for ${errorCode}`, async (t: TestContext) => {
    const failed = completeRun();
    Object.assign(failed.run, {
      sourceRecordingIds: [FIRST],
      omittedRecordingIds: [],
      status: "failed",
      stage: "prepare",
      errorCode,
      hasRawProviderResponse: false,
      hasTranscript: false,
      hasSummary: false,
    });
    failed.transcript = undefined;
    failed.summary = undefined;
    const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", failed)]);
    assert.deepEqual(ui.calls.retry, [], "opening an old error must not send audio");
    const retry = ui.button("meetingResults.retry");
    assert.ok(retry);
    await ui.flush(() => (retry.props as { onPress(): void }).onPress());
    assert.deepEqual(ui.calls.retry, [RUN]);
    assert.deepEqual(ui.calls.delete, []);
    assert.equal(ui.button("Review audio parts"), null);
  });
}

test("a capture write failure does not ask the user to change provider settings", async (t: TestContext) => {
  const failed = completeRun();
  failed.run.status = "blocked";
  failed.run.stage = "prepare";
  failed.run.errorCode = "capture-write-failed";
  const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", failed, "incomplete")]);
  assert.match(ui.text(), /Recording was interrupted/);
  assert.doesNotMatch(ui.text(), /connection|API key|meetingResults.blocked.other/);
});







for (const scenario of ["recording", "finalizing", "unavailable", "legacy", "omitted"] as const) {
  test(`partial-result notice distinguishes ${scenario} from an explicit omission`, async (t: TestContext) => {
    const run = completeRun();
    run.run.sourceRecordingIds = [FIRST];
    run.run.hasExplicitAudioParts = scenario !== "legacy";
    const other = recording(SECOND, SECOND, "2026-09-25T11:00:00.000Z", null,
      scenario === "recording" || scenario === "finalizing" ? scenario : "ready");
    if (scenario === "unavailable") other.recording.captureErrorCode = "recording-audio-unavailable";
    const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", run), other]);
    if (scenario === "omitted") assert.match(ui.text(), /meetingResults.partialAudioResult/);
    else assert.doesNotMatch(ui.text(), /meetingResults.partialAudioResult/);
  });
}



test("automatic recovery shows the available result without exclusion or retry controls", async (t: TestContext) => {
  const ready = completeRun();
  ready.run.omittedRecordingIds = [SECOND];
  const ui = await mountPanel(t, [
    recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", ready),
    recording(SECOND, FIRST, "2026-09-25T10:00:01.000Z", null, "incomplete"),
  ]);
  assert.match(ui.text(), /meetingResults.partialAudioResult/);
  assert.match(ui.text(), /meetingResults.omittedPart/);
  assert.doesNotMatch(ui.text(), /meetingResults.excludePart|meetingResults.includePart|Review audio parts|Audio timing/);
  assert.equal(ui.button("meetingResults.retry"), null);
  assert.deepEqual(ui.calls.create, [], "opening the result does not require another processing click");
  assert.deepEqual(ui.calls.delete, []);
});

for (const hasTranscript of [false, true]) {
  test(`audio indicator shows a dot only before a transcript exists (${hasTranscript})`, async (t: TestContext) => {
    const ui = await mountPanel(
      t,
      [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", hasTranscript ? completeRun() : null)],
      {
        noteTranscript: {
          note_id: 1,
          status: hasTranscript ? "ready" : "pending",
          text: "",
          segments: null,
          speakers: [],
          timeline: {
            unit: "ms",
            duration_ms: null,
            basis: "concatenated_recording_time",
            intentional_pauses: "excluded",
          },
          diagnostics: [],
        },
      }
    );
    const dot = findNode(ui.tree(), (node) => node.props?.["data-testid"] === "pending-transcript-dot");
    assert.equal(Boolean(dot), !hasTranscript);
    assert.ok(ui.label("Transcript and audio"));
  });
}


test("blocked settings retry awaits the current processing snapshot before updating the run", async (t: TestContext) => {
  const blocked = completeRun();
  Object.assign(blocked.run, {
    status: "blocked",
    stage: "prepare",
    config: null,
    configError: { code: "detailed-notes-action-missing" },
    errorCode: "detailed-notes-action-missing",
  });
  const ui = await mountPanel(t, [recording(FIRST, FIRST, "2026-09-25T10:00:00.000Z", blocked)]);
  const retry = ui.button("meetingResults.updateRunSettings");
  assert.ok(retry);
  await ui.flush(() => (retry.props as { onPress(): void }).onPress());
  assert.equal(ui.calls.update.length, 1);
  assert.deepEqual(ui.calls.update[0], { runId: RUN, config: CONFIG, configError: null });
});
