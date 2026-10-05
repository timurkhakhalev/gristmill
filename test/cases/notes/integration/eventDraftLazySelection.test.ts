import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { createRoot } from "react-dom/client";
import { createRendererServer, installBrowserGlobals, installHookDom } from "../../../lib/rendererTestHarness.ts";
import type { NoteItem } from "../../../../src/contracts/notes";

const note = (id: number, content: string): NoteItem => ({ id, title: `Note ${id}`, content,
  note_type: "meeting", space_id: 1, folder_id: null, folder_ids: [], source_file: null,
  audio_duration_seconds: null, created_at: "2026-10-05", updated_at: "2026-10-05",
  enhanced_content: null, enhancement_prompt: null, enhanced_at_content_hash: null,
  transcript: null, calendar_event_id: null, participants: null, diarization_enabled: null, expected_speaker_count: null });
const tick = () => new Promise<void>(done => setImmediate(done));

test("real event materialization survives cache eviction and B selection before lazy editor mount", async t => {
  let root: ReturnType<typeof createRoot> | undefined;
  t.after(async () => { if (root) await React.act(async () => root!.unmount()); });
  const a = note(1, "A"), b = note(2, "B");
  let added: (row: NoteItem) => void = () => {};
  let releaseCreate!: () => void, releaseView!: () => void, releaseLateRead!: (row: NoteItem) => void;
  const creating = new Promise<void>(done => { releaseCreate = done; });
  const loading = new Promise<void>(done => { releaseView = done; });
  const lateRead = new Promise<NoteItem>(done => { releaseLateRead = done; });
  let readsA = 0;
  installBrowserGlobals(t, { initialStorage: { notesOnboardingComplete: "true" }, window: {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    electronAPI: {
      getSpaces: async () => [{ id: 1, name: "Personal", kind: "private" }],
      getFolders: async () => [], getFolderNoteCounts: async () => [], getNotes: async () => [b],
      findCalendarEventNote: async () => null,
      createCalendarEventNote: async () => { await creating; added(a); return { noteId: a.id, folderId: null, existing: false }; },
      getNote: async (id: number) => id === a.id ? ++readsA === 1 ? a : lateRead : b,
      updateNote: async (id: number, updates: object) => {
        const row = id === a.id ? a : b; Object.assign(row, updates); return { success: true, note: { ...row } };
      },
      onNoteAdded: (listener: typeof added) => { added = listener; return () => {}; },
      onNoteUpdated: () => () => {}, onNoteDeleted: () => () => {}, onFolderDeleted: () => () => {},
      gcalGetEvent: async () => null,
    },
  } });
  const container = installHookDom(t);
  const ui: any = { ready: false, loading };
  (globalThis as any).__lazyDraftUi = ui;
  t.after(() => { releaseCreate(); releaseView(); releaseLateRead(a); delete (globalThis as any).__lazyDraftUi; });
  const empty = "export default function Empty(){return null;}";
  const mocks: Record<string, string> = {
    "react-i18next": 'export const initReactI18next={type:"3rdParty",init(){}};const t=key=>key;export function useTranslation(){return {t,i18n:{resolvedLanguage:"en"}};}',
    "/ui/useToast": "export function useToast(){return {toast(){}};}",
    "/stores/actionStore": "export async function initializeActions(){}",
    "/controlPanelNav": "export function useControlPanelNavItems(){return [];}",
    "/hooks/useNotesTreeActions": "export function useNotesTreeActions(){return {handleNewNote(){},startRecordingForNote(){}};}",
    "/stores/meetingRecordingStore": 'const state={isRecording:false,recordingNoteId:null};export function useMeetingRecordingStore(selector){return selector(state)};useMeetingRecordingStore.getState=()=>state;export function useIsMeetingMode(){return false}export function startRecording(){}export function resumeMeeting(){}export function pauseMeeting(){}export function finishMeeting(){}export function lockSpeaker(){}export function setSessionDiarizationEnabled(){}export function setSessionExpectedCount(){}',
    "/home/HomeView": "export default function Home(props){globalThis.__lazyDraftUi.home=props;return null;}",
    "/ui/RichTextEditor": "export function RichTextEditor(props){globalThis.__lazyDraftUi.input=props;return null;}",
    "./NoteEditor": "export default function Editor(props){globalThis.__lazyDraftUi.editor=props;return null;}",
    "/notes/PersonalNotesView": 'import React from "react";export default function Delayed(props){const ui=globalThis.__lazyDraftUi;if(!ui.ready)throw ui.loading;return React.createElement(ui.Real,props)}',
    "/ui/dialog": "const empty=()=>null;export {empty as Dialog,empty as DialogContent,empty as DialogFooter,empty as DialogHeader,empty as DialogTitle};",
    "/home/HomeSkeleton": "export function HomeSkeleton(){return null;}",
  };
  for (const leaf of ["ControlPanelSidebar", "ControlPanelTopBar", "ControlPanelNavDrawer", "MeetingRecordingMount",
    "notes/MeetingRecordingPill", "notes/BackgroundActionToastListener", "SettingsModal", "notes/UploadAudioView",
    "CommandSearch", "KeyboardShortcutsDialog", "notes/NotesDebugPreview", "notes/NoteSkeleton",
    "notes/NoteParticipants", "notes/NoteRecordControl", "notes/NoteBottomBar", "notes/AddNotesToFolderDialog", "notes/NotesOnboarding"])
    mocks[`/${leaf}`] = empty;
  mocks["./NoteParticipants"] = empty;
  mocks["./NoteRecordControl"] = empty;
  mocks["./NoteBottomBar"] = empty;
  mocks["./AddNotesToFolderDialog"] = empty;
  mocks["./NotesOnboarding"] = empty;
  mocks["./NoteSkeleton"] = empty;
  const vite = await createRendererServer(t, { mockModules: mocks, noExternal: ["react-i18next"] });
  ui.Real = (await vite.ssrLoadModule("/components/notes/PersonalNotesView.tsx")).default;
  const ControlPanel = (await vite.ssrLoadModule("/components/ControlPanel.tsx")).default;
  const ready = async (check: () => boolean) => {
    for (let attempt = 0; attempt < 1000 && !check(); attempt++) await React.act(async () => { await tick(); });
    assert.ok(check(), "lazy component reached its expected state");
  };
  const store = await vite.ssrLoadModule("/stores/noteStore.ts") as typeof import("../../../../src/stores/noteStore");
  root = createRoot(container as unknown as Element);
  await React.act(async () => { root!.render(React.createElement(ControlPanel)); await tick(); });
  await ready(() => !!ui.home);
  await React.act(async () => { ui.home.onOpenEvent({ id: "event", summary: "Meeting", start_time: new Date().toISOString() }); await tick(); });
  await ready(() => !!ui.input);
  await React.act(async () => { ui.input.onChange("A"); await tick(); });
  await React.act(async () => { ui.input.onChange("A latest"); releaseCreate(); await tick(); });
  await ready(() => store.getActiveNoteIdValue() === a.id);
  assert.equal(store.getActiveNoteIdValue(), a.id, "real materialization selected its full row");
  assert.equal(ui.editor, undefined, "lazy Note view has not mounted");
  await React.act(async () => {
    // Normal note-added events (e.g. a concurrent import/BB writer) evict A
    // from the newest-50 container cache while its selected row remains held.
    for (let id = 100; id < 151; id++) added(note(id, "imported"));
    await store.openNoteRow(b);
  });
  assert.equal(store.getNoteFromStore(a.id), null, "A is genuinely uncached after B navigation");
  await React.act(async () => { ui.ready = true; releaseView(); await tick(); });
  await ready(() => !!ui.editor);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await React.act(async () => { ui.editor.onContentChange(b.id, "B latest"); releaseLateRead(a); await tick(); });
  await React.act(async () => { t.mock.timers.tick(1000); });
  assert.equal(ui.editor.note.id, b.id);
  assert.equal(ui.editor.note.content, "B latest");
  assert.equal(a.content, "A latest");
  assert.equal(b.content, "B latest");
  assert.equal(readsA, 1, "handoff never starts another uncached getNote");
});
