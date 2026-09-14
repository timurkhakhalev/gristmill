const Database = require("better-sqlite3");
const path = require("path");
const debugLogger = require("./debugLogger");
const { buildNoteSearchQuery } = require("./noteSearch");
const { normalizeStoredSpeakerCount } = require("./speakerCount");
const { parseEventTime } = require("./calendarAvailability");
const { toDbTimestamp } = require("./dbTimestamp");
const { BUILTIN_ACTIONS, GENERATE_NOTES_KEY } = require("./builtinActions");
const { app } = require("electron");

const MAX_SNIPPET_TRIGGER_LENGTH = 100;
const CALENDARS_TABLE_BY_PROVIDER = {
  google: "google_calendars",
  microsoft: "microsoft_calendars",
};
const CALENDAR_PROVIDERS = new Set(["google", "microsoft", "apple"]);

function dedupedEventsQuery(where) {
  return `SELECT * FROM (
    SELECT *, MAX(provider != 'apple') OVER (
      PARTITION BY datetime(start_time), datetime(end_time), COALESCE(summary, '')
    ) AS has_synced
    FROM calendar_events
    WHERE ${where}
  ) WHERE provider != 'apple' OR has_synced = 0 ORDER BY datetime(start_time) ASC`;
}

function stripDedupeColumn({ has_synced: _hasSynced, ...event }) {
  return event;
}

function selectedCalendarFilter() {
  return `(
    (provider = 'google' AND EXISTS (
      SELECT 1 FROM google_calendars
      WHERE google_calendars.id = calendar_events.calendar_id
        AND google_calendars.is_selected = 1
    )) OR
    (provider = 'microsoft' AND EXISTS (
      SELECT 1 FROM microsoft_calendars
      WHERE microsoft_calendars.id = calendar_events.calendar_id
        AND microsoft_calendars.is_selected = 1
    )) OR
    (provider = 'apple' AND EXISTS (
      SELECT 1 FROM apple_calendars
      WHERE apple_calendars.id = calendar_events.calendar_id
    ))
  )`;
}

function normalizeWords(words) {
  const result = new Map();
  for (const raw of Array.isArray(words) ? words : []) {
    if (typeof raw !== "string") continue;
    const word = raw.trim();
    if (word && !result.has(word.toLowerCase())) result.set(word.toLowerCase(), word);
  }
  return result;
}

class DatabaseManager {
  constructor() {
    this.db = null;
    this.initDatabase();
  }

  initDatabase() {
    try {
      const fileName =
        process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db";
      this.db = new Database(path.join(app.getPath("userData"), fileName));
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("journal_mode = WAL");

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS transcriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          raw_text TEXT,
          timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          has_audio INTEGER NOT NULL DEFAULT 0,
          audio_duration_ms INTEGER,
          provider TEXT,
          model TEXT,
          status TEXT NOT NULL DEFAULT 'completed',
          error_message TEXT,
          error_code TEXT,
          route_kind TEXT
        );

        CREATE TABLE IF NOT EXISTS custom_dictionary (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          word TEXT NOT NULL UNIQUE,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS snippets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trigger TEXT NOT NULL UNIQUE COLLATE NOCASE,
          replacement TEXT NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS spaces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          emoji TEXT,
          kind TEXT NOT NULL DEFAULT 'private' CHECK (kind = 'private'),
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS folders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          is_default INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (space_id, name)
        );

        CREATE TABLE IF NOT EXISTS notes (
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
          space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
          transcript TEXT,
          calendar_event_id TEXT,
          participants TEXT,
          diarization_enabled INTEGER,
          expected_speaker_count INTEGER
        );

        CREATE TABLE IF NOT EXISTS actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          prompt TEXT NOT NULL,
          icon TEXT NOT NULL DEFAULT 'sparkles',
          is_builtin INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          translation_key TEXT,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS agent_conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL DEFAULT 'Untitled',
          note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
          space_id INTEGER REFERENCES spaces(id) ON DELETE CASCADE,
          folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
          archived_at DATETIME,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS agent_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id INTEGER NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          metadata TEXT,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS google_calendar_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          google_email TEXT NOT NULL UNIQUE,
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          scope TEXT NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS google_calendars (
          id TEXT PRIMARY KEY,
          summary TEXT NOT NULL,
          description TEXT,
          background_color TEXT,
          is_selected INTEGER NOT NULL DEFAULT 1,
          is_primary INTEGER NOT NULL DEFAULT 0,
          sync_token TEXT,
          sync_token_expires_at INTEGER,
          account_email TEXT,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS microsoft_calendar_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          microsoft_email TEXT NOT NULL UNIQUE,
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          scope TEXT NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS microsoft_calendars (
          id TEXT PRIMARY KEY,
          summary TEXT NOT NULL,
          background_color TEXT,
          is_selected INTEGER NOT NULL DEFAULT 1,
          is_primary INTEGER NOT NULL DEFAULT 0,
          sync_token TEXT,
          sync_token_expires_at INTEGER,
          account_email TEXT,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS apple_calendars (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          color TEXT,
          source_name TEXT,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS calendar_events (
          id TEXT PRIMARY KEY,
          calendar_id TEXT NOT NULL,
          provider TEXT NOT NULL DEFAULT 'google',
          summary TEXT,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          is_all_day INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'confirmed',
          availability_status TEXT NOT NULL DEFAULT 'unknown',
          self_response_status TEXT NOT NULL DEFAULT 'unknown',
          hangout_link TEXT,
          conference_data TEXT,
          organizer_email TEXT,
          attendees_count INTEGER NOT NULL DEFAULT 0,
          attendees TEXT,
          synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS contacts (
          email TEXT PRIMARY KEY,
          display_name TEXT,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS speaker_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          display_name TEXT NOT NULL,
          email TEXT,
          embedding BLOB NOT NULL,
          sample_count INTEGER NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS speaker_mappings (
          note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          speaker_id TEXT NOT NULL,
          profile_id INTEGER REFERENCES speaker_profiles(id) ON DELETE SET NULL,
          display_name TEXT NOT NULL,
          PRIMARY KEY (note_id, speaker_id)
        );

        CREATE TABLE IF NOT EXISTS note_speaker_embeddings (
          note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          speaker_id TEXT NOT NULL,
          embedding BLOB NOT NULL,
          PRIMARY KEY (note_id, speaker_id)
        );

        CREATE INDEX IF NOT EXISTS idx_notes_space ON notes(space_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_messages_conversation ON agent_messages(conversation_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_conversations_note ON agent_conversations(note_id, updated_at);

        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
          title, content, enhanced_content,
          content='notes', content_rowid='id'
        );

        CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
          INSERT INTO notes_fts(rowid, title, content, enhanced_content)
          VALUES (new.id, new.title, new.content, new.enhanced_content);
        END;
        CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, content, enhanced_content)
          VALUES ('delete', old.id, old.title, old.content, old.enhanced_content);
          INSERT INTO notes_fts(rowid, title, content, enhanced_content)
          VALUES (new.id, new.title, new.content, new.enhanced_content);
        END;
        CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, content, enhanced_content)
          VALUES ('delete', old.id, old.title, old.content, old.enhanced_content);
        END;
      `);

      const existingSpace = this.db.prepare("SELECT id FROM spaces LIMIT 1").get();
      const spaceId = existingSpace?.id ?? Number(this.db
        .prepare("INSERT INTO spaces (name, kind, sort_order) VALUES ('Personal', 'private', 0)")
        .run().lastInsertRowid);
      if (!existingSpace) {
        const insertFolder = this.db.prepare(
          "INSERT INTO folders (name, is_default, sort_order, space_id) VALUES (?, 1, ?, ?)"
        );
        insertFolder.run("Personal", 0, spaceId);
        insertFolder.run("Meetings", 1, spaceId);
        insertFolder.run("Videos", 2, spaceId);
      }

      if (this.db.prepare("SELECT 1 FROM actions LIMIT 1").get() == null) {
        const insertAction = this.db.prepare(
          "INSERT INTO actions (name, description, prompt, icon, is_builtin, sort_order, translation_key) VALUES (?, ?, ?, ?, 1, ?, ?)"
        );
        for (const action of BUILTIN_ACTIONS) {
          insertAction.run(
            action.name,
            action.description,
            action.prompt,
            action.icon,
            action.sortOrder,
            action.translationKey
          );
        }
      }
      return true;
    } catch (error) {
      debugLogger.error("Database initialization failed", { error: error.message }, "database");
      throw error;
    }
  }

  _privateSpaceId() {
    return this.db.prepare("SELECT id FROM spaces WHERE kind = 'private' LIMIT 1").get()?.id ?? null;
  }

  getPrivateSpaceId() {
    return this._privateSpaceId();
  }

  _spaceRow(row) {
    return row ? { ...row, kind: "private" } : null;
  }

  getSpaces() {
    return this.db.prepare("SELECT * FROM spaces ORDER BY sort_order, id").all().map((row) => this._spaceRow(row));
  }

  getSpace(id) {
    return this._spaceRow(this.db.prepare("SELECT * FROM spaces WHERE id = ?").get(id));
  }

  updateSpace(id, { name, emoji } = {}) {
    const fields = [];
    const values = [];
    if (name !== undefined) { fields.push("name = ?"); values.push(name); }
    if (emoji !== undefined) { fields.push("emoji = ?"); values.push(emoji); }
    if (fields.length === 0) return { success: false };
    values.push(id);
    const result = this.db.prepare(`UPDATE spaces SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
    return { success: result.changes > 0, space: this.getSpace(id) };
  }

  getFolders(spaceId = null) {
    const sql = spaceId == null
      ? "SELECT * FROM folders ORDER BY sort_order, created_at"
      : "SELECT * FROM folders WHERE space_id = ? ORDER BY sort_order, created_at";
    return spaceId == null ? this.db.prepare(sql).all() : this.db.prepare(sql).all(spaceId);
  }

  createFolder(name, spaceId = null) {
    const trimmed = String(name || "").trim();
    spaceId ??= this._privateSpaceId();
    if (!trimmed) return { success: false, error: "Folder name is required" };
    if (!spaceId || !this.getSpace(spaceId)) return { success: false, error: "Space not found" };
    const max = this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS value FROM folders WHERE space_id = ?").get(spaceId).value;
    try {
      const result = this.db.prepare("INSERT INTO folders (name, sort_order, space_id) VALUES (?, ?, ?)").run(trimmed, max + 1, spaceId);
      return { success: true, folder: this.db.prepare("SELECT * FROM folders WHERE id = ?").get(result.lastInsertRowid) };
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return { success: false, error: "A folder with that name already exists" };
      throw error;
    }
  }

  renameFolder(id, name) {
    const trimmed = String(name || "").trim();
    if (!trimmed) return { success: false, error: "Folder name is required" };
    try {
      const result = this.db.prepare("UPDATE folders SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(trimmed, id);
      return { success: result.changes > 0, folder: this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id) };
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return { success: false, error: "A folder with that name already exists" };
      throw error;
    }
  }

  deleteFolder(id) {
    const result = this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
    return { success: result.changes > 0 };
  }

  moveFolderToSpace(id, spaceId) {
    if (!this.getSpace(spaceId)) return { success: false, error: "Space not found" };
    try {
      const result = this.db.transaction(() => {
        const folder = this.db.prepare("SELECT id FROM folders WHERE id = ?").get(id);
        if (!folder) return { changes: 0, notes: [] };
        const updated = this.db.prepare("UPDATE folders SET space_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(spaceId, id);
        this.db.prepare("UPDATE notes SET space_id = ?, updated_at = CURRENT_TIMESTAMP WHERE folder_id = ?").run(spaceId, id);
        const notes = this.db.prepare("SELECT * FROM notes WHERE folder_id = ?").all(id);
        return { changes: updated.changes, notes };
      })();
      return { success: result.changes > 0, folder: this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id), notes: result.notes };
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return { success: false, error: "A folder with that name already exists" };
      throw error;
    }
  }

  getFolderNoteCounts() {
    return this.db.prepare(`
      SELECT folder_id, space_id, COUNT(*) AS count
      FROM notes GROUP BY folder_id, space_id
    `).all();
  }

  getMeetingsFolder(spaceId = null) {
    spaceId ??= this._privateSpaceId();
    return this.db.prepare("SELECT * FROM folders WHERE space_id = ? AND name = 'Meetings' LIMIT 1").get(spaceId) || null;
  }

  saveTranscription(text, rawText = null, options = {}) {
    const { status = "completed", errorMessage = null, errorCode = null, routeKind = null } = options;
    const timestamp = toDbTimestamp(options.occurredAt) || null;
    const result = this.db.prepare(`
      INSERT INTO transcriptions (text, raw_text, status, error_message, error_code, route_kind, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
    `).run(text, rawText, status, errorMessage, errorCode, routeKind, timestamp);
    return { id: Number(result.lastInsertRowid), success: true, transcription: this.getTranscriptionById(result.lastInsertRowid) };
  }

  getTranscriptions(limit = 50, { includeDiscarded = false } = {}) {
    const filter = includeDiscarded ? "" : " WHERE status != 'discarded'";
    return this.db.prepare(`SELECT * FROM transcriptions${filter} ORDER BY timestamp DESC LIMIT ?`).all(limit);
  }

  clearTranscriptions() {
    const result = this.db.prepare("DELETE FROM transcriptions").run();
    return { success: true, cleared: result.changes };
  }

  deleteTranscriptionsExpiredBefore(retentionDays) {
    const cutoff = this.db.prepare("SELECT datetime('now', ?) AS cutoff").get(`-${retentionDays} days`).cutoff;
    const ids = this.db.prepare("SELECT id FROM transcriptions WHERE created_at < ?").all(cutoff).map((row) => row.id);
    this.db.prepare("DELETE FROM transcriptions WHERE created_at < ?").run(cutoff);
    return { ids };
  }

  deleteTranscription(id) {
    const result = this.db.prepare("DELETE FROM transcriptions WHERE id = ?").run(id);
    return { success: result.changes > 0, id };
  }

  updateTranscriptionAudio(id, { hasAudio, audioDurationMs, provider, model }) {
    this.db.prepare("UPDATE transcriptions SET has_audio = ?, audio_duration_ms = ?, provider = ?, model = ? WHERE id = ?").run(hasAudio ? 1 : 0, audioDurationMs, provider, model, id);
    return { success: true };
  }

  updateTranscriptionText(id, text, rawText) {
    this.db.prepare("UPDATE transcriptions SET text = ?, raw_text = ? WHERE id = ?").run(text, rawText, id);
    return { success: true };
  }

  updateTranscriptionStatus(id, status, errorMessage = null, errorCode = null) {
    this.db.prepare("UPDATE transcriptions SET status = ?, error_message = ?, error_code = ? WHERE id = ?").run(status, errorMessage, errorCode, id);
    return { success: true };
  }

  getTranscriptionById(id) {
    return this.db.prepare("SELECT * FROM transcriptions WHERE id = ?").get(id) || null;
  }

  clearAudioFlags(ids) {
    if (!ids?.length) return { success: true };
    const update = this.db.prepare("UPDATE transcriptions SET has_audio = 0 WHERE id = ?");
    this.db.transaction(() => ids.forEach((id) => update.run(id)))();
    return { success: true };
  }

  getDictionary() {
    return this.db.prepare("SELECT word FROM custom_dictionary ORDER BY id").all().map((row) => row.word);
  }

  setDictionary(words) {
    const incoming = normalizeWords(words);
    const current = this.db.prepare("SELECT id, word FROM custom_dictionary").all();
    const transaction = this.db.transaction(() => {
      const remove = this.db.prepare("DELETE FROM custom_dictionary WHERE id = ?");
      current.forEach((row) => { if (!incoming.has(row.word.toLowerCase())) remove.run(row.id); });
      const insert = this.db.prepare("INSERT OR IGNORE INTO custom_dictionary (word) VALUES (?)");
      incoming.forEach((word) => insert.run(word));
    });
    transaction();
    return { success: true };
  }

  applyDictionaryChanges({ add = [], remove = [] } = {}) {
    const additions = normalizeWords(add);
    const removals = normalizeWords(remove);
    const transaction = this.db.transaction(() => {
      const removeStmt = this.db.prepare("DELETE FROM custom_dictionary WHERE lower(word) = lower(?)");
      removals.forEach((word) => removeStmt.run(word));
      const addStmt = this.db.prepare("INSERT OR IGNORE INTO custom_dictionary (word) VALUES (?)");
      additions.forEach((word) => addStmt.run(word));
    });
    transaction();
    return { success: true, added: additions.size, removed: removals.size };
  }

  hardDeleteDictionaryEntry(id) {
    return { success: this.db.prepare("DELETE FROM custom_dictionary WHERE id = ?").run(id).changes > 0 };
  }

  getSnippets() {
    return this.db.prepare("SELECT trigger, replacement FROM snippets ORDER BY id").all();
  }

  setSnippets(snippets) {
    const incoming = new Map();
    for (const item of Array.isArray(snippets) ? snippets : []) {
      const trigger = typeof item?.trigger === "string" ? item.trigger.trim() : "";
      const replacement = typeof item?.replacement === "string" ? item.replacement.trim() : "";
      if (trigger && replacement && trigger.length <= MAX_SNIPPET_TRIGGER_LENGTH) incoming.set(trigger.toLowerCase(), { trigger, replacement });
    }
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM snippets").run();
      const insert = this.db.prepare("INSERT INTO snippets (trigger, replacement) VALUES (?, ?)");
      incoming.forEach(({ trigger, replacement }) => insert.run(trigger, replacement));
    });
    transaction();
    return { success: true };
  }

  hardDeleteSnippet(id) {
    return { success: this.db.prepare("DELETE FROM snippets WHERE id = ?").run(id).changes > 0 };
  }

  saveNote(title, content, noteType = "personal", sourceFile = null, audioDuration = null, folderId = null, spaceId = null) {
    spaceId ??= this._privateSpaceId();
    if (folderId != null) spaceId = this.db.prepare("SELECT space_id FROM folders WHERE id = ?").get(folderId)?.space_id;
    if (!spaceId || !this.getSpace(spaceId)) throw new Error("Space not found");
    if (folderId == null) {
      const folderName = noteType === "meeting" ? "Meetings" : "Personal";
      folderId = this.db.prepare("SELECT id FROM folders WHERE space_id = ? AND name = ? LIMIT 1").get(spaceId, folderName)?.id ?? null;
    }
    const result = this.db.prepare("INSERT INTO notes (title, content, note_type, source_file, audio_duration_seconds, folder_id, space_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(title, content, noteType, sourceFile, audioDuration, folderId, spaceId);
    return { success: true, note: this.getNote(result.lastInsertRowid) };
  }

  importNotes(rows, { noteType = "meeting", folderName = "Imported" } = {}) {
    const spaceId = this._privateSpaceId();
    let folderId = this.db.prepare("SELECT id FROM folders WHERE space_id = ? AND name = ?").get(spaceId, folderName)?.id;
    if (!folderId) folderId = this.createFolder(folderName, spaceId).folder?.id ?? null;
    let imported = 0;
    const noteIds = [];
    const errors = [];
    const insert = this.db.prepare("INSERT INTO notes (title, content, note_type, source_file, folder_id, space_id, transcript, participants, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))");
    this.db.transaction(() => {
      for (const row of Array.isArray(rows) ? rows : []) {
        try {
          const result = insert.run(row.title, row.content, noteType, row.sourceFile, folderId, spaceId, row.transcript, row.participants, row.createdAt, row.createdAt);
          imported += 1;
          noteIds.push(Number(result.lastInsertRowid));
        } catch (error) { errors.push({ error: error.message }); }
      }
    })();
    return { success: true, imported, skipped: 0, folderId, noteIds, errors };
  }

  getNote(id) { return this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) || null; }

  getNotes(noteType = null, limit = 100, folderId = null, spaceId = null) {
    const conditions = [];
    const params = [];
    if (noteType) { conditions.push("note_type = ?"); params.push(noteType); }
    if (folderId != null) { conditions.push("folder_id = ?"); params.push(folderId); }
    if (spaceId != null) { conditions.push("space_id = ?"); params.push(spaceId); if (folderId == null) conditions.push("folder_id IS NULL"); }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM notes${where} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit);
  }

  getNotesForSpace(spaceId, limit = 50) { return this.db.prepare("SELECT * FROM notes WHERE space_id = ? ORDER BY updated_at DESC LIMIT ?").all(spaceId, limit); }

  getNoteIdsInFolder(folderId) { return this.db.prepare("SELECT id FROM notes WHERE folder_id = ?").all(folderId).map((row) => row.id); }

  getNoteIdsInScope(spaceId = null, folderId = null, candidateIds = null) {
    const conditions = [];
    const params = [];
    if (spaceId != null) { conditions.push("space_id = ?"); params.push(spaceId); }
    if (folderId != null) { conditions.push("folder_id = ?"); params.push(folderId); }
    if (candidateIds) { if (!candidateIds.length) return []; conditions.push(`id IN (${candidateIds.map(() => "?").join(",")})`); params.push(...candidateIds); }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    return this.db.prepare(`SELECT id FROM notes${where}`).all(...params).map((row) => row.id);
  }

  updateNote(id, updates) {
    if (!this.getNote(id)) return { success: false, error: "Note not found" };
    const allowed = ["title", "content", "enhanced_content", "enhancement_prompt", "enhanced_at_content_hash", "folder_id", "space_id", "transcript", "calendar_event_id", "participants", "diarization_enabled", "expected_speaker_count", "source_file", "audio_duration_seconds", "note_type"];
    const fields = [];
    const values = [];
    for (const key of allowed) if (updates[key] !== undefined) { fields.push(`${key} = ?`); values.push(updates[key]); }
    if (updates.folder_id != null) {
      const folder = this.db.prepare("SELECT space_id FROM folders WHERE id = ?").get(updates.folder_id);
      if (!folder) return { success: false, error: "Folder not found" };
      if (updates.space_id === undefined) { fields.push("space_id = ?"); values.push(folder.space_id); }
    }
    if (!fields.length) return { success: false };
    values.push(id);
    const result = this.db.prepare(`UPDATE notes SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
    return { success: result.changes > 0, note: this.getNote(id) };
  }

  deleteNote(id) {
    const result = this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
    return { success: result.changes > 0 };
  }

  getFolderNoteCountsBySpace(spaceId) { return this.getFolderNoteCounts().filter((row) => row.space_id === spaceId); }

  getActions() { return this.db.prepare("SELECT * FROM actions ORDER BY sort_order, id").all(); }
  getAction(id) { return this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) || null; }
  createAction(name, description, prompt, icon = "sparkles") {
    const result = this.db.prepare("INSERT INTO actions (name, description, prompt, icon) VALUES (?, ?, ?, ?)").run(name, description, prompt, icon);
    return { success: true, action: this.getAction(result.lastInsertRowid) };
  }
  updateAction(id, updates) {
    const allowed = ["name", "description", "prompt", "icon", "sort_order"];
    const fields = [];
    const values = [];
    for (const key of allowed) if (updates[key] !== undefined) { fields.push(`${key} = ?`); values.push(updates[key]); }
    if (!fields.length) return { success: false };
    values.push(id);
    const result = this.db.prepare(`UPDATE actions SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
    return { success: result.changes > 0, action: this.getAction(id) };
  }
  deleteAction(id) { return { success: this.db.prepare("DELETE FROM actions WHERE id = ? AND is_builtin = 0").run(id).changes > 0 }; }

  createAgentConversation(title = "Untitled", noteId = null, spaceId = null, folderId = null) {
    const result = this.db.prepare("INSERT INTO agent_conversations (title, note_id, space_id, folder_id) VALUES (?, ?, ?, ?)").run(title, noteId, spaceId, folderId);
    return this.getAgentConversation(result.lastInsertRowid);
  }
  getAgentConversation(id) {
    const conversation = this.db.prepare("SELECT * FROM agent_conversations WHERE id = ?").get(id);
    return conversation ? { ...conversation, messages: this.getAgentMessages(id) } : null;
  }
  getAgentConversations(limit = 50) { return this.db.prepare("SELECT * FROM agent_conversations WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT ?").all(limit); }
  getConversationsForNote(noteId, limit = 20) { return this.db.prepare("SELECT * FROM agent_conversations WHERE note_id = ? ORDER BY updated_at DESC LIMIT ?").all(noteId, limit); }
  getConversationsForContainer(spaceId, folderId = null, limit = 20) {
    const fields = "c.*, (SELECT COUNT(*) FROM agent_messages m WHERE m.conversation_id = c.id) AS message_count";
    const sql = folderId == null ? `SELECT ${fields} FROM agent_conversations c WHERE c.space_id = ? AND c.folder_id IS NULL ORDER BY c.updated_at DESC LIMIT ?` : `SELECT ${fields} FROM agent_conversations c WHERE c.space_id = ? AND c.folder_id = ? ORDER BY c.updated_at DESC LIMIT ?`;
    return folderId == null ? this.db.prepare(sql).all(spaceId, limit) : this.db.prepare(sql).all(spaceId, folderId, limit);
  }
  addAgentMessage(conversationId, role, content, metadata) {
    if (!this.getAgentConversation(conversationId)) return null;
    const result = this.db.prepare("INSERT INTO agent_messages (conversation_id, role, content, metadata) VALUES (?, ?, ?, ?)").run(conversationId, role, content, metadata ? JSON.stringify(metadata) : null);
    this.db.prepare("UPDATE agent_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(conversationId);
    return this.db.prepare("SELECT * FROM agent_messages WHERE id = ?").get(result.lastInsertRowid);
  }
  getAgentMessages(conversationId) { return this.db.prepare("SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY created_at").all(conversationId); }
  getAgentConversationsWithPreview(limit = 50, offset = 0, includeArchived = false) {
    const archive = includeArchived ? "" : "WHERE c.archived_at IS NULL";
    return this.db.prepare(`SELECT c.*, (SELECT content FROM agent_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS preview FROM agent_conversations c ${archive} ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
  }
  searchAgentConversations(query, limit = 20) { const pattern = `%${query || ""}%`; return this.db.prepare("SELECT * FROM agent_conversations WHERE title LIKE ? ORDER BY updated_at DESC LIMIT ?").all(pattern, limit); }
  updateAgentConversationTitle(id, title) { const result = this.db.prepare("UPDATE agent_conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(title, id); return { success: result.changes > 0 }; }
  archiveAgentConversation(id) { const result = this.db.prepare("UPDATE agent_conversations SET archived_at = CURRENT_TIMESTAMP WHERE id = ?").run(id); return { success: result.changes > 0 }; }
  unarchiveAgentConversation(id) { const result = this.db.prepare("UPDATE agent_conversations SET archived_at = NULL WHERE id = ?").run(id); return { success: result.changes > 0 }; }
  deleteAgentConversation(id) { const result = this.db.prepare("DELETE FROM agent_conversations WHERE id = ?").run(id); return { success: result.changes > 0 }; }

  saveGoogleTokens(tokens) { this.db.prepare("INSERT INTO google_calendar_tokens (google_email, access_token, refresh_token, expires_at, scope) VALUES (?, ?, ?, ?, ?) ON CONFLICT(google_email) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, scope = excluded.scope, updated_at = CURRENT_TIMESTAMP").run(tokens.google_email, tokens.access_token, tokens.refresh_token, tokens.expires_at, tokens.scope); return { success: true }; }
  getGoogleTokens() { return this.db.prepare("SELECT * FROM google_calendar_tokens LIMIT 1").get() || null; }
  getGoogleTokensByEmail(email) { return this.db.prepare("SELECT * FROM google_calendar_tokens WHERE google_email = ?").get(email) || null; }
  getAllGoogleTokens() { return this.db.prepare("SELECT * FROM google_calendar_tokens").all(); }
  getGoogleAccounts() { return this.db.prepare("SELECT google_email AS email FROM google_calendar_tokens ORDER BY created_at").all(); }
  deleteGoogleTokens() { this.db.prepare("DELETE FROM google_calendar_tokens").run(); return { success: true }; }
  removeGoogleAccount(email) { this.db.prepare("DELETE FROM google_calendar_tokens WHERE google_email = ?").run(email); this.db.prepare("DELETE FROM google_calendars WHERE account_email = ?").run(email); return { success: true }; }
  saveGoogleCalendars(calendars, accountEmail = null) { const stmt = this.db.prepare("INSERT INTO google_calendars (id, summary, description, background_color, account_email, is_primary) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, description = excluded.description, background_color = excluded.background_color, account_email = excluded.account_email, is_primary = excluded.is_primary"); calendars.forEach((cal) => stmt.run(cal.id, cal.summary, cal.description || null, cal.background_color || null, accountEmail, cal.is_primary ? 1 : 0)); return { success: true }; }
  getGoogleCalendars(accountEmail = null) { return accountEmail ? this.db.prepare("SELECT * FROM google_calendars WHERE account_email = ?").all(accountEmail) : this.db.prepare("SELECT * FROM google_calendars").all(); }
  getSelectedCalendars(accountEmail = null) { return accountEmail ? this.db.prepare("SELECT * FROM google_calendars WHERE is_selected = 1 AND account_email = ?").all(accountEmail) : this.db.prepare("SELECT * FROM google_calendars WHERE is_selected = 1").all(); }
  applyPrimaryOnlyToSelection(primaryOnly) { this.db.prepare("UPDATE google_calendars SET is_selected = CASE WHEN ? = 1 THEN is_primary ELSE 1 END").run(primaryOnly ? 1 : 0); return { success: true }; }
  updateCalendarSelection(id, selected) { this.db.prepare("UPDATE google_calendars SET is_selected = ? WHERE id = ?").run(selected ? 1 : 0, id); return { success: true }; }

  saveMicrosoftTokens(tokens) { this.db.prepare("INSERT INTO microsoft_calendar_tokens (microsoft_email, access_token, refresh_token, expires_at, scope) VALUES (?, ?, ?, ?, ?) ON CONFLICT(microsoft_email) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, scope = excluded.scope, updated_at = CURRENT_TIMESTAMP").run(tokens.microsoft_email, tokens.access_token, tokens.refresh_token, tokens.expires_at, tokens.scope); return { success: true }; }
  getMicrosoftTokensByEmail(email) { return this.db.prepare("SELECT * FROM microsoft_calendar_tokens WHERE microsoft_email = ?").get(email) || null; }
  getMicrosoftAccounts() { return this.db.prepare("SELECT microsoft_email AS email FROM microsoft_calendar_tokens ORDER BY created_at").all(); }
  removeMicrosoftAccount(email) { this.db.prepare("DELETE FROM microsoft_calendar_tokens WHERE microsoft_email = ?").run(email); this.db.prepare("DELETE FROM microsoft_calendars WHERE account_email = ?").run(email); return { success: true }; }
  saveMicrosoftCalendars(calendars, accountEmail) { const stmt = this.db.prepare("INSERT INTO microsoft_calendars (id, summary, background_color, account_email, is_primary) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, background_color = excluded.background_color, account_email = excluded.account_email, is_primary = excluded.is_primary"); calendars.forEach((cal) => stmt.run(cal.id, cal.summary, cal.background_color || null, accountEmail, cal.is_primary ? 1 : 0)); return { success: true }; }
  applyMicrosoftPrimaryOnlyToSelection(primaryOnly) { this.db.prepare("UPDATE microsoft_calendars SET is_selected = CASE WHEN ? = 1 THEN is_primary ELSE 1 END").run(primaryOnly ? 1 : 0); return { success: true }; }
  getSelectedMicrosoftCalendars() { return this.db.prepare("SELECT * FROM microsoft_calendars WHERE is_selected = 1").all(); }

  saveAppleCalendars(calendars) { const tx = this.db.transaction((list) => { this.db.prepare("DELETE FROM apple_calendars").run(); const stmt = this.db.prepare("INSERT INTO apple_calendars (id, title, color, source_name) VALUES (?, ?, ?, ?)"); list.forEach((cal) => stmt.run(cal.id, cal.title, cal.color || null, cal.source_name || null)); }); tx(calendars); return { success: true }; }
  getAppleCalendars() { return this.db.prepare("SELECT * FROM apple_calendars").all(); }
  upsertCalendarEvents(events) { const stmt = this.db.prepare("INSERT OR REPLACE INTO calendar_events (id, calendar_id, provider, summary, start_time, end_time, is_all_day, status, availability_status, self_response_status, hangout_link, conference_data, organizer_email, attendees_count, attendees, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"); this.db.transaction((list) => list.forEach((e) => stmt.run(e.id, e.calendar_id, e.provider || "google", e.summary || null, e.start_time, e.end_time, e.is_all_day ? 1 : 0, e.status || "confirmed", e.availability_status || "unknown", e.self_response_status || "unknown", e.hangout_link || null, e.conference_data || null, e.organizer_email || null, e.attendees_count || 0, e.attendees || null)))(events); return { success: true }; }
  getActiveEvents() { return this.db.prepare(dedupedEventsQuery("datetime(start_time) <= datetime('now') AND datetime(end_time) > datetime('now') AND is_all_day = 0 AND status IN ('confirmed', 'tentative')")).all().map(stripDedupeColumn); }
  getUpcomingEvents(windowMinutes = 1440) { return this.db.prepare(dedupedEventsQuery("((datetime(start_time) > datetime('now') AND datetime(start_time) <= datetime('now', '+' || ? || ' minutes')) OR (datetime(start_time) <= datetime('now') AND datetime(end_time) > datetime('now'))) AND is_all_day = 0 AND status IN ('confirmed', 'tentative')")).all(windowMinutes).map(stripDedupeColumn); }
  getCalendarEventsInRange(start, end, providers) {
    const from = Date.parse(start); const to = Date.parse(end);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new RangeError("Invalid calendar event range");
    const selected = [...new Set(providers)].filter((provider) => CALENDAR_PROVIDERS.has(provider));
    if (!selected.length) return [];
    const placeholders = selected.map(() => "?").join(", ");
    const events = this.db.prepare(dedupedEventsQuery(`provider IN (${placeholders}) AND status IN ('confirmed', 'tentative') AND ${selectedCalendarFilter()}`)).all(...selected).map(stripDedupeColumn);
    return events.filter((event) => { const eventStart = parseEventTime(event.start_time, event.is_all_day === 1); const eventEnd = parseEventTime(event.end_time, event.is_all_day === 1); return Number.isFinite(eventStart) && Number.isFinite(eventEnd) && eventStart < to && eventEnd > from; });
  }
  getCalendarEventById(id) { return this.db.prepare("SELECT * FROM calendar_events WHERE id = ?").get(id) || null; }
  getNoteByCalendarEventId(eventId, excludeNoteId = null) { return excludeNoteId == null ? this.db.prepare("SELECT * FROM notes WHERE calendar_event_id = ? LIMIT 1").get(eventId) || null : this.db.prepare("SELECT * FROM notes WHERE calendar_event_id = ? AND id != ? LIMIT 1").get(eventId, excludeNoteId) || null; }
  updateCalendarSyncToken(id, token, expiresAt) { this.db.prepare("UPDATE google_calendars SET sync_token = ?, sync_token_expires_at = ? WHERE id = ?").run(token, expiresAt, id); return { success: true }; }
  updateMicrosoftCalendarSyncToken(id, token, expiresAt) { this.db.prepare("UPDATE microsoft_calendars SET sync_token = ?, sync_token_expires_at = ? WHERE id = ?").run(token, expiresAt, id); return { success: true }; }
  removeCalendarEvents(ids) { if (ids?.length) this.db.prepare(`DELETE FROM calendar_events WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids); return { success: true }; }
  removeStaleCalendarEvents(provider, calendarId, freshIds) { const filter = freshIds?.length ? `AND id NOT IN (${freshIds.map(() => "?").join(",")})` : ""; this.db.prepare(`DELETE FROM calendar_events WHERE provider = ? AND calendar_id = ? ${filter} AND id NOT IN (SELECT calendar_event_id FROM notes WHERE calendar_event_id IS NOT NULL)`).run(provider, calendarId, ...(freshIds || [])); return { success: true }; }
  removeEventsFromDeselectedCalendars(provider) { const table = CALENDARS_TABLE_BY_PROVIDER[provider]; if (!table) throw new Error(`Unknown calendar provider: ${provider}`); this.db.prepare(`DELETE FROM calendar_events WHERE provider = ? AND calendar_id NOT IN (SELECT id FROM ${table} WHERE is_selected = 1)`).run(provider); return { success: true }; }
  replaceAppleCalendarEvents(events) {
    const tx = this.db.transaction((list) => {
      this.db.prepare("DELETE FROM calendar_events WHERE provider = 'apple' AND id NOT IN (SELECT calendar_event_id FROM notes WHERE calendar_event_id IS NOT NULL)").run();
      const stmt = this.db.prepare("INSERT OR REPLACE INTO calendar_events (id, calendar_id, provider, summary, start_time, end_time, is_all_day, status, availability_status, self_response_status, hangout_link, conference_data, organizer_email, attendees_count, attendees, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)");
      list.forEach((e) => stmt.run(e.id, e.calendar_id, e.provider || "apple", e.summary || null, e.start_time, e.end_time, e.is_all_day ? 1 : 0, e.status || "confirmed", e.availability_status || "unknown", e.self_response_status || "unknown", e.hangout_link || null, e.conference_data || null, e.organizer_email || null, e.attendees_count || 0, e.attendees || null));
    });
    tx(events);
    return { success: true };
  }
  clearGoogleCalendarData() { this.db.prepare("DELETE FROM calendar_events WHERE provider = 'google'").run(); this.db.prepare("DELETE FROM google_calendars").run(); this.db.prepare("DELETE FROM google_calendar_tokens").run(); return { success: true }; }
  clearMicrosoftCalendarData() { this.db.prepare("DELETE FROM calendar_events WHERE provider = 'microsoft'").run(); this.db.prepare("DELETE FROM microsoft_calendars").run(); this.db.prepare("DELETE FROM microsoft_calendar_tokens").run(); return { success: true }; }
  clearAppleCalendarData() { this.db.prepare("DELETE FROM calendar_events WHERE provider = 'apple'").run(); this.db.prepare("DELETE FROM apple_calendars").run(); return { success: true }; }

  searchNotes(query, limit = 50, spaceId = null, folderId = null) {
    const ftsQuery = buildNoteSearchQuery(query);
    if (!ftsQuery) return [];
    const conditions = ["notes_fts MATCH ?"];
    const params = [ftsQuery];
    if (spaceId != null) { conditions.push("n.space_id = ?"); params.push(spaceId); }
    if (folderId != null) { conditions.push("n.folder_id = ?"); params.push(folderId); }
    params.push(limit);
    return this.db.prepare(`SELECT n.* FROM notes n JOIN notes_fts ON notes_fts.rowid = n.id WHERE ${conditions.join(" AND ")} ORDER BY notes_fts.rank LIMIT ?`).all(...params);
  }

  upsertContacts(contacts) { const stmt = this.db.prepare("INSERT INTO contacts (email, display_name) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET display_name = COALESCE(excluded.display_name, contacts.display_name), updated_at = CURRENT_TIMESTAMP"); this.db.transaction((list) => list.forEach((contact) => { if (contact.email) stmt.run(contact.email.toLowerCase().trim(), contact.displayName || null); }))(contacts); return { success: true }; }
  searchContacts(query) { const pattern = `%${query || ""}%`; return this.db.prepare("SELECT * FROM contacts WHERE email LIKE ? OR display_name LIKE ? ORDER BY display_name, email LIMIT 20").all(pattern, pattern); }
  upsertSpeakerProfile(name, email, embeddingBuffer, profileId = null) { if (profileId != null) { this.db.prepare("UPDATE speaker_profiles SET display_name = ?, email = ?, embedding = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(name, email || null, embeddingBuffer, profileId); return this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(profileId); } const result = this.db.prepare("INSERT INTO speaker_profiles (display_name, email, embedding) VALUES (?, ?, ?)").run(name, email || null, embeddingBuffer); return this.db.prepare("SELECT * FROM speaker_profiles WHERE id = ?").get(result.lastInsertRowid); }
  getSpeakerProfiles(includeEmbedding = false) { return this.db.prepare(`SELECT ${includeEmbedding ? "*" : "id, display_name, email, sample_count, created_at, updated_at"} FROM speaker_profiles ORDER BY display_name`).all(); }
  attachEmailToProfile(profileId, email) { this.db.prepare("UPDATE speaker_profiles SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(email, profileId); return { success: true }; }
  mergeSpeakerProfiles(a, b) { this.db.prepare("UPDATE speaker_mappings SET profile_id = ? WHERE profile_id = ?").run(a, b); this.db.prepare("DELETE FROM speaker_profiles WHERE id = ?").run(b); return { success: true }; }
  setSpeakerMapping(noteId, speakerId, profileId, displayName) { this.db.prepare("INSERT INTO speaker_mappings (note_id, speaker_id, profile_id, display_name) VALUES (?, ?, ?, ?) ON CONFLICT(note_id, speaker_id) DO UPDATE SET profile_id = excluded.profile_id, display_name = excluded.display_name").run(noteId, speakerId, profileId, displayName); return { success: true }; }
  getSpeakerMappings(noteId) { return this.db.prepare("SELECT * FROM speaker_mappings WHERE note_id = ?").all(noteId); }
  removeSpeakerMapping(noteId, speakerId) { return { success: this.db.prepare("DELETE FROM speaker_mappings WHERE note_id = ? AND speaker_id = ?").run(noteId, speakerId).changes > 0 }; }
  saveNoteSpeakerEmbeddings(noteId, embeddings) { const tx = this.db.transaction((list) => { const stmt = this.db.prepare("INSERT INTO note_speaker_embeddings (note_id, speaker_id, embedding) VALUES (?, ?, ?) ON CONFLICT(note_id, speaker_id) DO UPDATE SET embedding = excluded.embedding"); list.forEach((item) => stmt.run(noteId, item.speakerId, item.embedding)); }); tx(embeddings); return { success: true }; }
  getNoteSpeakerEmbeddings(noteId) { return this.db.prepare("SELECT * FROM note_speaker_embeddings WHERE note_id = ?").all(noteId); }
  getNotesWithUnmappedSpeakers() { return this.db.prepare("SELECT DISTINCT n.* FROM notes n JOIN speaker_mappings m ON m.note_id = n.id WHERE m.profile_id IS NULL ORDER BY n.updated_at DESC").all(); }

  cleanup() { if (this.db) { this.db.close(); this.db = null; } }
  close() { this.cleanup(); }
}

module.exports = DatabaseManager;
