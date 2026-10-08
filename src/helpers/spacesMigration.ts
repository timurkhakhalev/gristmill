import type { SqliteDatabase } from "./database.js";

/** Flatten the old private containers while keeping note, folder and chat IDs. */
export function migrateSpaces(db: SqliteDatabase): void {
  const noteColumns = db.pragma<Array<{ name: string }>>("table_info(notes)");

  if (!noteColumns.some((column) => column.name === "space_id")) return;

  db.pragma("foreign_keys = OFF");

  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE folders_next (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          is_default INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          icon TEXT,
          color TEXT
        );

        CREATE TABLE notes_next (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL DEFAULT 'Untitled Note',
          content TEXT NOT NULL DEFAULT '',
          note_type TEXT NOT NULL DEFAULT 'personal',
          source_file TEXT,
          audio_duration_seconds REAL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          enhanced_content TEXT,
          enhancement_prompt TEXT,
          enhanced_at_content_hash TEXT,
          folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
          transcript TEXT,
          calendar_event_id TEXT,
          participants TEXT,
          diarization_enabled INTEGER,
          expected_speaker_count INTEGER,
          icon TEXT
        );

        CREATE TABLE agent_conversations_next (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL DEFAULT 'Untitled',
          note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
          folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
          archived_at DATETIME,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Old profiles can have several private containers. Folder names used
      // to be unique per container; keep every folder and disambiguate names.
      const folders = db
        .prepare(
          "SELECT id, name, is_default, sort_order, created_at, updated_at, icon, color FROM folders ORDER BY id"
        )
        .all<{
          id: number;
          name: string;
          is_default: number;
          sort_order: number;
          created_at: string;
          updated_at: string;
          icon: string | null;
          color: string | null;
        }>();

      const reservedNames = new Set(folders.map((folder) => folder.name));
      const usedNames = new Set<string>();

      const insertFolder = db.prepare(
        "INSERT INTO folders_next (id, name, is_default, sort_order, created_at, updated_at, icon, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );

      for (const folder of folders) {
        let name = folder.name;

        if (usedNames.has(name)) {
          let suffix = 2;

          while (reservedNames.has(`${name} (${suffix})`)) suffix++;
          name = `${name} (${suffix})`;
          reservedNames.add(name);
        }

        usedNames.add(name);
        insertFolder.run(
          folder.id,
          name,
          folder.is_default,
          folder.sort_order,
          folder.created_at,
          folder.updated_at,
          folder.icon,
          folder.color
        );
      }

      db.exec(`
        INSERT INTO notes_next (
          id, title, content, note_type, source_file, audio_duration_seconds,
          created_at, updated_at, enhanced_content, enhancement_prompt,
          enhanced_at_content_hash, folder_id, transcript, calendar_event_id,
          participants, diarization_enabled, expected_speaker_count, icon
        ) SELECT
          id, title, content, note_type, source_file, audio_duration_seconds,
          created_at, updated_at, enhanced_content, enhancement_prompt,
          enhanced_at_content_hash, folder_id, transcript, calendar_event_id,
          participants, diarization_enabled, expected_speaker_count, icon
        FROM notes;

        INSERT INTO agent_conversations_next (
          id, title, note_id, folder_id, archived_at, created_at, updated_at
        ) SELECT
          id, title, note_id, folder_id, archived_at, created_at, updated_at
        FROM agent_conversations;

        DROP TABLE agent_conversations;
        DROP TABLE notes;
        DROP TABLE folders;
        DROP TABLE spaces;

        ALTER TABLE folders_next RENAME TO folders;
        ALTER TABLE notes_next RENAME TO notes;
        ALTER TABLE agent_conversations_next RENAME TO agent_conversations;

        CREATE INDEX idx_notes_folder ON notes(folder_id, updated_at);
        CREATE INDEX idx_conversations_note ON agent_conversations(note_id, updated_at);

        CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN
          INSERT INTO notes_fts(rowid, title, content, enhanced_content)
          VALUES (new.id, new.title, new.content, new.enhanced_content);
        END;
        CREATE TRIGGER notes_fts_update AFTER UPDATE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, content, enhanced_content)
          VALUES ('delete', old.id, old.title, old.content, old.enhanced_content);
          INSERT INTO notes_fts(rowid, title, content, enhanced_content)
          VALUES (new.id, new.title, new.content, new.enhanced_content);
        END;
        CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, content, enhanced_content)
          VALUES ('delete', old.id, old.title, old.content, old.enhanced_content);
        END;

        INSERT INTO notes_fts(notes_fts) VALUES ('rebuild');
      `);

      const invalid = db.pragma<Array<{ table: string }>>("foreign_key_check");

      if (invalid.length) throw new Error("Notes migration failed foreign key check");
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
