const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const test: typeof import("node:test") = require("node:test");

const { skipOrFail }: typeof import("./harness/nativeBinding.ts") = require("./harness/nativeBinding.ts");

const fs: typeof import("node:fs") = require("node:fs");

const os: typeof import("node:os") = require("node:os");

const path: typeof import("node:path") = require("node:path");

const Module = require("node:module");

type NoteItem = import("../../src/contracts/notes.ts").NoteItem;

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-notes-db-"));

const originalLoad = Module._load;

Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return {
      app: { getPath: () => userDataDir, getAppPath: () => process.cwd(), isReady: () => false },
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.ts");

test.after(() => {
  Module._load = originalLoad;
});

function createDb(t: import("node:test").TestContext) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-notes-db-"));

  try {
    return new DatabaseManager();
  } catch (error) {
    skipOrFail(t, error);

    return null;
  }
}

test("save returns the inserted note with nullable fields intact", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const result = db.saveNote("Title", "Body", "personal", "/tmp/src.mp3", 12.5);
  assert.equal(result.success, true);
  const note = result.note;
  assert.equal(note.title, "Title");
  assert.equal(note.content, "Body");
  assert.equal(note.note_type, "personal");
  assert.equal(note.source_file, "/tmp/src.mp3");
  assert.equal(note.audio_duration_seconds, 12.5);
  assert.equal(note.transcript, null);
  assert.equal(note.enhanced_content, null);
  assert.equal(note.enhancement_prompt, null);
  assert.equal(note.enhanced_at_content_hash, null);
  assert.equal(note.calendar_event_id, null);
  assert.equal(note.participants, null);
  assert.equal(note.diarization_enabled, null);
  assert.equal(note.expected_speaker_count, null);
  assert.equal(typeof note.id, "number");
  assert.equal(typeof note.created_at, "string");
  assert.equal(typeof note.updated_at, "string");
  db.close();
});

test("save keeps blank title and content", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const result = db.saveNote("", "");
  assert.equal(result.success, true);
  assert.equal(result.note.title, "");
  assert.equal(result.note.content, "");
  db.close();
});

test("getNote returns null for a missing id", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  assert.equal(db.getNote(424242), null);
  db.close();
});

test("update on a missing note reports failure without creating one", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const result = db.updateNote(424242, { title: "x" });
  assert.deepEqual(result, { success: false, error: "Note not found" });
  assert.equal(db.getNote(424242), null);
  db.close();
});

test("empty update and unknown-only update report failure without touching the note", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const note = db.saveNote("T", "C").note;
  const before = db.getNote(note.id);

  assert.deepEqual(db.updateNote(note.id, {}), { success: false });
  assert.deepEqual(db.updateNote(note.id, { client_note_id: "nope", cloud_id: "x" }), {
    success: false,
  });
  assert.deepEqual(db.getNote(note.id), before);
  db.close();
});

test("update changes only whitelisted fields and accepts nullable columns", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const note = db.saveNote("T", "C", "personal", "/tmp/a.mp3", 5).note;

  const updated = db.updateNote(note.id, {
    title: "T2",
    transcript: '[{"text":"hi"}]',
    participants: '["a@b.c"]',
    diarization_enabled: 1,
    expected_speaker_count: 2,
    calendar_event_id: "evt-1",
    enhanced_content: "Better",
    enhancement_prompt: "prompt",
    enhanced_at_content_hash: "hash",
    client_note_id: "ignored",
  }).note;

  assert.equal(updated.title, "T2");
  assert.equal(updated.transcript, '[{"text":"hi"}]');
  assert.equal(updated.participants, '["a@b.c"]');
  assert.equal(updated.diarization_enabled, 1);
  assert.equal(updated.expected_speaker_count, 2);
  assert.equal(updated.calendar_event_id, "evt-1");
  assert.equal(updated.enhanced_content, "Better");
  assert.equal(updated.source_file, "/tmp/a.mp3");
  assert.equal(updated.audio_duration_seconds, 5);

  // Nullable columns can be cleared.
  const cleared = db.updateNote(note.id, {
    transcript: null,
    participants: null,
    diarization_enabled: null,
    expected_speaker_count: null,
    calendar_event_id: null,
    source_file: null,
    audio_duration_seconds: null,
  }).note;

  assert.equal(cleared.transcript, null);
  assert.equal(cleared.participants, null);
  assert.equal(cleared.diarization_enabled, null);
  assert.equal(cleared.expected_speaker_count, null);
  assert.equal(cleared.calendar_event_id, null);
  assert.equal(cleared.source_file, null);
  assert.equal(cleared.audio_duration_seconds, null);
  db.close();
});

test("update can change note_type and keeps previously stored values", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const note = db.saveNote("T", "C").note;
  const updated = db.updateNote(note.id, { note_type: "meeting" }).note;
  assert.equal(updated.note_type, "meeting");
  const custom = db.saveNote("U", "", "voice-memo").note;
  assert.equal(db.updateNote(custom.id, { note_type: "upload" }).note.note_type, "upload");
  assert.equal(db.getNote(custom.id).note_type, "upload");
  db.close();
});

test("getNotes with a space filters to root notes; getNotesForSpace includes foldered notes", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const spaceId = db.getPrivateSpaceId();
  const folderId = db.createFolder("Meetings", spaceId).folder.id;
  const folderNote = db.saveNote("InFolder", "", "meeting", null, null, folderId, null).note;
  // Notes without a folder live at the space root.
  const rootNote = db.saveNote("Root", "", "personal", null, null, null, spaceId).note;
  assert.ok(db.updateNote(rootNote.id, { folder_id: null }).success);

  const rootNotes = db.getNotes(null, 100, null, spaceId);
  assert.ok(rootNotes.some((n: NoteItem) => n.id === rootNote.id));
  assert.ok(!rootNotes.some((n: NoteItem) => n.id === folderNote.id));

  const spaceNotes = db.getNotesForSpace(spaceId);
  assert.ok(spaceNotes.some((n: NoteItem) => n.id === rootNote.id));
  assert.ok(spaceNotes.some((n: NoteItem) => n.id === folderNote.id));
  db.close();
});

test("save keeps notes at the space root unless a folder is passed", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const spaceId = db.getPrivateSpaceId();
  db.createFolder("Meetings", spaceId);
  const folders = Object.fromEntries(db.getFolders(spaceId).map((f: any) => [f.name, f.id]));

  const meeting = db.saveNote("M", "", "meeting").note;
  const personal = db.saveNote("P", "", "personal").note;
  assert.equal(meeting.folder_id, null);
  assert.equal(meeting.space_id, spaceId);
  assert.equal(personal.folder_id, null);

  const moved = db.saveNote("X", "", "personal", null, null, folders.Meetings, null).note;
  assert.equal(moved.folder_id, folders.Meetings);
  assert.equal(moved.space_id, spaceId);
  db.close();
});

test("folder-only update derives the space; explicit space_id wins; missing folder fails cleanly", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const spaceId = db.getPrivateSpaceId();
  db.createFolder("Meetings", spaceId);
  const folders = Object.fromEntries(db.getFolders(spaceId).map((f: any) => [f.name, f.id]));
  const note = db.saveNote("N", "", "personal").note;

  const moved = db.updateNote(note.id, { folder_id: folders.Meetings }).note;
  assert.equal(moved.folder_id, folders.Meetings);
  assert.equal(moved.space_id, spaceId);

  const forced = db.updateNote(note.id, { folder_id: folders.Personal, space_id: spaceId }).note;
  assert.equal(forced.folder_id, folders.Personal);
  assert.equal(forced.space_id, spaceId);

  const failed = db.updateNote(note.id, { folder_id: 987654 });
  assert.deepEqual(failed, { success: false, error: "Folder not found" });
  const unchanged = db.getNote(note.id);
  assert.equal(unchanged.folder_id, folders.Personal);
  assert.equal(unchanged.space_id, spaceId);
  db.close();
});

test("a note can sit in several folders: listed, counted and searched in each", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const spaceId = db.getPrivateSpaceId();
  db.createFolder("Meetings", spaceId);
  const folders = Object.fromEntries(db.getFolders(spaceId).map((f: any) => [f.name, f.id]));
  const extra = db.createFolder("Clients", spaceId).folder.id;
  const note = db.saveNote("Kickoff call", "", "meeting", null, null, folders.Meetings).note;
  assert.deepEqual(note.folder_ids, [folders.Meetings]);

  const linked = db.updateNote(note.id, { folder_ids: [extra, folders.Meetings] }).note;
  assert.equal(linked.folder_id, folders.Meetings, "the current primary stays primary");
  assert.deepEqual(linked.folder_ids, [folders.Meetings, extra]);

  assert.deepEqual(
    db.getNotes(null, 50, extra).map((n: NoteItem) => n.id),
    [note.id]
  );
  assert.deepEqual(
    db.getNotes(null, 50, folders.Meetings).map((n: NoteItem) => n.id),
    [note.id]
  );
  assert.deepEqual(db.getNoteIdsInFolder(extra), [note.id]);
  assert.deepEqual(
    db.searchNotes("Kickoff", 50, null, extra).map((n: NoteItem) => n.id),
    [note.id]
  );
  const counts = db.getFolderNoteCounts();
  const countFor = (id: number) => counts.find((c: any) => c.folder_id === id)?.count;
  assert.equal(countFor(extra), 1);
  assert.equal(countFor(folders.Meetings), 1);

  const unticked = db.updateNote(note.id, { folder_ids: [extra] }).note;
  assert.equal(unticked.folder_id, extra, "dropping the primary promotes the next folder");
  assert.deepEqual(unticked.folder_ids, [extra]);

  const none = db.updateNote(note.id, { folder_ids: [] }).note;
  assert.equal(none.folder_id, null);
  assert.deepEqual(none.folder_ids, []);

  assert.deepEqual(db.updateNote(note.id, { folder_ids: [987654] }), {
    success: false,
    error: "Folder not found",
  });
  db.close();
});

test("deleting a note's primary folder promotes one of its other folders", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const spaceId = db.getPrivateSpaceId();
  const first = db.createFolder("First", spaceId).folder.id;
  const second = db.createFolder("Second", spaceId).folder.id;
  const note = db.saveNote("N", "", "personal", null, null, first, null).note;
  db.updateNote(note.id, { folder_ids: [first, second] });

  db.deleteFolder(first);
  const after = db.getNote(note.id);
  assert.equal(after.folder_id, second);
  assert.deepEqual(after.folder_ids, [second]);
  db.close();
});

test("moving the primary folder onto an extra folder does not list the note twice", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const spaceId = db.getPrivateSpaceId();
  db.createFolder("Meetings", spaceId);
  const folders = Object.fromEntries(db.getFolders(spaceId).map((f: any) => [f.name, f.id]));
  const note = db.saveNote("N", "", "personal").note;
  db.updateNote(note.id, { folder_ids: [folders.Personal, folders.Meetings] });
  const moved = db.updateNote(note.id, { folder_id: folders.Meetings }).note;
  assert.deepEqual(moved.folder_ids, [folders.Meetings]);
  db.close();
});

test("delete reports success once and the note disappears", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const note = db.saveNote("D", "").note;
  assert.deepEqual(db.deleteNote(note.id), { success: true });
  assert.deepEqual(db.deleteNote(note.id), { success: false });
  assert.equal(db.getNote(note.id), null);
  db.close();
});

test("searchNotes returns [] for an empty query and keeps space/folder filters", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  assert.deepEqual(db.searchNotes(""), []);
  assert.deepEqual(db.searchNotes("   "), []);

  const spaceId = db.getPrivateSpaceId();
  db.createFolder("Meetings", spaceId);
  const folders = Object.fromEntries(db.getFolders(spaceId).map((f: any) => [f.name, f.id]));

  const hit = db.saveNote(
    "Quarterly Roadmap",
    "unique_zebra_content",
    "personal",
    null,
    null,
    folders.Personal
  ).note;

  db.saveNote("Unrelated", "nothing to see");

  assert.ok(db.searchNotes("zebra").some((n: NoteItem) => n.id === hit.id));
  assert.deepEqual(db.searchNotes("zebra", 50, 987654), []);
  assert.deepEqual(db.searchNotes("zebra", 50, null, 987654), []);
  assert.ok(db.searchNotes("zebra", 50, spaceId).some((n: NoteItem) => n.id === hit.id));
  assert.ok(
    db.searchNotes("zebra", 50, null, folders.Personal).some((n: NoteItem) => n.id === hit.id)
  );
  db.close();
});
