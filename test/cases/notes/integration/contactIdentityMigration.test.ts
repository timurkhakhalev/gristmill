const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const Database = require("better-sqlite3");
const { migrateContactIdentity } = require("../../../../src/helpers/contactIdentityMigration.ts");

function oldDatabase(t: import("node:test").TestContext, filename = ":memory:") {
  const db = new Database(filename);
  t.after(() => { if (db.open) db.close(); });
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE contacts(email TEXT PRIMARY KEY, display_name TEXT, people_name TEXT, learned_name TEXT, photo_url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE notes(id INTEGER PRIMARY KEY, participants TEXT, enhanced_content TEXT, source_file TEXT);
    CREATE TABLE meeting_recordings(id TEXT PRIMARY KEY, note_id INTEGER REFERENCES notes(id));
    CREATE TABLE meeting_processing_runs(id TEXT PRIMARY KEY, recording_id TEXT REFERENCES meeting_recordings(id), llm_source_snapshot_json TEXT);
    CREATE TABLE speaker_profiles(id INTEGER PRIMARY KEY, email TEXT, display_name TEXT, embedding BLOB, sample_count INTEGER);
    CREATE TABLE speaker_mappings(note_id INTEGER REFERENCES notes(id), profile_id INTEGER REFERENCES speaker_profiles(id) ON DELETE SET NULL);
    CREATE TABLE meeting_run_speaker_corrections(run_id TEXT REFERENCES meeting_processing_runs(id), speaker_id TEXT, profile_id INTEGER REFERENCES speaker_profiles(id) ON DELETE SET NULL, participant_email TEXT, display_name TEXT, source TEXT, revision INTEGER);
    INSERT INTO contacts(email,display_name,people_name,learned_name,photo_url) VALUES ('known@example.com','Invite Sample','People Sample','Learned Sample','https://example.com/avatar.png');
    INSERT INTO notes VALUES (1,'[{"email":" Known@Example.com ","displayName":"Historical Sample","responseStatus":"accepted","self":false},42,{"email":"","displayName":"Twin Sample"},{"displayName":"Twin Sample"},{"email":"orphan@example.com","displayName":"Orphan Sample"}]','Saved summary',NULL);
    INSERT INTO notes VALUES (2,'broken JSON',NULL,NULL);
    INSERT INTO notes VALUES (3,'[]',NULL,NULL);
    INSERT INTO notes VALUES (4,'[]',NULL,NULL);
    INSERT INTO notes VALUES (5,'[{"email":"known@example.com","displayName":"Imported Synthetic"}]',NULL,'granola:old-synthetic');
    INSERT INTO notes VALUES (6,'[]',NULL,'other:synthetic');
    INSERT INTO meeting_recordings VALUES ('recording',1),('snapshot-recording',3);
    INSERT INTO meeting_processing_runs VALUES ('run','recording',NULL),('snapshot-run','snapshot-recording','{"unchanged":true}');
    INSERT INTO speaker_profiles VALUES (17,'known@example.com','Voice Sample',X'010203',7),(19,NULL,'Unbound Voice',X'0405',2);
    INSERT INTO speaker_mappings VALUES (1,17);
    INSERT INTO meeting_run_speaker_corrections VALUES ('run','speaker_1',17,'orphan@example.com','Manual Sample','user',9);
  `);
  return db;
}

test("migration preserves historical snapshots, invalid entries and all voice-history references", (t: import("node:test").TestContext) => {
  const fs = require("node:fs");
  const path = require("node:path");
  const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "gristmill-contact-migration-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "synthetic.db");
  const db = oldDatabase(t, filename);
  migrateContactIdentity(db);
  const roster = JSON.parse(db.prepare("SELECT participants FROM notes WHERE id=1").get().participants);
  assert.equal(roster[0].displayName, "Historical Sample");
  assert.equal(roster[0].email, " Known@Example.com ");
  assert.equal(roster[1], 42);
  assert.equal(roster[2].email, null);
  assert.equal(roster[3].email, null);
  assert.notEqual(roster[2].contactId, roster[3].contactId);
  const known = db.prepare("SELECT * FROM contacts WHERE email='known@example.com'").get();
  assert.equal(roster[0].contactId, known.id);
  assert.equal(known.learned_name, "Learned Sample");
  assert.deepEqual(db.prepare("SELECT id,contact_id,hex(embedding) AS embedding,sample_count FROM speaker_profiles ORDER BY id").all(), [{ id:17,contact_id:known.id,embedding:"010203",sample_count:7 },{ id:19,contact_id:null,embedding:"0405",sample_count:2 }]);
  assert.equal(db.prepare("SELECT profile_id FROM speaker_mappings").get().profile_id,17);
  const correction = db.prepare("SELECT * FROM meeting_run_speaker_corrections").get();
  assert.equal(correction.profile_id,17);
  assert.equal(correction.participant_contact_id,roster[4].contactId);
  assert.equal(correction.participant_email,"orphan@example.com");
  assert.equal(correction.revision,9);
  assert.equal(db.prepare("SELECT participants FROM notes WHERE id=2").get().participants,"broken JSON");
  assert.deepEqual(db.prepare("SELECT participant_context_frozen AS frozen FROM notes ORDER BY id").all(),[{frozen:1},{frozen:0},{frozen:1},{frozen:0},{frozen:1},{frozen:0}]);
  const before = db.prepare("SELECT * FROM contacts").all();
  migrateContactIdentity(db);
  assert.deepEqual(db.prepare("SELECT * FROM contacts").all(),before);
  assert.deepEqual(db.pragma("foreign_key_check"),[]);
  assert.equal(db.pragma("foreign_keys",{simple:true}),1);
  db.close();
  const reopened = new Database(filename);
  t.after(() => reopened.close());
  reopened.pragma("foreign_keys = ON");
  migrateContactIdentity(reopened);
  assert.deepEqual(reopened.prepare("SELECT * FROM contacts").all(),before);
  assert.equal(reopened.prepare("SELECT profile_id FROM speaker_mappings").get().profile_id,17);
  assert.equal(reopened.prepare("SELECT profile_id FROM meeting_run_speaker_corrections").get().profile_id,17);
});

for (const point of ["middle", "integrity"]) test(`migration rolls back ${point} failure with foreign keys enabled`, (t: import("node:test").TestContext) => {
  const db = oldDatabase(t);
  const before = db.prepare("SELECT * FROM contacts").all();
  const adapter = {
    transaction: db.transaction.bind(db), prepare: db.prepare.bind(db),
    exec(sql: string) { if (point === "middle" && sql.includes("DROP COLUMN email")) throw new Error("injected failure"); return db.exec(sql); },
    pragma(sql: string) { return point === "integrity" && sql === "foreign_key_check" ? [{table:"synthetic violation"}] : db.pragma(sql); },
  };
  assert.throws(() => migrateContactIdentity(adapter));
  assert.deepEqual(db.prepare("SELECT * FROM contacts").all(),before);
  assert.equal(db.prepare("SELECT email FROM speaker_profiles WHERE id=17").get().email,"known@example.com");
  assert.equal(db.prepare("SELECT profile_id FROM speaker_mappings").get().profile_id,17);
  assert.equal(db.pragma("foreign_keys",{simple:true}),1);
  assert.deepEqual(db.pragma("foreign_key_check"),[]);
});

for (const missing of ["both", "profiles", "corrections"]) test(`startup upgrades email contacts with missing speaker tables: ${missing}`, (t: import("node:test").TestContext) => {
  const { createDb, DatabaseManager } = require("../../../helpers/harness/db.ts");
  const initial = createDb(t);
  if (!initial) return;
  const note = initial.saveNote("Synthetic historic meeting", "Saved synthetic content", "meeting").note;
  const roster = JSON.stringify([{ email: "historic@example.com", displayName: "Historical Synthetic" }]);
  initial.db.prepare("UPDATE notes SET participants = ?, source_file = 'granola:historic-synthetic' WHERE id = ?").run(roster, note.id);
  initial.db.exec(`
    DROP TABLE contacts;
    CREATE TABLE contacts(email TEXT PRIMARY KEY, display_name TEXT, people_name TEXT, learned_name TEXT, photo_url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO contacts(email, display_name) VALUES ('historic@example.com', 'Current Synthetic');
  `);
  if (missing === "both" || missing === "profiles") initial.db.exec("DROP TABLE speaker_profiles");
  else initial.db.exec("ALTER TABLE speaker_profiles DROP COLUMN contact_id; ALTER TABLE speaker_profiles ADD COLUMN email TEXT");
  if (missing === "both" || missing === "corrections") initial.db.exec("DROP TABLE meeting_run_speaker_corrections");
  else initial.db.exec("ALTER TABLE meeting_run_speaker_corrections DROP COLUMN participant_contact_id");
  initial.close();
  const upgraded = new DatabaseManager();
  t.after(() => upgraded.close());
  const contact = upgraded.db.prepare("SELECT id, email FROM contacts").get();
  assert.equal(contact.email, "historic@example.com");
  assert.ok(contact.id > 0);
  assert.deepEqual(JSON.parse(upgraded.getNote(note.id).participants), [{ contactId: contact.id, email: "historic@example.com", displayName: "Historical Synthetic" }]);
  assert.equal(upgraded.getNote(note.id).content, "Saved synthetic content");
  const migratedRoster = upgraded.getNote(note.id).participants;
  assert.ok(upgraded.updateContact(contact.id, { displayName: "Later Synthetic", email: "later-historic@example.com", telegramUsername: null }).success);
  assert.equal(upgraded.freezeParticipantContext(note.id).participants, migratedRoster);
  assert.deepEqual(upgraded.db.pragma("foreign_key_check"), []);
  assert.equal(upgraded.db.pragma("foreign_keys", { simple: true }), 1);
  upgraded.close();
  const reopened = new DatabaseManager();
  t.after(() => reopened.close());
  assert.equal(reopened.db.prepare("SELECT id FROM contacts").get().id, contact.id);
  assert.equal(reopened.freezeParticipantContext(note.id).participants, migratedRoster);
  assert.deepEqual(reopened.db.pragma("foreign_key_check"), []);
});
