const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

const load = () => import("../../src/stores/noteListOps.ts");

type NoteItem = import("../../src/contracts/notes.ts").NoteItem;

const note = (id: number, folderId: number | null = 1): NoteItem => ({
  id,
  title: "",
  content: "",
  note_type: "text",
  source_file: null,
  audio_duration_seconds: null,
  created_at: "",
  updated_at: "",
  enhanced_content: null,
  enhancement_prompt: null,
  enhanced_at_content_hash: null,
  folder_id: folderId,
  folder_ids: folderId == null ? [] : [folderId],
  transcript: null,
  calendar_event_id: null,
  participants: null,
  diarization_enabled: null,
  expected_speaker_count: null,
});

test("removes the note from every container list that holds it", async () => {
  const { removeNoteFromLists } = await load();

  const state = {
    notesByContainer: {
      "f:1": [note(1), note(2)],
      "root": [note(2), note(3)],
    },
    notes: [note(1), note(2)],
    activeNoteId: null,
  };

  const result = removeNoteFromLists(state, 2);

  assert.equal(result.changed, true);
  assert.deepEqual(
    result.notesByContainer["f:1"].map((n) => n.id),
    [1]
  );
  assert.deepEqual(
    result.notesByContainer["root"].map((n) => n.id),
    [3]
  );
});

test("filters the flat notes list even when no container holds the note", async () => {
  // Regression: the container-model rewrite dropped the flat-list filter, so a
  // note present only in `notes` (e.g. a flat-only initializeNotes load)
  // survived deletion until an app reload (count updated, row stayed).
  const { removeNoteFromLists } = await load();

  const state = {
    notesByContainer: { "f:9": [note(7, 9)] },
    notes: [note(1), note(2)],
    activeNoteId: null,
  };

  const result = removeNoteFromLists(state, 2);

  assert.equal(result.changed, true);
  assert.deepEqual(
    result.notes.map((n) => n.id),
    [1]
  );
  // Untouched containers keep their identity.
  assert.equal(result.notesByContainer["f:9"], state.notesByContainer["f:9"]);
});

test("reassigns activeNoteId to the visible neighbor when the deleted note was active", async () => {
  const { removeNoteFromLists } = await load();

  const state = {
    notesByContainer: { "f:1": [note(1), note(2), note(3)] },
    notes: [note(1), note(2), note(3)],
    activeNoteId: 2,
  };

  const result = removeNoteFromLists(state, 2);

  assert.equal(result.activeNoteId, 3);
});

test("reassigns activeNoteId from the flat list when the note is in no container", async () => {
  const { removeNoteFromLists } = await load();

  const state = {
    notesByContainer: {},
    notes: [note(1), note(2), note(3)],
    activeNoteId: 3,
  };

  const result = removeNoteFromLists(state, 3);

  assert.equal(result.activeNoteId, 2);
  assert.deepEqual(
    result.notes.map((n) => n.id),
    [1, 2]
  );
});

test("no-ops when the note is nowhere", async () => {
  const { removeNoteFromLists } = await load();

  const state = {
    notesByContainer: { "f:1": [note(1)] },
    notes: [note(1)],
    activeNoteId: 1,
  };

  const result = removeNoteFromLists(state, 99);

  assert.equal(result.changed, false);
  assert.equal(result.activeNoteId, 1);
});

test("tears down multiple containers and clears an active note inside them", async () => {
  const { teardownNoteContainers } = await load();

  const state = {
    notesByContainer: {
      "root": [note(1, null)],
      "f:2": [note(2, 2)],
      "f:3": [note(3, null)],
    },
    expandedContainers: new Set(["root", "f:2", "f:3"]),
    activeNoteId: 2,
  };

  const result = teardownNoteContainers(state, ["root", "f:2"]);

  assert.deepEqual(Object.keys(result.notesByContainer), ["f:3"]);
  assert.deepEqual(
    result.removedNotes.map((n) => n.id),
    [1, 2]
  );
  assert.deepEqual([...result.expandedContainers], ["f:3"]);
  assert.equal(result.activeNoteId, null);
});

test("container teardown preserves active notes outside the removed containers", async () => {
  const { teardownNoteContainers } = await load();

  const state = {
    notesByContainer: {
      "f:1": [note(1)],
      "f:2": [note(2, 2)],
    },
    expandedContainers: new Set(["f:1", "f:2"]),
    activeNoteId: 2,
  };

  const result = teardownNoteContainers(state, ["f:1"]);

  assert.equal(result.notesByContainer["f:2"], state.notesByContainer["f:2"]);
  assert.equal(result.activeNoteId, 2);
});

test("account reset invalidates every in-flight keyed load generation", async () => {
  const { invalidateKeyedLoadGenerations } = await load();

  const generations = new Map([
    ["root", 2],
    ["f:8", 7],
  ]);

  invalidateKeyedLoadGenerations(generations);

  assert.deepEqual(
    [...generations],
    [
      ["root", 3],
      ["f:8", 8],
    ]
  );
});
