// Issue #186: Home keeps a recent list fetched separately, and
// refreshed only when `notesByContainer` identity changed. Deleting a note from
// an unloaded folder succeeded in main and emitted note-deleted, but the store's
// removeNote no-ops when the row is not cached, so the container map never
// changed and Home never re-read — the row stayed until a remount. This mounts
// the real HomeView with the real noteStore and fires the real note-deleted
// listener to prove the event revision refreshes the list without a remount.
//
// The `getNotes` fixture is container-aware so a note can live in an unloaded
// folder (uncached) or a loaded one (cached), which is what distinguishes the
// old cache-identity trigger from the event revision.
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const test: typeof import("node:test") = require("node:test");

const React = require("react") as typeof import("react");

const { createRoot } = require("react-dom/client");

const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
}: typeof import("../../../lib/rendererTestHarness.ts") = require("../../../lib/rendererTestHarness.ts");

import type { NoteItem, NoteDeletedPayload } from "../../../../src/contracts/notes";

function note(id: number, folderId: number | null): NoteItem {
  return {
    id,
    title: `Note ${id}`,
    content: "",
    note_type: "personal",
    folder_id: folderId,
    folder_ids: folderId == null ? [] : [folderId],
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
}

interface HomeHarness {
  rowIds(): string[];
  remount(): Promise<void>;
  fireDeleted(payload: NoteDeletedPayload): Promise<void>;
  // Synchronous trigger, for interleaving two events before either read lands.
  fireDeletedSync(payload: NoteDeletedPayload): void;
  calls(): number;
  deleteCalls(): number;
  cachedNotes(key: string): NoteItem[];
  revision(): number;
  loadContainer(key: string): Promise<NoteItem[]>;
  // The rendered RecentNotes' own delete action, mirroring the row button.
  deleteNote(id: number): Promise<void>;
}

async function mountHome(
  t: import("node:test").TestContext,
  rows: () => NoteItem[],
  {
    getNotesImpl,
    deleteNoteResult = { success: true },
  }: {
    getNotesImpl?: () => Promise<NoteItem[]>;
    deleteNoteResult?: { success: boolean };
  } = {}
): Promise<HomeHarness> {
  let root: ReturnType<typeof createRoot> | null = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  let deletedListener: ((payload: NoteDeletedPayload) => void) | undefined;
  let getNotesCalls = 0;
  let deleteCalls = 0;

  // Mirrors the real bridge: folderId (3rd arg) scopes the
  // list; no scope is the recent list.
  const realGetNotes = async (folderId: number | null) => {
    const all = rows();

    if (folderId != null) return all.filter((n) => n.folder_ids.includes(folderId));

    return all;
  };

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getNotes: async (
          _type: unknown,
          _limit: unknown,
          folderId: number | null = null,
        ) => {
          getNotesCalls += 1;

          return getNotesImpl ? getNotesImpl() : realGetNotes(folderId);
        },
        onNoteDeleted: (listener: (payload: NoteDeletedPayload) => void) => {
          deletedListener = listener;

          return () => {
            deletedListener = undefined;
          };
        },
        onNoteAdded: () => () => {},
        onNoteUpdated: () => () => {},
        onFolderDeleted: () => () => {},
        getFolders: async () => [],
        getFolderNoteCounts: async () => [],
        getRootNotes: async () => rows().filter((n) => n.folder_ids.length === 0),
        deleteNote: async (id: number) => {
          deleteCalls += 1;
          void id;

          return deleteNoteResult;
        },
      },
    },
  });
  const container = installHookDom(t);

  const mockModules: Record<string, string> = {
    "react-i18next": `
      const tr = (key) => key;
      export const initReactI18next = { type: "3rdParty", init() {} };
      export function useTranslation() { return { t: tr }; }
    `,
    // The real hook wraps the store; here it is reduced to the two seams Home
    // passes to RecentNotes, so the test can drive the row's delete action.
    "/hooks/useNotesTreeActions": `export function useNotesTreeActions() { return { handleMoveNote: () => {}, handleCreateFolderAndMove: () => {}, handleDelete: (id) => window.electronAPI.deleteNote(id) }; }`,
    "/hooks/useHomeChat": `export function useHomeChat() { return { messages: [], agentState: "idle", sendMessage: async () => {}, cancelStream: () => {}, conversations: [], activeConversationId: null, switchConversation: async () => {}, startNewChat: () => {} }; }`,
    "/hooks/useUpcomingEvents": `export function useUpcomingEvents() { return { events: [], isLoading: false, isConnected: false }; }`,
    "/chat/ChatPanel": `export default function Empty() { return null; }`,
    "/notes/NoteBottomBar": `export default function Empty() { return null; }`,
    "./ComingUp": `export default function Empty() { return null; }`,
    "./RecentNotes": `
      import React from "react";
      export default function RecentNotes({ notes, onDeleteNote }) {
        globalThis.__recentRows = notes.map((n) => n.id);
        globalThis.__onDeleteNote = onDeleteNote;
        return null;
      }
    `,
    "./HomeSkeleton": `export function RecentNotesSkeleton() { return null; } export function ComingUpSkeleton() { return null; } export function HomeSkeleton() { return null; }`,
  };

  const vite = await createRendererServer(t, { mockModules, noExternal: ["react-i18next"] });
  const globals = globalThis as { __recentRows?: number[]; __onDeleteNote?: (id: number) => void };
  delete globals.__recentRows;
  delete globals.__onDeleteNote;
  const { default: HomeView } = await vite.ssrLoadModule("/components/home/HomeView.tsx");
  const store = await vite.ssrLoadModule("/stores/noteStore.ts");
  // Production binds the note IPC listeners from initializeNotesTree
  // (ControlPanel). Bind them here so firing note-deleted exercises the real
  // listener → revision → Home path.
  await React.act(async () => {
    await store.initializeNotesTree();
  });
  root = createRoot(container as unknown as Element);
  await React.act(async () => {
    root!.render(
      React.createElement(HomeView, {
        onOpenNote: () => {},
        onConnectCalendar: () => {},
        onOpenEvent: () => {},
      })
    );
    await new Promise((resolve) => setImmediate(resolve));
  });

  return {
    rowIds: () => (globals.__recentRows ?? []).map(String),
    remount: async () => {
      await React.act(async () => root!.unmount());
      root = createRoot(container as unknown as Element);
      await React.act(async () => {
        root!.render(
          React.createElement(HomeView, {
            onOpenNote: () => {},
            onConnectCalendar: () => {},
            onOpenEvent: () => {},
          })
        );
      });
    },
    fireDeleted: (payload: NoteDeletedPayload) =>
      React.act(async () => {
        deletedListener?.(payload);
        await new Promise((resolve) => setImmediate(resolve));
      }),
    fireDeletedSync: (payload: NoteDeletedPayload) => {
      deletedListener?.(payload);
    },
    calls: () => getNotesCalls,
    deleteCalls: () => deleteCalls,
    cachedNotes: (key: string) => store.getNotesByContainerValue()[key] ?? [],
    revision: () => store.getNoteEventsRevisionValue(),
    loadContainer: async (key: string) => {
      let loaded: NoteItem[] = [];
      await React.act(async () => {
        loaded = await store.loadContainerNotes(key);
      });

      return loaded;
    },
    deleteNote: (id: number) =>
      React.act(async () => {
        globals.__onDeleteNote?.(id);
        await new Promise((resolve) => setImmediate(resolve));
      }),
  };
}

test("deleting a note from an unloaded folder removes it from RecentNotes without a remount", async (t) => {
  // note 1 lives in folder 9, which is never loaded; note 2 sits at the root
  // loaded by initializeNotesTree.
  const rows: NoteItem[] = [note(1, 9), note(2, null)];
  const home = await mountHome(t, () => rows);
  assert.deepEqual(
    home.cachedNotes("root").map((n) => n.id),
    [2],
    "only the root is cached"
  );
  assert.deepEqual(home.rowIds(), ["1", "2"]);
  const callsBefore = home.calls();

  // Main deletes note 1 from folder 9 (never loaded) and emits note-deleted.
  rows.splice(0, 1);
  await home.fireDeleted({ id: 1 });

  assert.deepEqual(home.rowIds(), ["2"], "the deleted recent note disappears without a remount");
  assert.equal(home.calls(), callsBefore + 1, "Home re-read the authoritative recent list once");
});

test("a cached delete refreshes Home and counts the same as an uncached one", async (t) => {
  const rows: NoteItem[] = [note(1, 9), note(2, null)];
  const home = await mountHome(t, () => rows);
  // Load folder 9 so note 1 is genuinely cached, making this the cached path.
  await home.loadContainer("f:9");
  assert.ok(
    home.cachedNotes("f:9").some((n) => n.id === 1),
    "note 1 is cached"
  );
  assert.deepEqual(home.rowIds(), ["1", "2"]);
  const callsBefore = home.calls();

  rows.splice(0, 1);
  await home.fireDeleted({ id: 1 });

  assert.deepEqual(home.rowIds(), ["2"], "the deleted cached note disappears");
  assert.equal(
    home.calls(),
    callsBefore + 1,
    "a cached delete re-reads Home exactly once, like the uncached path"
  );
});

test("a failed delete drives the action but hides nothing", async (t) => {
  const rows: NoteItem[] = [note(1, 9), note(2, null)];
  const home = await mountHome(t, () => rows, { deleteNoteResult: { success: false } });
  assert.deepEqual(home.rowIds(), ["1", "2"]);
  const callsBefore = home.calls();
  const revisionBefore = home.revision();

  // Drive the real row delete action; main refuses it and emits no event.
  await home.deleteNote(1);

  assert.equal(home.deleteCalls(), 1, "the delete action actually ran");
  assert.deepEqual(home.rowIds(), ["1", "2"], "a refused delete keeps the saved note visible");
  assert.equal(home.calls(), callsBefore, "no confirmed event means no re-read");
  assert.equal(home.revision(), revisionBefore, "a failed delete does not bump the revision");
});

test("a burst of events drops late older responses from state and the remount cache", async (t) => {
  const rows: NoteItem[] = [note(1, 9), note(2, 9), note(3, null)];
  // Post-mount reads are held open so an older response can be resolved after a
  // newer one; each captures the row list as it looked when that read started.
  let holdReads = false;
  const inFlight: Array<{ snapshot: NoteItem[]; release: () => void }> = [];

  const home = await mountHome(t, () => rows, {
    getNotesImpl: () =>
      holdReads
        ? new Promise<NoteItem[]>((resolve) => {
            const snapshot = [...rows];
            inFlight.push({ snapshot, release: () => resolve(snapshot) });
          })
        : Promise.resolve([...rows]),
  });

  assert.deepEqual(home.rowIds(), ["1", "2", "3"], "mount resolved before the burst");
  const callsBefore = home.calls();
  holdReads = true;

  // Event 1 (delete note 1): its getNotes call starts and stays in flight.
  rows.splice(0, 1);
  await React.act(async () => {
    home.fireDeletedSync({ id: 1 });
    await Promise.resolve();
  });
  // Event 2 (delete note 2): a separate effect run starts a second read.
  rows.splice(0, 1);
  await React.act(async () => {
    home.fireDeletedSync({ id: 2 });
    await Promise.resolve();
  });

  assert.equal(home.calls(), callsBefore + 2, "one re-read per event, no extras");
  assert.equal(inFlight.length, 2, "both burst reads are in flight");
  // The first read captured [2, 3]; the second captured [3].
  assert.deepEqual(
    inFlight[0].snapshot.map((n) => n.id),
    [2, 3]
  );
  assert.deepEqual(
    inFlight[1].snapshot.map((n) => n.id),
    [3]
  );

  // Resolve the newer (second) response first, then the older (first). The
  // stale guard must drop the older one.
  await React.act(async () => {
    inFlight[1].release();
    await Promise.resolve();
    inFlight[0].release();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(home.rowIds(), ["3"], "a late older response must not overwrite the newer list");
  await home.remount();
  assert.equal(inFlight.length, 3, "remount fetch stays pending so the cache is observable");
  assert.deepEqual(
    home.rowIds(),
    ["3"],
    "superseded response must not restore deleted rows from cache"
  );
  await React.act(async () => {
    inFlight[2].release();
  });
});
