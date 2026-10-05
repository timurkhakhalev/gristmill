const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const test: typeof import("node:test") = require("node:test");

const React = require("react") as typeof import("react");

const { createRoot } = require("react-dom/client");

const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
}: typeof import("../../../lib/rendererTestHarness.ts") = require("../../../lib/rendererTestHarness.ts");

import type { NoteItem, NoteMutationResult } from "../../../../src/contracts/notes";

test("New note opens the saved note from Home and Upload only after creation succeeds", async (t) => {
  let root: ReturnType<typeof createRoot> | null = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  let resolveSave: (result: NoteMutationResult) => void = () => {};

  let trayNewNote: (() => void) | undefined;
  const keyListeners = new Set<(event: unknown) => void>();

  const note: NoteItem = {
    id: 42,
    title: "New note",
    content: "",
    note_type: "personal",
    space_id: 1,
    folder_id: null,
    folder_ids: [],
    source_file: null,
    audio_duration_seconds: null,
    created_at: "2026-10-02",
    updated_at: "2026-10-02",
    enhanced_content: null,
    enhancement_prompt: null,
    enhanced_at_content_hash: null,
    transcript: null,
    calendar_event_id: null,
    participants: null,
    diarization_enabled: null,
    expected_speaker_count: null,
  };

  const savedNotes: NoteItem[] = [];
  installBrowserGlobals(t, {
    window: {
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      addEventListener: (name: string, listener: (event: unknown) => void) => {
        if (name === "keydown") keyListeners.add(listener);
      },
      removeEventListener: (name: string, listener: (event: unknown) => void) => {
        if (name === "keydown") keyListeners.delete(listener);
      },
      electronAPI: {
        getSpaces: async () => [{ id: 1, name: "Personal", kind: "private" }],
        getFolders: async () => [],
        getFolderNoteCounts: async () => [],
        getNotes: async () => [...savedNotes],
        saveNote: () =>
          new Promise<NoteMutationResult>((resolve) => {
            resolveSave = resolve;
          }),
        onTrayNewNote: (listener: () => void) => {
          trayNewNote = listener;

          return () => {
            trayNewNote = undefined;
          };
        },
      },
    },
  });
  const container = installHookDom(t);

  const mockModules: Record<string, string> = {
    "react-i18next": `
      const t = (key) => key;
      export const initReactI18next = { type: "3rdParty", init() {} };
      export function useTranslation() { return { t }; }
    `,
    "/ui/useToast": `export function useToast() { return { toast() {} }; }`,
    "/stores/actionStore": `export async function initializeActions() {}`,
    "/stores/meetingRecordingStore": `
      const state = { isRecording: true, recordingNoteId: null, recordingFolderId: null };
      export function useMeetingRecordingStore(selector) { return selector(state); }
      useMeetingRecordingStore.getState = () => state;
      export function useIsMeetingMode() { return false; }
      export async function startRecording() {}
      export async function resumeMeeting() {}
    `,
    "/stores/settingsStore": `export const useSettingsStore = { getState: () => ({}) };`,
    "/controlPanelNav": `export function useControlPanelNavItems() { return []; }`,
    "/ControlPanelTopBar": `
      export let props;
      export default function TopBar(next) { props = next; return null; }
    `,
    "/ControlPanelSidebar": `
      export let props;
      export default function Sidebar(next) { props = next; return null; }
    `,
    "/ui/dialog": `
      const empty = () => null;
      export { empty as Dialog, empty as DialogContent, empty as DialogFooter,
        empty as DialogHeader, empty as DialogTitle };
    `,
    "/ui/input": `export const Input = () => null;`,
    "/ui/button": `export const Button = () => null;`,
    "/home/HomeSkeleton": `export const HomeSkeleton = () => null;`,
  };

  for (const component of [
    "ControlPanelNavDrawer",
    "MeetingRecordingMount",
    "notes/MeetingRecordingPill",
    "notes/EventNoteDraft",
    "notes/BackgroundActionToastListener",
    "SettingsModal",
    "home/HomeView",
    "notes/PersonalNotesView",
    "notes/UploadAudioView",
    "CommandSearch",
    "KeyboardShortcutsDialog",
    "notes/NotesDebugPreview",
    "notes/NoteSkeleton",
  ])
    mockModules[`/${component}`] = "export default function Empty() { return null; }";

  const vite = await createRendererServer(t, { mockModules, noExternal: ["react-i18next"] });
  const { default: ControlPanel } = await vite.ssrLoadModule("/components/ControlPanel.tsx");
  const topBar = await vite.ssrLoadModule("/components/ControlPanelTopBar");
  const sidebar = await vite.ssrLoadModule("/components/ControlPanelSidebar");

  const store = (await vite.ssrLoadModule(
    "/stores/noteStore.ts"
  )) as typeof import("../../../../src/stores/noteStore");

  root = createRoot(container as unknown as Element);
  await React.act(async () => {
    root.render(React.createElement(ControlPanel));
  });

  const goHome = async () => {
    await React.act(async () => {
      store.setActiveNoteId(null);
      sidebar.props.onViewChange("home");
    });
    assert.equal(topBar.props.showNotesDebug, false);
  };

  const create = async (trigger: () => void, id: number) => {
    await React.act(async () => {
      trigger();
    });
    assert.equal(
      topBar.props.showNotesDebug,
      false,
      "the previous view remains while save is pending"
    );
    const created = { ...note, id };
    savedNotes.push(created);
    await React.act(async () => {
      store.addNote(created);
      resolveSave({ success: true, note: created });
    });
    assert.equal(store.getActiveNoteIdValue(), id);
    assert.equal(topBar.props.showNotesDebug, true, "the saved note view opens");
  };

  await create(() => topBar.props.onNewNote(), 42);
  await goHome();
  await create(() => trayNewNote!(), 43);
  await goHome();
  await create(() => {
    for (const listener of keyListeners)
      listener({
        key: "n",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        preventDefault() {},
      });
  }, 44);
  await React.act(async () => {
    sidebar.props.onViewChange("upload");
  });
  await create(() => topBar.props.onNewNote(), 45);

  await goHome();
  await React.act(async () => {
    topBar.props.onNewNote();
  });
  await React.act(async () => {
    resolveSave({ success: false, error: "save failed" });
  });
  assert.equal(store.getActiveNoteIdValue(), null);
  assert.equal(topBar.props.showNotesDebug, false, "failed creation keeps Home open");
});
