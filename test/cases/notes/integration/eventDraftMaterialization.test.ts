// Issue #156: a calendar-event draft's materialization used to persist only
// the initial snapshot plus one catch-up updateNote; keystrokes typed during
// the create → update → get round-trips were lost, and a note that already
// existed left the draft's first input unapplied. The draft now hands its full
// latest revision (read after every await) to the note owner, which persists
// it through the regular pending-save pipeline: replace for a fresh note,
// append for a reused one. Input is never disabled while the request runs.
//
// The test mounts the real EventNoteDraft with a controlled electronAPI and a
// controllable RichTextEditor seam (the fake DOM cannot host tiptap), holding
// each IPC step on a deferred so typed input interleaves between the awaits.
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test") = require("node:test");
const React = require("react") as typeof import("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals, installHookDom }: typeof import("../../../lib/rendererTestHarness.ts") = require("../../../lib/rendererTestHarness.ts");
import type { NoteItem } from "../../../../src/contracts/notes";

const deferred = () => {
  let resolve!: (value?: unknown) => void;
  const promise = new Promise<unknown>((r) => { resolve = r; });
  return { promise, resolve };
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

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

const draftEvent = { id: "evt-1", summary: "Design review", start_time: "2026-10-05T10:00:00Z" };

interface Handoff {
  noteId: number;
  mode: "replace" | "append";
  draft: { title?: string; content?: string };
}

interface DraftHarness {
  typeContent(value: string): Promise<void>;
  handoffs: Handoff[];
  materializedNotes: number[];
  creating: () => boolean;
}

async function mountDraft(
  t: import("node:test").TestContext,
  ipc: {
    createCalendarEventNote: (eventId: string, initial: { title?: string; content?: string }) => Promise<{ noteId: number; folderId: number | null; existing?: boolean } | null>;
    getNote: (id: number) => Promise<NoteItem | null>;
  }
): Promise<DraftHarness> {
  let root: ReturnType<typeof createRoot> | null = null;
  t.after(async () => { if (root) await React.act(async () => root.unmount()); });
  installBrowserGlobals(t, { window: {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    electronAPI: {
      createCalendarEventNote: ipc.createCalendarEventNote,
      getNote: ipc.getNote,
    },
  } });
  const container = installHookDom(t);
  const mockModules: Record<string, string> = {
    "react-i18next": `
      const t = (key) => key;
      export const initReactI18next = { type: "3rdParty", init() {} };
      export function useTranslation() { return { t, i18n: { resolvedLanguage: "en" } }; }
    `,
    // The controlled input seam: the fake DOM cannot host tiptap. The draft
    // component's creating flag is mirrored out for the interleaving asserts.
    "/ui/RichTextEditor": `
      export function RichTextEditor({ onChange, disabled }) {
        globalThis.__draftOnChange = onChange;
        globalThis.__draftDisabled = disabled;
        return null;
      }
    `,
    "./NoteBottomBar": `export default function Empty() { return null; }`,
    "./NoteParticipants": `export default function Empty() { return null; }`,
    "./NoteRecordControl": `export default function Empty() { return null; }`,
  };
  const vite = await createRendererServer(t, { mockModules, noExternal: ["react-i18next"] });
  const globals = globalThis as {
    __draftOnChange?: (value: string) => void;
    __draftDisabled?: boolean;
  };
  const { default: EventNoteDraft } = await vite.ssrLoadModule("/components/notes/EventNoteDraft.tsx");

  const handoffs: Handoff[] = [];
  const materializedNotes: number[] = [];
  root = createRoot(container as unknown as Element);
  await React.act(async () => {
    root!.render(React.createElement(EventNoteDraft, {
      event: draftEvent,
      onBack: () => {},
      onDraftHandoff: (handoff: Handoff) => { handoffs.push(handoff); },
      onMaterialized: (note: NoteItem) => { materializedNotes.push(note.id); },
    }));
  });

  return {
    typeContent: async (value: string) => {
      await React.act(async () => { globals.__draftOnChange?.(value); });
    },
    handoffs,
    materializedNotes,
    creating: () => globals.__draftDisabled === true,
  };
}

test("input typed during the whole create → get round-trip reaches the handoff", async (t) => {
  const createGate = deferred();
  const getGate = deferred();
  const createCalls: Array<{ eventId: string; initial: { title?: string; content?: string } }> = [];
  const harness = await mountDraft(t, {
    createCalendarEventNote: async (eventId, initial) => {
      createCalls.push({ eventId, initial });
      await createGate.promise;
      return { noteId: 42, folderId: null };
    },
    getNote: async () => {
      await getGate.promise;
      return noteFixture(42, "Design review", "");
    },
  });

  // The first keystroke starts the deferred create with the snapshot.
  await harness.typeContent("A");
  await tick();
  assert.equal(harness.creating(), false, "input stays enabled while the request runs");
  assert.deepEqual(createCalls, [{ eventId: "evt-1", initial: { content: "A" } }]);

  // Keystrokes land while the create is in flight and while get is in flight.
  await harness.typeContent("AB");
  createGate.resolve();
  await tick();
  await harness.typeContent("ABC");
  getGate.resolve();
  await tick();

  assert.deepEqual(harness.handoffs, [{
    noteId: 42,
    note: noteFixture(42, "Design review", ""),
    mode: "replace",
    draft: { content: "ABC" },
  }], "the handoff carries the full latest revision, not the snapshot");
  assert.deepEqual(harness.materializedNotes, [42]);
});

test("a reused note hands the draft off in append mode", async (t) => {
  const harness = await mountDraft(t, {
    createCalendarEventNote: async () => ({ noteId: 7, folderId: 3, existing: true }),
    getNote: async () => noteFixture(7, "Manual title", "Manual content"),
  });

  await harness.typeContent("first input");
  await tick();

  assert.deepEqual(harness.handoffs, [{
    noteId: 7,
    note: noteFixture(7, "Manual title", "Manual content"),
    mode: "append",
    draft: { content: "first input" },
  }], "an existing note must not have its manual text clobbered");
  assert.deepEqual(harness.materializedNotes, [7]);
});

test("a failed create keeps the draft for retry", async (t) => {
  const harness = await mountDraft(t, {
    createCalendarEventNote: async () => null,
    getNote: async () => null,
  });

  await harness.typeContent("kept");
  await tick();

  assert.deepEqual(harness.handoffs, [], "a failed create hands nothing off");
  assert.deepEqual(harness.materializedNotes, []);
  assert.equal(harness.creating(), false, "the draft stays usable for a retry");
});
