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
      onNoteUpdated: () => () => {},
      onNoteDeleted: () => () => {},
      onFolderDeleted: () => () => {},
    },
  } });
  const container = installHookDom(t);
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

  return {
    openNote: async (id: number) => {
      await React.act(async () => { store.setActiveNoteId(id); });
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
  assert.equal(calls[0].updates.title, "Processing title", "the stored title is not wiped to an empty string");
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
