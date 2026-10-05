// Issue #185: container caches carry only the newest 50 Notes per container.
// Search and chat can surface an older Note, but opening passed only the
// id/container and useActiveNote looked the row up solely in the cached
// lists — the editor stayed in the skeleton forever. The opened row is now
// held independently (selectedNote) and fetched by id when only the id is
// known; update/delete events keep it consistent; quick switches drop stale
// fetches.
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const test: typeof import("node:test") = require("node:test");

const React = require("react") as typeof import("react");

const { createRoot } = require("react-dom/client");

const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
}: typeof import("../../../lib/rendererTestHarness.ts") = require("../../../lib/rendererTestHarness.ts");

import type { NoteItem } from "../../../../src/contracts/notes";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function note(id: number, folderId: number | null, title: string): NoteItem {
  return {
    id,
    title,
    content: `body ${id}`,
    note_type: "personal",
    space_id: 1,
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

interface Harness {
  openById(id: number): Promise<void>;
  selectById(id: number): void;
  activeNote(): NoteItem | null;
  getNoteCalls(): number;
  fireExternalUpdate(note: NoteItem): Promise<void>;
  fireDeleted(id: number): Promise<void>;
}

async function mountStore(
  t: import("node:test").TestContext,
  rows: NoteItem[],
  getNoteImpl: (id: number) => Promise<NoteItem | null>
): Promise<Harness> {
  let root: ReturnType<typeof createRoot> | null = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  let noteUpdatedListener: ((note: NoteItem) => void) | undefined;
  let noteDeletedListener: ((payload: { id: number }) => void) | undefined;
  let getNoteCalls = 0;
  installBrowserGlobals(t, {
    window: {
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      electronAPI: {
        getSpaces: async () => [{ id: 1, name: "Personal", kind: "private" }],
        getFolders: async () => [],
        getFolderNoteCounts: async () => [],
        getNotes: async () => rows,
        getNote: async (id: number) => {
          getNoteCalls += 1;

          return getNoteImpl(id);
        },
        updateNote: async () => ({ success: true }),
        deleteNote: async () => ({ success: true }),
        onNoteAdded: () => () => {},
        onNoteUpdated: (listener: (note: NoteItem) => void) => {
          noteUpdatedListener = listener;

          return () => {
            noteUpdatedListener = undefined;
          };
        },
        onNoteDeleted: (listener: (payload: { id: number }) => void) => {
          noteDeletedListener = listener;

          return () => {
            noteDeletedListener = undefined;
          };
        },
        onFolderDeleted: () => () => {},
      },
    },
  });
  const container = installHookDom(t);

  const vite = await createRendererServer(t, { mockModules: {} });

  const store = (await vite.ssrLoadModule(
    "/stores/noteStore.ts"
  )) as typeof import("../../../../src/stores/noteStore");

  await React.act(async () => {
    await store.initializeNotesTree();
  });
  root = createRoot(container as unknown as Element);
  await React.act(async () => {
    root!.render(React.createElement("div"));
  });

  return {
    openById: async (id: number) => {
      await React.act(async () => {
        await store.openNoteRow({ id } as NoteItem);
      });
    },
    // The sidebar/list path: a plain selection write, not openNoteRow.
    selectById: (id: number) => {
      store.setActiveNoteId(id);
    },
    activeNote: () => store.getNoteFromStore(store.getActiveNoteIdValue() ?? -1),
    getNoteCalls: () => getNoteCalls,
    fireExternalUpdate: async (updated: NoteItem) => {
      await React.act(async () => {
        noteUpdatedListener?.(updated);
      });
    },
    fireDeleted: async (id: number) => {
      await React.act(async () => {
        noteDeletedListener?.({ id });
      });
    },
  };
}

test("a Note outside the newest-50 cache is fetched by id and opens in the editor", async (t) => {
  // 51 cached notes (limit); note 999 is only reachable via search/chat.
  const rows = Array.from({ length: 51 }, (_, index) => note(index + 1, null, `Note ${index + 1}`));
  const old = note(999, null, "Ancient note");
  const harness = await mountStore(t, rows, async (id) => (id === 999 ? old : null));

  await harness.openById(999);

  assert.equal(harness.getNoteCalls(), 1, "the row is fetched once");
  const active = harness.activeNote();
  assert.ok(active, "the fetched row is held as the active note");
  assert.equal(active!.id, 999);
  assert.equal(active!.title, "Ancient note");
});

test("an already-cached Note opens without an extra fetch", async (t) => {
  const rows = Array.from({ length: 51 }, (_, index) => note(index + 1, null, `Note ${index + 1}`));

  const harness = await mountStore(t, rows, async () => {
    throw new Error("must not fetch a cached note");
  });

  await harness.openById(7);

  assert.equal(harness.getNoteCalls(), 0, "no fetch for a cached row");
  assert.equal(harness.activeNote()!.id, 7);
});

test("update and delete events keep the selected row consistent", async (t) => {
  const rows = Array.from({ length: 51 }, (_, index) => note(index + 1, null, `Note ${index + 1}`));
  const old = note(999, null, "Ancient note");
  const harness = await mountStore(t, rows, async (id) => (id === 999 ? old : null));

  await harness.openById(999);
  assert.equal(harness.activeNote()!.title, "Ancient note");

  // An external update reaches the selected row even though it is not cached.
  await harness.fireExternalUpdate({ ...old, title: "Renamed ancient" });
  assert.equal(harness.activeNote()!.title, "Renamed ancient", "the selected row follows updates");

  // Deleting it clears the selected row; the editor moves to a neighbor
  // (standard relocation), never the deleted row itself.
  await harness.fireDeleted(999);
  const afterDelete = harness.activeNote();
  assert.ok(!afterDelete || afterDelete.id !== 999, "the deleted row is no longer shown");
});

test("a quick switch to another note drops the stale fetch result", async (t) => {
  const rows = Array.from({ length: 51 }, (_, index) => note(index + 1, null, `Note ${index + 1}`));
  const slow = note(888, null, "Slow ancient");
  let releaseSlow: ((value: NoteItem | null) => void) | undefined;

  const slowPromise = new Promise<NoteItem | null>((resolve) => {
    releaseSlow = resolve;
  });

  let released = false;

  const harness = await mountStore(t, rows, async (id) => {
    if (id === 888 && !released) return slowPromise;

    if (id === 888) return slow;

    return null;
  });

  // Start opening the uncached note; its fetch hangs.
  let firstOpen: Promise<void> | null = null;
  await React.act(async () => {
    firstOpen = harness.openById(888);
    await tick();
  });

  // Switch away quickly to a cached note.
  await harness.openById(5);
  assert.equal(
    harness.activeNote()!.id,
    5,
    "the cached note is active while the fetch is in flight"
  );

  // The stale fetch lands late and must not take over the editor.
  released = true;
  releaseSlow?.(slow);
  await React.act(async () => {
    await firstOpen;
  });

  assert.equal(harness.activeNote()!.id, 5, "the late fetch result is dropped");
  assert.equal(harness.getNoteCalls(), 1);
});

// The majority navigation path is setActiveNoteId (sidebar/list clicks,
// pills, drains): it must invalidate the in-flight fetch just like an
// openNoteRow switch does (#185, review round 1).
test("a quick setActiveNoteId selection drops the stale openNoteRow fetch", async (t) => {
  const rows = Array.from({ length: 51 }, (_, index) => note(index + 1, null, `Note ${index + 1}`));
  const slow = note(777, null, "Slow note");
  let releaseSlow: ((value: NoteItem | null) => void) | undefined;

  const slowPromise = new Promise<NoteItem | null>((resolve) => {
    releaseSlow = resolve;
  });

  let released = false;

  const harness = await mountStore(t, rows, async (id) => {
    if (id === 777 && !released) return slowPromise;

    if (id === 777) return slow;

    return null;
  });

  await React.act(async () => {
    void harness.openById(777);
    await tick();
  });

  // Switch away through the plain selection write (sidebar/list click).
  await React.act(async () => {
    harness.selectById(9);
  });
  assert.equal(harness.activeNote()!.id, 9, "the sidebar selection is active");

  released = true;
  releaseSlow?.(slow);
  await tick();
  await tick();

  assert.equal(harness.activeNote()!.id, 9, "the stale fetch never hijacks the selection");
});
