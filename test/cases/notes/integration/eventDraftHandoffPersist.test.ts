// Issue #156 fix round: the event-draft handoff is applied by
// PersonalNotesView through the real debounced pending-save pipeline. The
// merge base must be the note's stored row — never a fabricated empty draft,
// which would wipe a processing-generated title and the note's manual text
// (R156-1). Both the in-store and not-yet-cached paths are driven, asserting
// the persisted updateNote payload (R156-2).
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test") = require("node:test");
const path = require("node:path");
const React = require("react") as typeof import("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals, installHookDom }: typeof import("../../../lib/rendererTestHarness.ts") = require("../../../lib/rendererTestHarness.ts");
import type { NoteItem } from "../../../../src/contracts/notes";
import type { EventDraftHandoff } from "../../../../src/lib/noteEditorPendingSave";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function noteFixture(id: number, title: string, content: string): NoteItem {
  return {
    id, title, content, note_type: "meeting", space_id: 1,
    folder_id: null, folder_ids: [], source_file: null,
    audio_duration_seconds: null, created_at: "2026-10-02", updated_at: "2026-10-02",
    enhanced_content: null, enhancement_prompt: null, enhanced_at_content_hash: null,
    transcript: null, calendar_event_id: "evt-1", participants: null,
    diarization_enabled: null, expected_speaker_count: null,
  };
}

interface Harness {
  openNote(id: number): Promise<void>;
  typeContent(value: string): Promise<void>;
  fireExternalUpdate(note: NoteItem): Promise<void>;
  editorState(): { id: number; title: string; content: string } | null;
  updateNoteCalls(): Array<{ id: number; updates: Record<string, unknown> }>;
}

async function mountNotesView(
  t: import("node:test").TestContext,
  rows: NoteItem[],
  getNote: (id: number) => Promise<NoteItem | null>,
  pendingHandoff: EventDraftHandoff | null
): Promise<Harness> {
  let root: ReturnType<typeof createRoot> | null = null;
  t.after(async () => { if (root) await React.act(async () => root.unmount()); });
  installBrowserGlobals(t, { initialStorage: { notesOnboardingComplete: "true" }, window: {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
    electronAPI: {
      getSpaces: async () => [{ id: 1, name: "Personal", kind: "private" }],
      getFolders: async () => [],
      getFolderNoteCounts: async () => [],
      getNotes: async () => rows,
      getNote: (id: number) => getNote(id),
      updateNote: async (id: number, updates: Record<string, unknown>) => {
        updateCalls.push({ id, updates });
        return { success: true, note: noteFixture(id, String(updates.title ?? ""), String(updates.content ?? "")) };
      },
      gcalGetEvent: async () => null,
      onNoteAdded: () => () => {},
      onNoteUpdated: (listener: (note: NoteItem) => void) => {
        noteUpdatedListener = listener;
        return () => { noteUpdatedListener = undefined; };
      },
      onNoteDeleted: () => () => {},
      onFolderDeleted: () => () => {},
    },
  } });
  const container = installHookDom(t);
  let noteUpdatedListener: ((note: NoteItem) => void) | undefined;
  const updateCalls: Array<{ id: number; updates: Record<string, unknown> }> = [];
  const mockModules: Record<string, string> = {
    "react-i18next": `
      const t = (key) => key;
      export const initReactI18next = { type: "3rdParty", init() {} };
      export function useTranslation() { return { t }; }
    `,
    // Recording and chat are out of scope here; only the document pipeline runs.
    "/stores/meetingRecordingStore": `
      const state = { isRecording: false, recordingNoteId: null, recordingFolderId: null };
      export function useMeetingRecordingStore(selector) { return selector(state); }
      useMeetingRecordingStore.getState = () => state;
      export function useIsMeetingMode() { return false; }
      export async function startRecording() { return true; }
      export async function resumeMeeting() { return true; }
      export async function pauseMeeting() {}
      export async function finishMeeting() {}
      export function lockSpeaker() {}
      export function setSessionDiarizationEnabled() {}
      export function setSessionExpectedCount() {}
    `,
    "/hooks/useNotesTreeActions": `export function useNotesTreeActions() { return { startRecordingForNote: async () => {}, handleNewNoteIn: async () => {}, handleNewNote: async () => {}, handleNotesAdded: () => {}, handleMoveNote: () => {}, handleSetNoteFolders: () => {}, handleCreateFolderAndAdd: () => {} }; }`,
    "./AddNotesToFolderDialog": `export default function Empty() { return null; }`,
    "./NotesOnboarding": `export default function Empty() { return null; }`,
    "./NoteSkeleton": `export default function Empty() { return null; }`,
    "./NoteEditor": `
      export let props;
      export default function NoteEditor(next) { props = next; return null; }
    `,
    "/ui/useToast": `export function useToast() { return { toast() {} }; }`,
    "/stores/actionStore": `export async function initializeActions() {}`,
  };
  const vite = await createRendererServer(t, {
    mockModules,
    noExternal: ["react-i18next"],
    resolveAlias: { "@": path.resolve(__dirname, "../../../src") },
  });
  const { default: PersonalNotesView } = await vite.ssrLoadModule("/components/notes/PersonalNotesView.tsx");
  const noteEditorModule = await vite.ssrLoadModule("./NoteEditor") as {
    props: {
      note: { id: number; title: string; content: string };
      onContentChange: (id: number, value: string) => void;
      onTitleChange: (id: number, value: string) => void;
    } | undefined;
  };
  const store = await vite.ssrLoadModule("/stores/noteStore.ts") as typeof import("../../../../src/stores/noteStore");
  await React.act(async () => { await store.initializeNotesTree(); });

  let handoffRef: { current: EventDraftHandoff | null } | undefined;
  root = createRoot(container as unknown as Element);
  await React.act(async () => {
    handoffRef = { current: pendingHandoff };
    root!.render(React.createElement(PersonalNotesView, {
      onOpenSettings: () => {},
      chromeProvidesBack: false,
      eventDraftHandoff: handoffRef,
    }));
  });

  let openedNoteId: number | null = null;
  return {
    openNote: async (id: number) => {
      openedNoteId = id;
      await React.act(async () => { store.setActiveNoteId(id); });
    },
    /** Drives the mounted editor's real onContentChange for the open note. */
    typeContent: async (value: string) => {
      const id = openedNoteId;
      assert.ok(id, "typeContent requires an open note");
      await React.act(async () => { noteEditorModule.props?.onContentChange(id, value); });
    },
    fireExternalUpdate: async (note: NoteItem) => {
      await React.act(async () => { noteUpdatedListener?.(note); });
    },
    editorState: () => {
      const props = noteEditorModule.props;
      return props ? { id: props.note.id, title: props.note.title, content: props.note.content } : null;
    },
    updateNoteCalls: () => updateCalls,
  };
}

test("a handoff for a not-yet-cached note keeps the stored title and appends without clobbering", async (t) => {
  const stored = noteFixture(7, "Processing title", "Manual content");
  const rows: NoteItem[] = [];
  const harness = await mountNotesView(
    t,
    rows,
    async (id) => (id === 7 ? stored : null),
    { noteId: 7, mode: "append", draft: { content: "typed during materialization" } }
  );

  await harness.openNote(7);
  await wait(1100);

  const calls = harness.updateNoteCalls();
  assert.equal(calls.length, 1, "the handoff is persisted through the debounced save");
  assert.equal(calls[0].id, 7);
  assert.equal(
    calls[0].updates.title,
    undefined,
    "the title was never dirty: the write must not touch it at all"
  );
  assert.equal(calls[0].updates.content, "Manual content\n\ntyped during materialization", "manual text survives the append");
});

test("a handoff for a fresh note replaces the snapshot fields", async (t) => {
  const stored = noteFixture(8, "Design review", "early snapshot");
  const harness = await mountNotesView(
    t,
    [stored],
    async (id) => (id === 8 ? stored : null),
    { noteId: 8, mode: "replace", draft: { title: "Typed title", content: "early snapshot plus ABC" } }
  );

  await harness.openNote(8);
  await wait(1100);

  const calls = harness.updateNoteCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].updates.title, "Typed title");
  assert.equal(calls[0].updates.content, "early snapshot plus ABC");
});

test("a content-only edit's debounced write does not republish the title over an external update", async (t) => {
  const stored = noteFixture(9, "Original title", "Original body");
  const harness = await mountNotesView(t, [stored], async (id) => (id === 9 ? stored : null), null);

  await harness.openNote(9);
  // The user edits content only.
  await harness.typeContent("Typed body");
  // While the debounce runs, processing publishes a new title.
  stored.title = "Generated title";
  await harness.fireExternalUpdate(stored);
  await wait(1100);

  const calls = harness.updateNoteCalls();
  assert.equal(calls.length, 1, "the debounce fires once");
  assert.equal(calls[0].updates.title, undefined, "the externally-generated title is not overwritten");
  assert.equal(calls[0].updates.content, "Typed body");
});

test("an external update lands even while a save is queued", async (t) => {
  const stored = noteFixture(10, "Original title", "Original body");
  const harness = await mountNotesView(t, [stored], async (id) => (id === 10 ? stored : null), null);

  await harness.openNote(10);
  await harness.typeContent("Typed body");

  // Processing publishes a new title while the debounce is still queued.
  // A fresh object, as the real IPC payload would be (the store row must get
  // a new identity for the update effect to run).
  await harness.fireExternalUpdate(noteFixture(10, "Generated title", "Original body"));
  // Let React flush passive effects (the merge).
  await wait(0);
  await wait(0);

  // Editor state right after the external update: the untouched title shows
  // the external value, the typed content keeps the local value.
  assert.deepEqual(harness.editorState(), {
    id: 10,
    title: "Generated title",
    content: "Typed body",
  });

  const calls = harness.updateNoteCalls();
  await wait(1100);
  assert.equal(calls.length, 1, "only the dirty field is written");
  assert.equal(calls[0].updates.title, undefined, "the externally-generated title is not overwritten");
  assert.equal(calls[0].updates.content, "Typed body");
});
