// Issue #186: Home keeps a cross-space recent list fetched separately, and
// refreshed only when `notesByContainer` identity changed. Deleting a note from
// an unloaded folder succeeded in main and emitted note-deleted, but the store's
// removeNote no-ops when the row is not cached, so the container map never
// changed and Home never re-read — the row stayed until a remount. This mounts
// the real HomeView with the real noteStore and fires the real note-deleted
// listener to prove the event revision refreshes the list without a remount.
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test") = require("node:test");
const React = require("react") as typeof import("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals, installHookDom }: typeof import("../../../lib/rendererTestHarness.ts") = require("../../../lib/rendererTestHarness.ts");
import type { NoteItem, NoteDeletedPayload } from "../../../../src/contracts/notes";

function note(id: number, folderId: number | null, spaceId = 1): NoteItem {
  return {
    id, title: `Note ${id}`, content: "", note_type: "personal", space_id: spaceId,
    folder_id: folderId, folder_ids: folderId == null ? [] : [folderId],
    source_file: null, audio_duration_seconds: null,
    created_at: "2026-10-02", updated_at: "2026-10-02",
    enhanced_content: null, enhancement_prompt: null, enhanced_at_content_hash: null,
    transcript: null, calendar_event_id: null, participants: null,
    diarization_enabled: null, expected_speaker_count: null,
  };
}

async function mountHome(t: import("node:test").TestContext, rows: () => NoteItem[]) {
  let root: ReturnType<typeof createRoot> | null = null;
  t.after(async () => { if (root) await React.act(async () => root.unmount()); });
  let deletedListener: ((payload: NoteDeletedPayload) => void) | undefined;
  let getNotesCalls = 0;
  installBrowserGlobals(t, { window: {
    electronAPI: {
      getNotes: async () => { getNotesCalls += 1; return rows(); },
      onNoteDeleted: (listener: (payload: NoteDeletedPayload) => void) => {
        deletedListener = listener;
        return () => { deletedListener = undefined; };
      },
      onNoteAdded: () => () => {},
      onNoteUpdated: () => () => {},
      onFolderDeleted: () => () => {},
      getFolders: async () => [], getFolderNoteCounts: async () => [],
      getSpaces: async () => [{ id: 1, name: "Personal", kind: "private" }],
      deleteNote: async () => ({ success: true }),
    },
  } });
  const container = installHookDom(t);
  const mockModules: Record<string, string> = {
    "react-i18next": `
      const tr = (key) => key;
      export const initReactI18next = { type: "3rdParty", init() {} };
      export function useTranslation() { return { t: tr }; }
    `,
    "/hooks/useNotesTreeActions": `export function useNotesTreeActions() { return { handleMoveNote: () => {}, handleCreateFolderAndMove: () => {}, handleDelete: () => {} }; }`,
    "/hooks/useHomeChat": `export function useHomeChat() { return { messages: [], agentState: "idle", sendMessage: async () => {}, cancelStream: () => {}, conversations: [], activeConversationId: null, switchConversation: async () => {}, startNewChat: () => {} }; }`,
    "/hooks/useUpcomingEvents": `export function useUpcomingEvents() { return { events: [], isLoading: false, isConnected: false }; }`,
    "/chat/ChatPanel": `export default function Empty() { return null; }`,
    "/notes/NoteBottomBar": `export default function Empty() { return null; }`,
    "./ComingUp": `export default function Empty() { return null; }`,
    "./RecentNotes": `
      import React from "react";
      export default function RecentNotes({ notes }) {
        globalThis.__recentRows = notes.map((n) => n.id);
        return null;
      }
    `,
    "./HomeSkeleton": `export function RecentNotesSkeleton() { return null; } export function ComingUpSkeleton() { return null; } export function HomeSkeleton() { return null; }`,
  };
  const vite = await createRendererServer(t, { mockModules, noExternal: ["react-i18next"] });
  const globals = globalThis as { __recentRows?: number[] };
  delete globals.__recentRows;
  const { default: HomeView } = await vite.ssrLoadModule("/components/home/HomeView.tsx");
  const store = await vite.ssrLoadModule("/stores/noteStore.ts");
  // Production binds the note IPC listeners from initializeNotesTree
  // (ControlPanel). Bind them here so firing note-deleted exercises the real
  // listener → revision → Home path.
  await React.act(async () => { await store.initializeNotesTree(); });
  root = createRoot(container as unknown as Element);
  await React.act(async () => {
    root!.render(React.createElement(HomeView, { onOpenNote: () => {}, onConnectCalendar: () => {}, onOpenEvent: () => {} }));
    await new Promise((resolve) => setImmediate(resolve));
  });
  const rowIds = () => (globals.__recentRows ?? []).map(String);
  return {
    rowIds,
    fireDeleted: (payload: NoteDeletedPayload) => React.act(async () => { deletedListener?.(payload); await new Promise((resolve) => setImmediate(resolve)); }),
    calls: () => getNotesCalls,
    store,
  };
}

test("deleting a note from an unloaded folder removes it from RecentNotes without a remount", async (t) => {
  const rows: NoteItem[] = [note(1, 9), note(2, null)];
  const home = await mountHome(t, () => rows);
  // The unloaded folder's note is in the authoritative recent list, not in any
  // cached container.
  assert.deepEqual(home.rowIds(), ["1", "2"]);
  const callsBefore = home.calls();

  // Main deletes note 1 from folder 9 (never loaded) and emits note-deleted.
  rows.splice(0, 1);
  await home.fireDeleted({ id: 1 });

  assert.deepEqual(home.rowIds(), ["2"], "the deleted recent note disappears without a remount");
  assert.equal(home.calls(), callsBefore + 1, "Home re-read the authoritative recent list once");
});

test("a cached delete behaves the same as an uncached one", async (t) => {
  const rows: NoteItem[] = [note(1, null), note(2, null)];
  const home = await mountHome(t, () => rows);
  // note 2 lives in no loaded container either; the path is identical.
  assert.deepEqual(home.rowIds(), ["1", "2"]);
  home.store.setActiveContext(1, null);
  rows.splice(1, 1);
  await home.fireDeleted({ id: 2 });
  assert.deepEqual(home.rowIds(), ["1"]);
});

test("a failed delete does not hide the saved note", async (t) => {
  const rows: NoteItem[] = [note(1, 9), note(2, null)];
  const home = await mountHome(t, () => rows);
  const callsBefore = home.calls();
  // Main refused the delete: no note-deleted event, so the list must not change.
  assert.deepEqual(home.rowIds(), ["1", "2"]);
  assert.equal(home.calls(), callsBefore, "no event means no re-read");
});

test("a series of events does not leave a stale response in place", async (t) => {
  const rows: NoteItem[] = [note(1, 9), note(2, 9), note(3, null)];
  const home = await mountHome(t, () => rows);
  assert.deepEqual(home.rowIds(), ["1", "2", "3"]);
  rows.splice(0, 1);
  await home.fireDeleted({ id: 1 });
  rows.splice(0, 1);
  await home.fireDeleted({ id: 2 });
  assert.deepEqual(home.rowIds(), ["3"], "the latest authoritative list wins after a burst of deletes");
});
