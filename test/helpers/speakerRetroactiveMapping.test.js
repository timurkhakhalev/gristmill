const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-retro-db-"));
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const IPCHandlers = require(handlersModulePath);
const Ctor = IPCHandlers.default || IPCHandlers;
const DatabaseManager = require("../../src/helpers/database.ts");

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-retro-db-"));
  try {
    return new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

// Float32-LE buffers, the storage format the retroactive path reads back.
function embedding(values) {
  return Buffer.from(new Float32Array(values).buffer);
}

async function runRetroactive(db, profile) {
  Ctor.prototype._retroactiveMapping.call({ databaseManager: db }, profile);
  await new Promise((resolve) => setImmediate(() => setTimeout(resolve, 0)));
}

function unmappedNote(db, transcriptSegments, embeddingValues, speakerId = "SPEAKER_00") {
  const { note } = db.saveNote("Meeting", "content");
  db.setSpeakerMapping(note.id, speakerId, null, speakerId);
  if (transcriptSegments) {
    db.updateNote(note.id, { transcript: JSON.stringify(transcriptSegments) });
  }
  db.saveNoteSpeakerEmbeddings(note.id, [{ speakerId, embedding: embedding(embeddingValues) }]);
  return db.getNote(note.id);
}

test("retroactive mapping saves a profile mapping for an unmapped matching speaker", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const profile = db.upsertSpeakerProfile("Alice", null, embedding([1, 0.2, 0]));
  const note = unmappedNote(db, [{ speaker: "SPEAKER_00", text: "hello" }], [1, 0.2, 0]);

  await runRetroactive(db, profile);

  const mappings = db.getSpeakerMappings(note.id);
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0].profile_id, profile.id);
  assert.equal(mappings[0].display_name, "Alice");

  const segments = JSON.parse(db.getNote(note.id).transcript);
  assert.equal(segments[0].speakerName, "Alice");
  assert.equal(segments[0].speakerIsPlaceholder, false);
});

test("retroactive mapping covers several unmapped notes in one run", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const profile = db.upsertSpeakerProfile("Bob", null, embedding([0, 1, 0]));
  const noteA = unmappedNote(db, null, [0, 1, 0]);
  const noteB = unmappedNote(db, null, [0, 0.9, 0.1], "SPEAKER_01");

  await runRetroactive(db, profile);

  assert.equal(db.getSpeakerMappings(noteA.id)[0].profile_id, profile.id);
  assert.equal(db.getSpeakerMappings(noteB.id)[0].profile_id, profile.id);
});

test("retroactive mapping leaves a note untouched when no embedding matches", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const profile = db.upsertSpeakerProfile("Carol", null, embedding([1, 0, 0]));
  // Orthogonal vector: cosine similarity 0, far below the 0.6 threshold.
  const note = unmappedNote(db, null, [0, 1, 0]);

  await runRetroactive(db, profile);

  const mappings = db.getSpeakerMappings(note.id);
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0].profile_id, null);
});

test("retroactive mapping never rewrites already-assigned mappings", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const profileA = db.upsertSpeakerProfile("Alice", null, embedding([1, 0, 0]));
  const profileB = db.upsertSpeakerProfile("Bob", null, embedding([0, 1, 0]));
  // SPEAKER_01 is already mapped to Bob; SPEAKER_00 is unmapped. Both
  // embeddings match Alice closely, but only the unmapped one may move.
  const note = unmappedNote(db, null, [1, 0, 0]);
  db.saveNoteSpeakerEmbeddings(note.id, [{ speakerId: "SPEAKER_01", embedding: embedding([1, 0, 0]) }]);
  db.setSpeakerMapping(note.id, "SPEAKER_01", profileB.id, "Bob");

  await runRetroactive(db, profileA);

  const mappings = db.getSpeakerMappings(note.id);
  const bySpeaker = new Map(mappings.map((m) => [m.speaker_id, m]));
  assert.equal(bySpeaker.get("SPEAKER_00").profile_id, profileA.id);
  assert.equal(bySpeaker.get("SPEAKER_01").profile_id, profileB.id);
  assert.equal(bySpeaker.get("SPEAKER_01").display_name, "Bob");
});

test.after(() => {
  Module._load = originalLoad;
});
