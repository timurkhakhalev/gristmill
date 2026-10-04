const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const Module = require("node:module");
import type { NotesHandlerDeps } from "../../src/helpers/notesIpcHandlers.ts";
import type { DatabaseManager as Database } from "../../src/helpers/database.ts";

// Stub electron before any src module loads: database.js needs app.getPath,
// notesEvents.ts needs BrowserWindow, notesIpcHandlers.ts needs ipcMain.
// Broadcasts are captured per-fixture via the active fixture's array, so tests
// never see each other's events even across setImmediate ticks.
const handlers = new Map();
type SentEvent = { channel: string; data: Record<string, unknown> & { id: number } };
let activeSent: SentEvent[] | null = null;
let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-notes-ipc-"));

const originalLoad = Module._load;
Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return {
      app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false },
      ipcMain: {
        handle: (channel: string, listener: unknown) => handlers.set(channel, listener),
      },
      BrowserWindow: {
        getAllWindows: () => [
          {
            isDestroyed: () => false,
            webContents: {
              send: (ch: string, data: unknown) => {
                assert.ok(data && typeof data === "object" && "id" in data && typeof data.id === "number");
                if (activeSent) activeSent.push({ channel: ch, data: data as SentEvent["data"] });
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

const { NoteWriteService } = require("../../src/helpers/noteWriteService.ts");
const DatabaseManager = require("../../src/helpers/database.ts");

test.after(() => {
  Module._load = originalLoad;
});

function isNativeBindingUnavailable(error: unknown) {
  const message = String(error instanceof Error ? error.message : error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

// Load the TS modules through tsx after the electron stub is installed.
async function loadModules() {
  const [{ registerNotesHandlers }, events] = await Promise.all([
    import("../../src/helpers/notesIpcHandlers.ts"),
    import("../../src/helpers/notesEvents.ts"),
  ]);
  return { registerNotesHandlers, events };
}

async function createFixture(t: import("node:test").TestContext, mirrorError?: Error) {
  const { registerNotesHandlers } = await loadModules();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-notes-ipc-"));
  let db;
  try {
    db = new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
  t.after(() => db.close());

  const sent: SentEvent[] = [];
  activeSent = sent;
  handlers.clear();

  const effects: { mirrorWrites: number[]; mirrorDeletes: number[]; autoLabels: number[]; speakerRefreshes: [number, number][] } = { mirrorWrites: [], mirrorDeletes: [], autoLabels: [], speakerRefreshes: [] };
  const deps: NotesHandlerDeps = {
    noteWrites: new NoteWriteService({
      database: db,
      mirrorWrite: (note: import("../../src/contracts/notes.ts").NoteItem) => { effects.mirrorWrites.push(note.id); if (mirrorError) throw mirrorError; },
      tryAutoLabelOneOnOne: (id: number) => { effects.autoLabels.push(id); },
      refreshMeetingSpeakerConfigFromNote: (id: number, note: import("../../src/contracts/notes.ts").NoteItem) => { effects.speakerRefreshes.push([id, note.id]); },
    }),
    getNote: (id) => db.getNote(id),
    getNotes: (noteType, limit, folderId, spaceId) =>
      db.getNotes(noteType, limit, folderId, spaceId),
    getNotesForSpace: (spaceId, limit) => db.getNotesForSpace(spaceId, limit),
    deleteNoteInternal: () => {
      throw new Error("replaced below");
    },
    searchNotes: (query, limit, spaceId, folderId) =>
      db.searchNotes(query, limit, spaceId, folderId),
    searchNoteContent: () => [],
    searchNoteTranscripts: () => [],
    getNoteTranscript: () => ({ note_id: 1, status: "absent", timeline: { unit: "ms", duration_ms: null, basis: "concatenated_recording_time", intentional_pauses: "excluded" }, speakers: [], text: null, segments: null, diagnostics: [] }),

  };
  const deleteCalls: unknown[] = [];
  const realDelete = (id: number) => {
    deleteCalls.push(id);
    const result = db.deleteNote(id);
    if (result?.success) {
      setImmediate(() => eventsModule.sendNoteDeleted({ id }));
      effects.mirrorDeletes.push(id);
    }
    return result;
  };
  const eventsModule = { sendNoteDeleted: (await loadModules()).events.sendNoteDeleted };
  deps.deleteNoteInternal = realDelete;

  registerNotesHandlers({ handle: (channel, listener) => handlers.set(channel, listener) }, deps);

  const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)(null, ...args);
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { db, call, sent, effects, deleteCalls, flush, noteWrites: deps.noteWrites };
}

test("save → get → update → search/list → delete round-trips through real handlers", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { call, sent, db, effects, flush } = ctx;

  const saved = await call("db-save-note", "Title", "Body", "personal", null, 3, null, null);
  assert.equal(saved.success, true);
  assert.equal(saved.note.title, "Title");
  assert.equal(sent.filter((s) => s.channel === "note-added").length, 0, "event waits a tick");
  assert.deepEqual(effects.mirrorWrites, [saved.note.id]);

  await flush();
  assert.equal(sent.filter((s) => s.channel === "note-added").length, 1);
  assert.equal(sent[0].data.id, saved.note.id);

  const got = await call("db-get-note", saved.note.id);
  assert.equal(got.title, "Title");

  const updated = await call("db-update-note", saved.note.id, { title: "T2" });
  assert.equal(updated.success, true);
  assert.equal(updated.note.title, "T2");
  await flush();
  assert.equal(sent.filter((s) => s.channel === "note-updated").length, 1);

  const listed = await call("db-get-notes", null, 100, null, null);
  assert.ok(listed.some((n: import("../../src/contracts/notes.ts").NoteItem) => n.id === saved.note.id));

  const found = await call("db-search-notes", "T2", 50, null, null);
  assert.ok(found.some((n: import("../../src/contracts/notes.ts").NoteItem) => n.id === saved.note.id));

  const spaceId = db.getPrivateSpaceId();
  const spaceNotes = await call("db-get-space-notes", spaceId, 50);
  assert.ok(spaceNotes.some((n: import("../../src/contracts/notes.ts").NoteItem) => n.id === saved.note.id));

  const deleted = await call("db-delete-note", saved.note.id);
  assert.deepEqual(deleted, { success: true });
  await flush();
  assert.equal(sent.filter((s) => s.channel === "note-deleted").length, 1);
  assert.equal((await call("db-get-note", saved.note.id)), null);
});

test("wrong-shaped arguments reject before touching the database", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { call, db, flush } = ctx;

  await assert.rejects(() => call("db-get-note", "not-a-number"));
  await assert.rejects(() => call("db-get-note", -5));
  await assert.rejects(() => call("db-save-note", 5, "body"));
  await assert.rejects(() => call("db-update-note", 1, { title: 42 }));
  // Unknown keys are stripped, not rejected — unknown-only resolves false below.
  const note = db.saveNote("Strip", "C").note;
  const mixed = await call("db-update-note", note.id, { title: "New", bogus: "x" });
  assert.equal(mixed.success, true);
  assert.equal(mixed.note.title, "New");
  // Unknown-only update parses to an empty object and fails in the DB layer.
  const unknownOnly = await call("db-update-note", note.id, { bogus: "x" });
  assert.deepEqual(unknownOnly, { success: false });
  // Drain this test's deferred broadcasts so its success events don't leak
  // into the next fixture's capture array.
  await flush();
});

test("missing note and failed deletes resolve without events or mirror calls", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { call, sent, effects, flush } = ctx;

  assert.equal(await call("db-get-note", 987654), null);
  const missing = await call("db-update-note", 987654, { title: "x" });
  assert.deepEqual(missing, { success: false, error: "Note not found" });
  const notDeleted = await call("db-delete-note", 987654);
  assert.deepEqual(notDeleted, { success: false });
  await flush();
  assert.equal(sent.length, 0);
  assert.equal(effects.mirrorWrites.length, 0);
  assert.equal((effects.mirrorDeletes || []).length, 0);
});

test("participants update triggers auto-label then speaker refresh, after mirror", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { db, flush: flushCtx } = ctx;
  const note = db.saveNote("P", "").note;

  const order: (string | number)[][] = [];

  // Rebuild handlers with tracing deps for exact ordering.
  const { registerNotesHandlers } = await loadModules();
  const db1 = ctx.db;
  const newHandlers = new Map();
  registerNotesHandlers(
    { handle: (channel, listener) => newHandlers.set(channel, listener) },
    {
      noteWrites: new NoteWriteService({
        database: db1,
        mirrorWrite: (n: import("../../src/contracts/notes.ts").NoteItem) => order.push(["mirror", n.id]),
        tryAutoLabelOneOnOne: (id: number) => order.push(["label", id]),
        refreshMeetingSpeakerConfigFromNote: (id: number, n: import("../../src/contracts/notes.ts").NoteItem) => order.push(["refresh", id, n.id]),
      }),
      getNote: (id) => db1.getNote(id),
      getNotes: (...a) => db1.getNotes(...a),
      getNotesForSpace: (...a) => db1.getNotesForSpace(...a),
      deleteNoteInternal: (id) => ctx.deleteCalls.push(id),
      searchNotes: (...a) => db1.searchNotes(...a),
      searchNoteContent: () => [],
      searchNoteTranscripts: () => [],
      getNoteTranscript: () => ({ note_id: 1, status: "absent", timeline: { unit: "ms", duration_ms: null, basis: "concatenated_recording_time", intentional_pauses: "excluded" }, speakers: [], text: null, segments: null, diagnostics: [] }),

    }
  );
  const traceCall = (channel: string, ...args: unknown[]) => newHandlers.get(channel)(null, ...args);

  const emptyString = await traceCall("db-update-note", note.id, { participants: "" });
  assert.equal(emptyString.success, true);
  assert.equal(order.length, 1, '"" does not trigger speaker callbacks');
  assert.deepEqual(order[0], ["mirror", note.id]);

  const emptyArray = await traceCall("db-update-note", note.id, { participants: "[]" });
  assert.equal(emptyArray.success, true);
  const kinds = order.slice(1).map(([kind]) => kind);
  assert.deepEqual(kinds, ["mirror", "label", "refresh"]);
  assert.equal(order[order.length - 2][0], "label");
  assert.equal(order[order.length - 1][0], "refresh");

  const nullParticipants = await traceCall("db-update-note", note.id, { participants: null });
  assert.equal(nullParticipants.success, true);
  assert.equal(order.length, 5, "null only adds the mirror write");
  assert.equal(order[4][0], "mirror");
  await flushCtx();
});

test("folder-only update via IPC matches the DB baseline cases", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { call, db, flush } = ctx;
  const spaceId = db.getPrivateSpaceId();
  db.createFolder("Meetings", spaceId);
  const folders = Object.fromEntries(db.getFolders(spaceId).map((f: ReturnType<Database["getFolders"]>[number]) => [f.name, f.id]));
  const note = db.saveNote("N", "").note;

  const moved = await call("db-update-note", note.id, { folder_id: folders.Meetings });
  assert.equal(moved.note.folder_id, folders.Meetings);
  assert.equal(moved.note.space_id, spaceId);

  const forced = await call("db-update-note", note.id, {
    folder_id: folders.Personal,
    space_id: spaceId,
  });
  assert.equal(forced.note.folder_id, folders.Personal);
  assert.equal(forced.note.space_id, spaceId);

  const failed = await call("db-update-note", note.id, { folder_id: 987654 });
  assert.deepEqual(failed, { success: false, error: "Folder not found" });
  const after = db.getNote(note.id);
  assert.equal(after.folder_id, folders.Personal);

  // The upload completion screen's "No folder" choice: a null folder_id is a
  // real destination (the space root), not a rejected value like 0.
  const cleared = await call("db-update-note", note.id, { folder_id: null });
  assert.equal(cleared.success, true);
  assert.equal(cleared.note.folder_id, null);
  assert.equal(cleared.note.space_id, spaceId);
  await flush();
});

test("exactly one broadcast per success and none on failure", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  const { call, sent, flush, db } = ctx;

  const saved = await call("db-save-note", "One", "");
  await flush();
  // Each fixture registers handlers on a fresh channel map; the sent array is
  // shared across tests in-process, so count only this test's broadcasts.
  const thisTest = sent.splice(0, sent.length);
  assert.equal(thisTest.length, 1);
  assert.equal(thisTest[0].channel, "note-added");

  await call("db-update-note", saved.note.id, {});
  await flush();
  assert.equal(sent.length, 0, "no-op update broadcasts nothing");

  await call("db-update-note", saved.note.id, { title: "One!" });
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "note-updated");

  await call("db-delete-note", saved.note.id);
  await flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].channel, "note-deleted");
  void db;
});

// Regression: a projection failure must not turn a committed edit into a
// failed IPC save, suppress its event, or skip participant configuration.
test("mirror failure preserves durable edits, events and participant callbacks", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t, new Error("Mirror folder unavailable"));
  if (!ctx) return;
  const saved = await ctx.call("db-save-note", "", "", "personal", null, null, null, null);
  assert.equal(saved.success, true);
  assert.equal(ctx.db.getNote(saved.note.id).content, "");
  const updated = await ctx.call("db-update-note", saved.note.id, { title: "Saved", participants: "[]" });
  assert.equal(updated.success, true);
  assert.equal(ctx.db.getNote(saved.note.id).title, "Saved");
  assert.deepEqual(ctx.effects.autoLabels, [saved.note.id]);
  assert.deepEqual(ctx.effects.speakerRefreshes, [[saved.note.id, saved.note.id]]);
  await ctx.flush();
  assert.deepEqual(ctx.sent.map((event) => event.channel), ["note-added", "note-updated"]);
});

test("a thrown database write publishes no event or mirror", async (t: import("node:test").TestContext) => {
  const ctx = await createFixture(t);
  if (!ctx) return;
  await assert.rejects(() => ctx.call("db-save-note", "N", "", "personal", null, null, null, 987654), /Space not found/);
  await ctx.flush();
  assert.deepEqual(ctx.sent, []);
  assert.deepEqual(ctx.effects.mirrorWrites, []);
});
