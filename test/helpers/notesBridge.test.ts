const test: typeof import("node:test") = require("node:test");

const { loadBundledPreload: loadPreload, createListenerRegistry }: typeof import("./harness/bundledPreload.ts") = require("./harness/bundledPreload.ts");

const { skipOrFail }: typeof import("./harness/nativeBinding.ts") = require("./harness/nativeBinding.ts");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const os: typeof import("node:os") = require("node:os");

const path: typeof import("node:path") = require("node:path");

const Module = require("node:module");

import type { NotesApi, NoteItem, NoteDeletedPayload } from "../../src/contracts/notes.js";

// The real bundled preload talks to a Map of real registered Notes handlers
// over a temporary SQLite database. Main-side event sends are dispatched back
// into the preload-registered listeners, closing the loop like Electron does,
// without exposing any event object to renderer callbacks.
type Handler = (event: unknown, ...args: unknown[]) => unknown;

type Listener = (event: unknown, data: unknown) => void;

let activeHandlers: Map<string, Handler> | null = null;

let dispatchSend: ((channel: string, data: unknown) => void) | null = null;

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-notes-bridge-"));

const originalLoad = Module._load;

Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return {
      app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false },
      ipcMain: {
        handle: (channel: string, listener: Handler) => {
          if (!activeHandlers) activeHandlers = new Map();
          activeHandlers.set(channel, listener);
        },
      },
      BrowserWindow: {
        getAllWindows: () => [
          {
            isDestroyed: () => false,
            webContents: {
              send: (channel: string, data: unknown) => {
                if (dispatchSend) dispatchSend(channel, data);
              },
            },
          },
        ],
      },
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const {
  NoteReadService,
}: typeof import("../../src/helpers/noteReadService.ts") = require("../../src/helpers/noteReadService.ts");

const DatabaseManager: typeof import("../../src/helpers/database.ts").DatabaseManager = require("../../src/helpers/database.ts");

test.after(() => {
  Module._load = originalLoad;
});

function loadBundledPreload(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>) {
  const registry = createListenerRegistry();

  return { api: loadPreload<NotesApi>({ invoke, ...registry }), listeners: registry.listeners };
}

async function createFixture(t: import("node:test").TestContext) {
  activeHandlers = new Map();
  dispatchSend = null;
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-notes-bridge-"));
  let db;

  try {
    db = new DatabaseManager();
  } catch (error) {
    skipOrFail(t, error);

    return null;
  }

  t.after(() => db.close());

  const { NoteWriteService } = await import("../../src/helpers/noteWriteService.ts");
  const { registerNotesHandlers } = await import("../../src/helpers/notesIpcHandlers.ts");
  const handlers = activeHandlers;
  assert.ok(handlers);
  registerNotesHandlers(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    {
      noteWrites: new NoteWriteService({
        database: db,
        mirrorWrite: () => {},
        refreshMeetingSpeakerConfigFromNote: () => {},
      }),
      getNote: (id) => db.getNote(id),
      getNotes: (...args) => db.getNotes(...args),
      getRootNotes: (...args) => db.getRootNotes(...args),
      deleteNoteInternal: (id) => {
        const result = db.deleteNote(id);

        if (result?.success) {
          setImmediate(() => {
            if (dispatchSend) dispatchSend("note-deleted", { id });
          });
        }

        return result;
      },
      searchNotes: (...args) => db.searchNotes(...args),
      searchNoteContent: () => [],
      searchNoteTranscripts: () => [],
      getNoteOutput: (request) =>
        new NoteReadService(db, { readRunArtifact: () => null } as never).readOutput(request),
      getNoteTranscript: () => ({
        note_id: 1,
        status: "absent",
        timeline: {
          unit: "ms",
          duration_ms: null,
          basis: "concatenated_recording_time",
          intentional_pauses: "excluded",
        },
        speakers: [],
        text: null,
        segments: null,
        diagnostics: [],
      }),
    }
  );

  const handlersSnapshot = new Map(handlers);

  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlersSnapshot.get(channel);

    if (!handler) throw new Error(`No handler registered for ${channel}`);

    return handler(null, ...args);
  };

  const { api, listeners } = loadBundledPreload(invoke);
  // Close the event loop: main-side sends dispatch into the listeners the
  // preload registered, exactly like Electron would.
  dispatchSend = (channel: string, data: unknown) => {
    for (const listener of listeners.get(channel) || []) {
      listener(null, data);
    }
  };

  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  return { db, api, listeners, flush };
}

test("the full bundled preload chain round-trips a note", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);

  if (!ctx) return;
  const { api, flush } = ctx;

  const saved = await api.saveNote("Bridge", "Body", "personal", null, null, null);
  assert.ok(saved.success);
  assert.equal(saved.note.title, "Bridge");

  assert.deepEqual(await api.getNote(saved.note.id), saved.note);
  assert.equal(await api.getNote(987654), null);

  const updated = await api.updateNote(saved.note.id, { title: "Bridge2" });
  assert.ok(updated.success);
  assert.equal(updated.note.title, "Bridge2");

  const listed = await api.getNotes(null, 100, null);
  assert.ok(listed.some((n) => n.id === saved.note.id));

  const rootNotes = await api.getRootNotes(50);
  assert.ok(rootNotes.some((n) => n.id === saved.note.id));

  const found = await api.searchNotes("Bridge2", 50, null);
  assert.ok(found.some((n) => n.id === saved.note.id));
  assert.equal((await api.searchNotes("", 50, null)).length, 0);

  const deleted = await api.deleteNote(saved.note.id);
  assert.equal(deleted.success, true);
  await flush();
  assert.equal(await api.getNote(saved.note.id), null);
});

test("wrong arguments reject through the bridge before the DB runs", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);

  if (!ctx) return;
  const { api } = ctx;

  await assert.rejects(() => api.getNote("nope" as unknown as number));
  await assert.rejects(() => api.updateNote(1, { title: 42 as unknown as string }));
  await assert.rejects(() => api.saveNote(1 as unknown as string, "x"));
});

test("independent subscriptions receive events and unsubscribe cleanly", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);

  if (!ctx) return;
  const { api, flush } = ctx;

  const added: NoteItem[] = [];
  const addedToo: NoteItem[] = [];
  const unsubA = api.onNoteAdded((note) => added.push(note));
  const unsubB = api.onNoteAdded((note) => addedToo.push(note));

  const saved = await api.saveNote("Sub", "");
  assert.ok(saved.success);
  await flush();

  assert.equal(added.length, 1);
  assert.equal(addedToo.length, 1);
  assert.equal(added[0].id, saved.note.id);

  unsubA();
  const second = await api.saveNote("Sub2", "");
  assert.ok(second.success);
  await flush();

  assert.equal(added.length, 1, "unsubscribed listener is not called again");
  assert.equal(addedToo.length, 2);
  assert.equal(addedToo[1].id, second.note.id);
  unsubB();
});

test("malformed events are dropped; the next valid one is delivered", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);

  if (!ctx) return;
  const { api, flush } = ctx;

  const received: NoteItem[] = [];
  api.onNoteAdded((note) => received.push(note));

  // Simulate a main-side producer emitting a malformed payload.
  const { sendNoteAdded } = await import("../../src/helpers/notesEvents.ts");
  sendNoteAdded({ id: 1, broken: true });
  await flush();
  assert.equal(received.length, 0, "malformed payloads never reach the renderer");

  const saved = await api.saveNote("Valid", "");
  assert.ok(saved.success);
  await flush();
  assert.equal(received.length, 1);
  assert.equal(received[0].id, saved.note.id);
});

test("deleted notes are not resurrectable and emit note-deleted once", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);

  if (!ctx) return;
  const { api, flush } = ctx;

  const deletions: NoteDeletedPayload[] = [];
  const unsub = api.onNoteDeleted((payload) => deletions.push(payload));
  const saved = await api.saveNote("Gone", "");
  assert.ok(saved.success);
  assert.equal((await api.deleteNote(saved.note.id)).success, true);
  await flush();
  assert.equal(deletions.length, 1);
  assert.equal(deletions[0].id, saved.note.id);

  assert.equal((await api.deleteNote(saved.note.id)).success, false);
  await flush();
  assert.equal(deletions.length, 1);
  unsub();
});

test("internal output request crosses the real preload and read owner with validated provenance", async (t) => {
  const ctx = await createFixture(t);

  if (!ctx) return;
  const saved = await ctx.api.saveNote("Output", "Manual");
  assert.ok(saved.success);
  await ctx.api.updateNote(saved.note.id, {
    enhanced_content: "Edited summary",
    transcript: "Uploaded text",
  });
  const output = await ctx.api.getNoteOutput({ noteId: saved.note.id, scope: "note" });
  assert.equal(output.scope, "note");

  if (output.scope !== "note") return;
  assert.equal(output.summary, "Edited summary");
  assert.equal(output.transcript.text, "Uploaded text");
  assert.deepEqual(JSON.parse(JSON.stringify(output.summaryProvenance)), {
    source: "note-projection",
    runIds: [],
  });
  await assert.rejects(
    () => ctx.api.getNoteOutput({ noteId: saved.note.id, scope: "run" } as never),
    /Invalid arguments/
  );
  const { api } = loadBundledPreload(async () => ({ scope: "note", noteId: saved.note.id }));
  await assert.rejects(
    () => api.getNoteOutput({ noteId: saved.note.id, scope: "note" }),
    /Unexpected response/
  );
});
