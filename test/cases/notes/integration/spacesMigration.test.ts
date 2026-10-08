const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test") = require("node:test");
const Database = require("better-sqlite3");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { migrateSpaces } = require("../../../../src/helpers/spacesMigration.ts");

test("old spaces flatten without losing notes, folders, links or chats", (t: import("node:test").TestContext) => {
  const db = new Database(":memory:");

  try {
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE spaces (
        id INTEGER PRIMARY KEY, name TEXT, emoji TEXT, kind TEXT NOT NULL DEFAULT 'private',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE folders (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0, space_id INTEGER NOT NULL REFERENCES spaces(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, icon TEXT, color TEXT,
        UNIQUE (space_id, name)
      );
      CREATE TABLE notes (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'Untitled Note',
        content TEXT NOT NULL DEFAULT '', note_type TEXT NOT NULL DEFAULT 'personal',
        source_file TEXT, audio_duration_seconds REAL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        enhanced_content TEXT, enhancement_prompt TEXT, enhanced_at_content_hash TEXT,
        folder_id INTEGER REFERENCES folders(id),
        space_id INTEGER NOT NULL REFERENCES spaces(id),
        transcript TEXT, calendar_event_id TEXT, participants TEXT,
        diarization_enabled INTEGER, expected_speaker_count INTEGER, icon TEXT
      );
      CREATE TABLE note_folders (
        note_id INTEGER REFERENCES notes(id), folder_id INTEGER REFERENCES folders(id),
        PRIMARY KEY (note_id, folder_id)
      );
      CREATE TABLE agent_conversations (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'Untitled',
        note_id INTEGER REFERENCES notes(id), space_id INTEGER REFERENCES spaces(id),
        folder_id INTEGER REFERENCES folders(id), archived_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE agent_messages (
        id INTEGER PRIMARY KEY, conversation_id INTEGER REFERENCES agent_conversations(id),
        role TEXT NOT NULL DEFAULT 'user', content TEXT NOT NULL,
        metadata TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE VIRTUAL TABLE notes_fts USING fts5(
        title, content, enhanced_content, content='notes', content_rowid='id'
      );
      INSERT INTO spaces (id, name) VALUES (1, 'Personal'), (2, 'Older');
      INSERT INTO folders (id, name, space_id) VALUES
        (10, 'Work', 1), (11, 'Work', 2), (12, 'Extra', 2);
      INSERT INTO notes (id, title, content, folder_id, space_id) VALUES
        (100, 'First', 'alpha', 10, 1), (101, 'Second', 'beta', 11, 2);
      INSERT INTO note_folders VALUES (101, 12);
      INSERT INTO agent_conversations (id, title, note_id, space_id, folder_id) VALUES
        (200, 'Questions', 101, 2, 11);
      INSERT INTO agent_messages (id, conversation_id, content) VALUES (300, 200, 'hello');
    `);

    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-space-migration-"));
    const filename = process.env.GRISTMILL_CHANNEL === "development" ? "transcriptions-dev.db" : "transcriptions.db";
    db.exec(`VACUUM INTO '${path.join(profile, filename).replaceAll("'", "''")}'`);
    t.after(() => fs.rmSync(profile, { recursive: true, force: true }));

    migrateSpaces(db);

    const originalLoad = Module._load;
    Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
      if (request === "electron")
        return { app: { getPath: () => profile, getAppPath: () => process.cwd(), isReady: () => false } };

      return originalLoad.call(this, request, parent, isMain);
    };
    t.after(() => { Module._load = originalLoad; });

    const DatabaseManager = require("../../../../src/helpers/database.ts").DatabaseManager;
    const manager = new DatabaseManager();
    t.after(() => manager.close());
    assert.deepEqual(manager.getFolders().map((folder: { id: number; name: string }) => [folder.id, folder.name]), [
      [10, "Work"], [11, "Work (2)"], [12, "Extra"],
    ]);
    assert.equal(manager.getNote(101)?.title, "Second");
    assert.equal(manager.getAgentConversation(200)?.messages[0]?.content, "hello");

    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'spaces'").get(), undefined);
    assert.deepEqual(db.prepare("SELECT id, name FROM folders ORDER BY id").all(), [
      { id: 10, name: "Work" },
      { id: 11, name: "Work (2)" },
      { id: 12, name: "Extra" },
    ]);
    assert.deepEqual(db.prepare("SELECT id, folder_id FROM notes ORDER BY id").all(), [
      { id: 100, folder_id: 10 },
      { id: 101, folder_id: 11 },
    ]);
    assert.deepEqual(db.prepare("SELECT * FROM note_folders").all(), [
      { note_id: 101, folder_id: 12 },
    ]);
    assert.deepEqual(db.prepare("SELECT id, note_id, folder_id FROM agent_conversations").all(), [
      { id: 200, note_id: 101, folder_id: 11 },
    ]);
    assert.equal(db.prepare("SELECT content FROM agent_messages WHERE id = 300").get().content, "hello");
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.deepEqual(db.prepare("SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'beta'").all(), [
      { rowid: 101 },
    ]);

    migrateSpaces(db);
  } finally {
    db.close();
  }
});
