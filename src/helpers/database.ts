// The persistence adapter over better-sqlite3. One DatabaseManager, the same
// SQL, transactions and schema as the JS version — this conversion only adds
// strict types at the SQL boundary. Internal row shapes are deliberately NOT
// public IPC DTOs: tokens and embedding buffers stay main-only; shared
// contracts own the renderer-facing projections.
import path from "path";
import { randomUUID } from "crypto";
import { app } from "electron";
import debugLogger from "./debugLogger.js";
import { buildNoteSearchQuery } from "./noteSearch.js";
import { parseEventTime } from "./calendarAvailability.js";
import { toDbTimestamp } from "./dbTimestamp.js";
import { BUILTIN_ACTIONS } from "./builtinActions.js";
import { noteContentHash } from "../utils/noteContentHash.js";
import { isDevelopmentChannel } from "./appChannel.js";
import * as secretCrypto from "./secretCrypto.js";
import {
  meetingProcessingConfigSchema,
  meetingProcessingConfigErrorSchema,
  meetingRecordingIdSchema,
  meetingRecordingConfigInputSchema,
  meetingRunArtifactSchema,
  meetingSourceSchema,
  type MeetingAudioState,
  type MeetingCaptureState,
  type MeetingDeletionIntentDto,
  type MeetingProcessingConfig,
  type MeetingProcessingConfigError,
  type MeetingProcessingRunDto,
  type MeetingRecordingDto,
  type MeetingRecordingEpochDto,
  type MeetingRunArtifact,
  type MeetingRunStage,
  type MeetingRunStatus,
  type MeetingSource,
} from "../contracts/meetingRecording.js";

// better-sqlite3 ships no type declarations and @types/better-sqlite3 is not
// installed; this is the narrow structural surface the manager actually uses.
export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  pragma(source: string): unknown;
  exec(source: string): unknown;
  prepare(source: string): SqliteStatement;
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
  close(): void;
}

type BetterSqlite3Constructor = new (filename: string) => SqliteDatabase;
const Database = require("better-sqlite3") as BetterSqlite3Constructor;

const MAX_SNIPPET_TRIGGER_LENGTH = 100;
const CALENDARS_TABLE_BY_PROVIDER: Record<string, string> = {
  google: "google_calendars",
  microsoft: "microsoft_calendars",
};
const CALENDAR_PROVIDERS: ReadonlySet<string> = new Set(["google", "microsoft", "apple"]);
const CALENDAR_TOKEN_PREFIX = "ohenc:v1:";

function encryptCalendarToken(token: string): string {
  if (!token) throw new Error("Calendar OAuth response did not include a token");
  return CALENDAR_TOKEN_PREFIX + secretCrypto.encrypt(token).toString("base64");
}

function decryptCalendarToken(token: string): string {
  if (!token.startsWith(CALENDAR_TOKEN_PREFIX)) {
    throw new Error("Calendar token is not encrypted");
  }
  const encrypted = Buffer.from(token.slice(CALENDAR_TOKEN_PREFIX.length), "base64");
  return secretCrypto.decrypt(encrypted).value;
}

// --- Internal row shapes (main-only; not renderer DTO) ------------------------

export interface SpaceRow {
  id: number;
  name: string;
  emoji: string | null;
  kind: "private";
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface FolderRow {
  id: number;
  name: string;
  is_default: number;
  sort_order: number;
  space_id: number;
  created_at: string;
  updated_at: string;
}

export interface NoteRow {
  id: number;
  title: string;
  content: string;
  note_type: string;
  source_file: string | null;
  audio_duration_seconds: number | null;
  created_at: string;
  updated_at: string;
  enhanced_content: string | null;
  enhancement_prompt: string | null;
  enhanced_at_content_hash: string | null;
  folder_id: number | null;
  /** Every folder holding the note: the primary folder_id first, then extra folders. */
  folder_ids: number[];
  space_id: number;
  transcript: string | null;
  calendar_event_id: string | null;
  participants: string | null;
  diarization_enabled: number | null;
  expected_speaker_count: number | null;
}

type RawNoteRow = Omit<NoteRow, "folder_ids"> & { extra_folder_ids_json: string | null };

// Extra folders live in note_folders; this column rides along with every note read.
const noteColumns = (alias: string) =>
  `${alias}.*, (SELECT json_group_array(nf.folder_id) FROM note_folders nf WHERE nf.note_id = ${alias}.id) AS extra_folder_ids_json`;

function hydrateNote(raw: RawNoteRow): NoteRow {
  const { extra_folder_ids_json, ...note } = raw;
  const extra = extra_folder_ids_json ? (JSON.parse(extra_folder_ids_json) as number[]) : [];
  return { ...note, folder_ids: note.folder_id != null ? [note.folder_id, ...extra] : extra };
}

export interface ActionRow {
  id: number;
  name: string;
  description: string;
  prompt: string;
  icon: string;
  is_builtin: number;
  sort_order: number;
  translation_key: string | null;
  created_at: string;
  updated_at: string;
}

interface MeetingRecordingDbRow {
  id: string;
  group_id: string | null;
  note_id: number;
  capture_state: MeetingCaptureState;
  started_at: string;
  ended_at: string | null;
  source_metadata_json: string;
  config_json: string | null;
  config_error_code: string | null;
  config_error_message_key: string | null;
  capture_error_code: string | null;
  audio_state: MeetingAudioState;
  audio_error_code: string | null;
  current_run_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MeetingRecordingEpochDbRow {
  recording_id: string;
  source: MeetingSource;
  epoch_index: number;
  start_frame: number;
  sample_rate: 24_000;
  channels: 1;
  encoding: "pcm_s16le";
  relative_path: string;
  state: "open" | "finalized" | "incomplete";
  frame_count: number;
  ignored_trailing_bytes: number;
  error_code: string | null;
}

interface MeetingProcessingRunDbRow {
  id: string;
  recording_id: string;
  source_recording_ids_json: string | null;
  kind: "initial" | "reprocess" | "summary";
  source_run_id: string | null;
  bb_thread_id: string | null;
  provider: string | null;
  model: string | null;
  config_json: string | null;
  config_error_code: string | null;
  config_error_message_key: string | null;
  stage: MeetingRunStage;
  status: MeetingRunStatus;
  error_code: string | null;
  retry_at: string | null;
  raw_response_path: string | null;
  transcript_path: string | null;
  summary_path: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

interface MeetingDeletionIntentDbRow {
  id: string;
  kind: "audio" | "note";
  note_id: number;
  recording_id: string | null;
  status: "pending" | "failed";
  error_code: string | null;
  requested_at: string;
}

// A type alias, not an interface: aliases carry an implicit index signature, so full
// rows stay assignable to the loose wire projections over them.
export type TranscriptionRow = {
  id: number;
  text: string;
  raw_text: string | null;
  timestamp: string;
  created_at: string;
  has_audio: number;
  audio_duration_ms: number | null;
  provider: string | null;
  model: string | null;
  status: string;
  error_message: string | null;
  error_code: string | null;
  route_kind: string | null;
};

export interface AgentConversationRow {
  id: number;
  title: string;
  note_id: number | null;
  space_id: number | null;
  folder_id: number | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentMessageRow {
  id: number;
  conversation_id: number;
  role: "user" | "assistant" | "system";
  content: string;
  metadata: string | null;
  created_at: string;
}

export interface ContainerConversationRow extends AgentConversationRow {
  message_count: number;
}

export interface ConversationPreviewRow extends AgentConversationRow {
  preview: string | null;
}

// Tokens stay main-only: the renderer never sees these row shapes.
export interface GoogleTokenRow {
  id: number;
  google_email: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  created_at: string;
  updated_at: string;
}

export interface MicrosoftTokenRow {
  id: number;
  microsoft_email: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
  created_at: string;
  updated_at: string;
}

export interface GoogleCalendarRow {
  id: string;
  summary: string;
  description: string | null;
  background_color: string | null;
  is_selected: number;
  is_primary: number;
  sync_token: string | null;
  sync_token_expires_at: number | null;
  account_email: string | null;
  created_at: string;
}

export interface MicrosoftCalendarRow {
  id: string;
  summary: string;
  background_color: string | null;
  is_selected: number;
  is_primary: number;
  sync_token: string | null;
  sync_token_expires_at: number | null;
  account_email: string | null;
  created_at: string;
}

export interface AppleCalendarRow {
  id: string;
  title: string;
  color: string | null;
  source_name: string | null;
  created_at: string;
}

// A type alias, not an interface: type aliases of object literals carry an
// implicit index signature, so full rows stay assignable to loose engine
// projections like DetectionCalendarEvent.
export type CalendarEventRow = {
  id: string;
  calendar_id: string;
  provider: string;
  summary: string | null;
  start_time: string;
  end_time: string;
  is_all_day: number;
  status: string;
  availability_status: string;
  self_response_status: string;
  hangout_link: string | null;
  conference_data: string | null;
  event_url: string | null;
  organizer_email: string | null;
  attendees_count: number;
  attendees: string | null;
  description: string | null;
  synced_at: string;
};

export interface CalendarAccountRow {
  email: string;
}

export interface ContactRow {
  email: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

/** An email's best-known name and photo; the Google People name wins over calendar or typed names. */
export interface ContactProfileRow {
  email: string;
  display_name: string | null;
  photo_url: string | null;
}

export interface SpeakerProfileRow {
  id: number;
  display_name: string;
  email: string | null;
  embedding?: Buffer;
  sample_count: number;
  created_at: string;
  updated_at: string;
}

export interface SpeakerMappingRow {
  note_id: number;
  speaker_id: string;
  profile_id: number | null;
  display_name: string;
}

export interface NoteSpeakerEmbeddingRow {
  note_id: number;
  speaker_id: string;
  embedding: Buffer;
}

export interface FolderNoteCountRow {
  folder_id: number | null;
  space_id: number;
  count: number;
}

export interface GoogleCalendarInput {
  id: string;
  summary: string;
  description?: string | null;
  background_color?: string | null;
  is_primary?: boolean | number;
}

export interface MicrosoftCalendarInput {
  id: string;
  summary: string;
  background_color?: string | null;
  is_primary?: boolean | number;
}

export interface AppleCalendarInput {
  id: string;
  title: string;
  color?: string | null;
  source_name?: string | null;
}

export interface CalendarEventInput {
  id: string;
  calendar_id: string;
  provider?: string;
  summary?: string | null;
  start_time: string;
  end_time: string;
  is_all_day?: boolean | number;
  status?: string;
  availability_status?: string;
  self_response_status?: string;
  hangout_link?: string | null;
  conference_data?: string | null;
  event_url?: string | null;
  organizer_email?: string | null;
  attendees_count?: number;
  attendees?: string | null;
  description?: string | null;
}

// --- Helpers -------------------------------------------------------------------

function dedupedEventsQuery(where: string): string {
  return `SELECT * FROM (
    SELECT *, MAX(provider != 'apple') OVER (
      PARTITION BY datetime(start_time), datetime(end_time), COALESCE(summary, '')
    ) AS has_synced
    FROM calendar_events
    WHERE ${where}
  ) WHERE provider != 'apple' OR has_synced = 0 ORDER BY datetime(start_time) ASC`;
}

function stripDedupeColumn(row: CalendarEventRow & { has_synced: number }): CalendarEventRow {
  const { has_synced: _hasSynced, ...event } = row;
  return event;
}

function selectedCalendarFilter(): string {
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

function normalizeWords(words: unknown): Map<string, string> {
  const result = new Map<string, string>();
  for (const raw of Array.isArray(words) ? words : []) {
    if (typeof raw !== "string") continue;
    const word = raw.trim();
    if (word && !result.has(word.toLowerCase())) result.set(word.toLowerCase(), word);
  }
  return result;
}

function isSqliteUniqueConstraint(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "SQLITE_CONSTRAINT_UNIQUE";
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid meeting recording JSON metadata");
  }
  return parsed as Record<string, unknown>;
}

function parseConfig(value: string | null): MeetingProcessingConfig | null {
  return value === null ? null : meetingProcessingConfigSchema.parse(JSON.parse(value));
}

function configErrorFromRow(code: string | null, messageKey: string | null): MeetingProcessingConfigError | null {
  return code === null ? null : meetingProcessingConfigErrorSchema.parse({ code, ...(messageKey && { messageKey }) });
}

function toMeetingRecordingDto(row: MeetingRecordingDbRow): MeetingRecordingDto {
  return {
    id: row.id,
    groupId: row.group_id ?? row.id,
    noteId: row.note_id,
    captureState: row.capture_state,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    sourceMetadata: parseJsonObject(row.source_metadata_json),
    config: parseConfig(row.config_json),
    configError: configErrorFromRow(row.config_error_code, row.config_error_message_key),
    captureErrorCode: row.capture_error_code,
    audioState: row.audio_state,
    audioErrorCode: row.audio_error_code,
    currentRunId: row.current_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMeetingEpochDto(row: MeetingRecordingEpochDbRow): MeetingRecordingEpochDto {
  return {
    recordingId: row.recording_id,
    source: row.source,
    epochIndex: row.epoch_index,
    startFrame: row.start_frame,
    sampleRate: row.sample_rate,
    channels: row.channels,
    encoding: row.encoding,
    state: row.state,
    frameCount: row.frame_count,
    ignoredTrailingBytes: row.ignored_trailing_bytes,
    errorCode: row.error_code,
  };
}

function toMeetingRunDto(row: MeetingProcessingRunDbRow): MeetingProcessingRunDto {
  return {
    id: row.id,
    recordingId: row.recording_id,
    sourceRecordingIds: row.source_recording_ids_json ? JSON.parse(row.source_recording_ids_json) : [row.recording_id],
    kind: row.kind,
    sourceRunId: row.source_run_id,
    bbThreadId: row.bb_thread_id,
    provider: row.provider,
    model: row.model,
    config: parseConfig(row.config_json),
    configError: configErrorFromRow(row.config_error_code, row.config_error_message_key),
    stage: row.stage,
    status: row.status,
    errorCode: row.error_code,
    retryAt: row.retry_at,
    retryCount: row.retry_count,
    hasRawProviderResponse: row.raw_response_path !== null,
    hasTranscript: row.transcript_path !== null,
    hasSummary: row.summary_path !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMeetingDeletionIntentDto(row: MeetingDeletionIntentDbRow): MeetingDeletionIntentDto {
  return {
    id: row.id,
    kind: row.kind,
    noteId: row.note_id,
    recordingId: row.recording_id,
    status: row.status,
    errorCode: row.error_code,
    requestedAt: row.requested_at,
  };
}

function storedConfig(config: unknown, error: unknown): {
  config: MeetingProcessingConfig | null;
  error: MeetingProcessingConfigError | null;
} {
  const parsedInput = meetingRecordingConfigInputSchema.safeParse({ config, configError: error });
  if (!parsedInput.success) return { config: null, error: { code: "invalid-config" } };
  if (parsedInput.data.config === null) {
    return { config: null, error: parsedInput.data.configError ?? { code: "missing-config" } };
  }
  return { config: parsedInput.data.config, error: null };
}

function configJson(config: MeetingProcessingConfig | null): string | null {
  return config === null ? null : JSON.stringify(config);
}

function relativeEpochPath(source: MeetingSource, index: number): string {
  return `${source}/epoch-${String(index).padStart(6, "0")}.pcm`;
}

function meetingRunArtifactFileName(artifact: MeetingRunArtifact): string {
  if (artifact === "provider-response") return "raw-provider-response.json";
  return artifact === "transcript" ? "transcript.json" : "summary.json";
}

// --- Manager -------------------------------------------------------------------

export class DatabaseManager {
  private _db: SqliteDatabase | null = null;

  constructor() {
    this.initDatabase();
  }

  // Raw SQLite handle for the few seams that intentionally bypass the manager
  // methods (composition-root queries, cleanup-app close, test harnesses).
  // After close() it throws, like every manager method — use-after-close stays
  // loud instead of returning a silent null handle.
  get db(): SqliteDatabase {
    if (this._db === null) throw new Error("Database is closed");
    return this._db;
  }

  // Every method goes through this getter: after close() the old code threw a
  // TypeError reading `null.prepare`; an explicit throw keeps use-after-close
  // loud instead of silently returning empty results.
  private get sql(): SqliteDatabase {
    if (this._db === null) throw new Error("Database is closed");
    return this._db;
  }

  initDatabase(): boolean {
    try {
      const fileName = isDevelopmentChannel() ? "transcriptions-dev.db" : "transcriptions.db";
      this._db = new Database(path.join(app.getPath("userData"), fileName));
      this._db.pragma("foreign_keys = ON");
      this._db.pragma("journal_mode = WAL");
      this._db.pragma("secure_delete = ON");

      this._db.exec(`
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

        -- Extra folders a note also appears in; notes.folder_id stays the primary one.
        CREATE TABLE IF NOT EXISTS note_folders (
          note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
          PRIMARY KEY (note_id, folder_id)
        );

        CREATE TABLE IF NOT EXISTS meeting_recordings (
          id TEXT PRIMARY KEY,
          group_id TEXT,
          note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE RESTRICT,
          capture_state TEXT NOT NULL CHECK(capture_state IN ('recording', 'finalizing', 'ready', 'incomplete')),
          started_at TEXT NOT NULL,
          ended_at TEXT,
          source_metadata_json TEXT NOT NULL DEFAULT '{}',
          config_json TEXT,
          config_error_code TEXT,
          config_error_message_key TEXT,
          capture_error_code TEXT,
          audio_state TEXT NOT NULL DEFAULT 'available' CHECK(audio_state IN ('available', 'deleting', 'deleted')),
          audio_error_code TEXT,
          current_run_id TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS meeting_recording_epochs (
          recording_id TEXT NOT NULL REFERENCES meeting_recordings(id) ON DELETE CASCADE,
          source TEXT NOT NULL CHECK(source IN ('mic', 'system')),
          epoch_index INTEGER NOT NULL CHECK(epoch_index >= 0),
          start_frame INTEGER NOT NULL CHECK(start_frame >= 0),
          sample_rate INTEGER NOT NULL CHECK(sample_rate = 24000),
          channels INTEGER NOT NULL CHECK(channels = 1),
          encoding TEXT NOT NULL CHECK(encoding = 'pcm_s16le'),
          relative_path TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open', 'finalized', 'incomplete')),
          frame_count INTEGER NOT NULL DEFAULT 0 CHECK(frame_count >= 0),
          ignored_trailing_bytes INTEGER NOT NULL DEFAULT 0 CHECK(ignored_trailing_bytes BETWEEN 0 AND 1),
          error_code TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (recording_id, source, epoch_index)
        );

        CREATE TABLE IF NOT EXISTS meeting_processing_runs (
          id TEXT PRIMARY KEY,
          recording_id TEXT NOT NULL REFERENCES meeting_recordings(id) ON DELETE CASCADE,
          source_recording_ids_json TEXT,
          kind TEXT NOT NULL CHECK(kind IN ('initial', 'reprocess', 'summary')),
          source_run_id TEXT REFERENCES meeting_processing_runs(id) ON DELETE SET NULL,
          bb_thread_id TEXT,
          provider TEXT,
          model TEXT,
          config_json TEXT,
          config_error_code TEXT,
          config_error_message_key TEXT,
          stage TEXT NOT NULL CHECK(stage IN ('prepare', 'asr', 'normalize', 'summary')),
          status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'blocked', 'failed', 'cancelled', 'complete')),
          error_code TEXT,
          retry_at TEXT,
          raw_response_path TEXT,
          transcript_path TEXT,
          summary_path TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (recording_id, id)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_initial_run
          ON meeting_processing_runs(recording_id) WHERE kind = 'initial';
        CREATE INDEX IF NOT EXISTS idx_meeting_runs_recording_created
          ON meeting_processing_runs(recording_id, created_at);

        CREATE TABLE IF NOT EXISTS meeting_deletion_intents (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK(kind IN ('audio', 'note')),
          note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          recording_id TEXT REFERENCES meeting_recordings(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'failed')),
          error_code TEXT,
          requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CHECK((kind = 'audio' AND recording_id IS NOT NULL) OR (kind = 'note' AND recording_id IS NULL))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_audio_delete_intent
          ON meeting_deletion_intents(recording_id) WHERE kind = 'audio';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_note_delete_intent
          ON meeting_deletion_intents(note_id) WHERE kind = 'note';

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
          event_url TEXT,
          organizer_email TEXT,
          attendees_count INTEGER NOT NULL DEFAULT 0,
          attendees TEXT,
          description TEXT,
          synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS contacts (
          email TEXT PRIMARY KEY,
          display_name TEXT,
          people_name TEXT,
          photo_url TEXT,
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

        CREATE TABLE IF NOT EXISTS meeting_run_speaker_corrections (
          run_id TEXT NOT NULL REFERENCES meeting_processing_runs(id) ON DELETE CASCADE,
          speaker_id TEXT NOT NULL,
          profile_id INTEGER REFERENCES speaker_profiles(id) ON DELETE SET NULL,
          display_name TEXT NOT NULL,
          PRIMARY KEY (run_id, speaker_id)
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
        CREATE INDEX IF NOT EXISTS idx_note_folders_folder ON note_folders(folder_id);
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

      const recordingColumns = this.sql.pragma("table_info(meeting_recordings)") as Array<{ name: string }>;
      if (!recordingColumns.some((column) => column.name === "group_id")) {
        this.sql.exec("ALTER TABLE meeting_recordings ADD COLUMN group_id TEXT");
      }
      const runColumns = this.sql.pragma("table_info(meeting_processing_runs)") as Array<{ name: string }>;
      if (!runColumns.some((column) => column.name === "bb_thread_id")) {
        this.sql.exec("ALTER TABLE meeting_processing_runs ADD COLUMN bb_thread_id TEXT");
      }
      if (!runColumns.some((column) => column.name === "source_recording_ids_json")) {
        this.sql.exec("ALTER TABLE meeting_processing_runs ADD COLUMN source_recording_ids_json TEXT");
      }
      const calendarEventColumns = this.sql.pragma("table_info(calendar_events)") as Array<{ name: string }>;
      if (!calendarEventColumns.some((column) => column.name === "event_url")) {
        this.sql.exec("ALTER TABLE calendar_events ADD COLUMN event_url TEXT");
      }
      const contactColumns = this.sql.pragma("table_info(contacts)") as Array<{ name: string }>;
      if (!contactColumns.some((column) => column.name === "people_name")) {
        this.sql.exec("ALTER TABLE contacts ADD COLUMN people_name TEXT");
      }
      if (!contactColumns.some((column) => column.name === "photo_url")) {
        this.sql.exec("ALTER TABLE contacts ADD COLUMN photo_url TEXT");
      }
      if (!calendarEventColumns.some((column) => column.name === "description")) {
        this.sql.exec("ALTER TABLE calendar_events ADD COLUMN description TEXT");
        // Incremental sync only returns changed events; drop the tokens so the
        // next sync is a full one and fills in the new column.
        this.sql.exec("UPDATE google_calendars SET sync_token = NULL, sync_token_expires_at = NULL");
        this.sql.exec("UPDATE microsoft_calendars SET sync_token = NULL, sync_token_expires_at = NULL");
      }

      const existingSpace = this.sql.prepare("SELECT id FROM spaces LIMIT 1").get() as
        | { id: number }
        | undefined;
      const spaceId =
        existingSpace?.id ??
        Number(
          this.sql
            .prepare("INSERT INTO spaces (name, kind, sort_order) VALUES ('Personal', 'private', 0)")
            .run().lastInsertRowid
        );
      if (!existingSpace) {
        const insertFolder = this.sql.prepare(
          "INSERT INTO folders (name, is_default, sort_order, space_id) VALUES (?, 1, ?, ?)"
        );
        insertFolder.run("Personal", 0, spaceId);
        insertFolder.run("Meetings", 1, spaceId);
        insertFolder.run("Videos", 2, spaceId);
      }

      if (this.sql.prepare("SELECT 1 FROM actions LIMIT 1").get() == null) {
        const insertAction = this.sql.prepare(
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
      this._discardPlaintextCalendarTokens();
      return true;
    } catch (error) {
      debugLogger.error("Database initialization failed", { error: (error as Error).message }, "database");
      throw error;
    }
  }

  createMeetingRecording(
    noteId: number,
    input: { config: unknown | null; configError?: unknown } | null,
    startedAt = new Date().toISOString(),
    id = randomUUID(),
    groupId = id
  ): MeetingRecordingDto {
    meetingRecordingIdSchema.parse(id);
    meetingRecordingIdSchema.parse(groupId);
    if (!Number.isSafeInteger(noteId) || noteId < 1 || !this.getNote(noteId)) {
      throw new Error("Meeting note not found");
    }
    const parsedStart = new Date(startedAt);
    if (!Number.isFinite(parsedStart.getTime())) throw new RangeError("Invalid meeting start time");
    if (this.isMeetingNoteDeletionPending(noteId)) throw new Error("Meeting note deletion is pending");
    const snapshot = storedConfig(input?.config ?? null, input?.configError);
    this.sql
      .prepare(
        "INSERT INTO meeting_recordings (id, group_id, note_id, capture_state, started_at, config_json, config_error_code, config_error_message_key) VALUES (?, ?, ?, 'recording', ?, ?, ?, ?)"
      )
      .run(
        id,
        groupId,
        noteId,
        parsedStart.toISOString(),
        configJson(snapshot.config),
        snapshot.error?.code ?? null,
        snapshot.error?.messageKey ?? null
      );
    return this.getMeetingRecording(id) as MeetingRecordingDto;
  }

  getMeetingRecording(id: string): MeetingRecordingDto | null {
    meetingRecordingIdSchema.parse(id);
    const row = this.sql.prepare("SELECT * FROM meeting_recordings WHERE id = ?").get(id) as
      | MeetingRecordingDbRow
      | undefined;
    return row ? toMeetingRecordingDto(row) : null;
  }

  listOpenMeetingRecordings(): MeetingRecordingDto[] {
    return (this.sql
      .prepare("SELECT * FROM meeting_recordings WHERE capture_state IN ('recording', 'finalizing') ORDER BY started_at, id")
      .all() as MeetingRecordingDbRow[]).map(toMeetingRecordingDto);
  }

  listMeetingRecordingsForNote(noteId: number): MeetingRecordingDto[] {
    if (!Number.isSafeInteger(noteId) || noteId < 1) return [];
    return (this.sql
      .prepare("SELECT * FROM meeting_recordings WHERE note_id = ? ORDER BY started_at, id")
      .all(noteId) as MeetingRecordingDbRow[]).map(toMeetingRecordingDto);
  }

  listAllMeetingRecordings(): MeetingRecordingDto[] {
    return (this.sql
      .prepare("SELECT * FROM meeting_recordings ORDER BY started_at, id")
      .all() as MeetingRecordingDbRow[]).map(toMeetingRecordingDto);
  }

  createMeetingRecordingEpoch(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number,
    startFrame: number
  ): MeetingRecordingEpochDto {
    meetingRecordingIdSchema.parse(recordingId);
    meetingSourceSchema.parse(source);
    if (
      !Number.isSafeInteger(epochIndex) ||
      epochIndex < 0 ||
      epochIndex > 999_999 ||
      !Number.isSafeInteger(startFrame) ||
      startFrame < 0
    ) {
      throw new RangeError("Invalid recording epoch position");
    }
    const recording = this.getMeetingRecording(recordingId);
    if (!recording || recording.captureState !== "recording" || recording.audioState !== "available") {
      throw new Error("Meeting recording is not accepting audio");
    }
    if (this.isMeetingNoteDeletionPending(recording.noteId)) {
      throw new Error("Meeting note deletion is pending");
    }
    const relativePath = relativeEpochPath(source, epochIndex);
    this.sql
      .prepare(
        "INSERT INTO meeting_recording_epochs (recording_id, source, epoch_index, start_frame, sample_rate, channels, encoding, relative_path) VALUES (?, ?, ?, ?, 24000, 1, 'pcm_s16le', ?)"
      )
      .run(recordingId, source, epochIndex, startFrame, relativePath);
    return this.getMeetingRecordingEpoch(recordingId, source, epochIndex) as MeetingRecordingEpochDto;
  }

  getMeetingRecordingEpoch(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number
  ): MeetingRecordingEpochDto | null {
    meetingRecordingIdSchema.parse(recordingId);
    meetingSourceSchema.parse(source);
    const row = this.sql
      .prepare(
        "SELECT recording_id, source, epoch_index, start_frame, sample_rate, channels, encoding, relative_path, state, frame_count, ignored_trailing_bytes, error_code FROM meeting_recording_epochs WHERE recording_id = ? AND source = ? AND epoch_index = ?"
      )
      .get(recordingId, source, epochIndex) as MeetingRecordingEpochDbRow | undefined;
    if (!row) return null;
    if (row.relative_path !== relativeEpochPath(row.source, row.epoch_index)) {
      throw new Error("Invalid meeting recording epoch path");
    }
    return toMeetingEpochDto(row);
  }

  listMeetingRecordingEpochs(recordingId: string): MeetingRecordingEpochDto[] {
    meetingRecordingIdSchema.parse(recordingId);
    return (this.sql
      .prepare(
        "SELECT recording_id, source, epoch_index, start_frame, sample_rate, channels, encoding, relative_path, state, frame_count, ignored_trailing_bytes, error_code FROM meeting_recording_epochs WHERE recording_id = ? ORDER BY start_frame, source, epoch_index"
      )
      .all(recordingId) as MeetingRecordingEpochDbRow[]).map((row) => {
      if (row.relative_path !== relativeEpochPath(row.source, row.epoch_index)) {
        throw new Error("Invalid meeting recording epoch path");
      }
      return toMeetingEpochDto(row);
    });
  }

  updateMeetingRecordingEpochRecovery(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number,
    result: { frameCount: number; ignoredTrailingBytes: 0 | 1; errorCode?: string | null }
  ): MeetingRecordingEpochDto {
    meetingRecordingIdSchema.parse(recordingId);
    meetingSourceSchema.parse(source);
    if (!Number.isSafeInteger(epochIndex) || epochIndex < 0 || epochIndex > 999_999) {
      throw new RangeError("Invalid recording epoch index");
    }
    if (!Number.isSafeInteger(result.frameCount) || result.frameCount < 0) {
      throw new RangeError("Invalid recovered frame count");
    }
    if (result.ignoredTrailingBytes !== 0 && result.ignoredTrailingBytes !== 1) {
      throw new RangeError("Invalid recovered frame remainder");
    }
    if (result.errorCode != null) meetingProcessingConfigErrorSchema.parse({ code: result.errorCode });
    const state = result.errorCode || result.ignoredTrailingBytes ? "incomplete" : "finalized";
    const update = this.sql
      .prepare(
        "UPDATE meeting_recording_epochs SET state = ?, frame_count = ?, ignored_trailing_bytes = ?, error_code = ?, updated_at = CURRENT_TIMESTAMP WHERE recording_id = ? AND source = ? AND epoch_index = ?"
      )
      .run(state, result.frameCount, result.ignoredTrailingBytes, result.errorCode ?? null, recordingId, source, epochIndex);
    if (!update.changes) throw new Error("Meeting recording epoch not found");
    return this.getMeetingRecordingEpoch(recordingId, source, epochIndex) as MeetingRecordingEpochDto;
  }

  markMeetingRecordingFinalizing(id: string): MeetingRecordingDto {
    meetingRecordingIdSchema.parse(id);
    const recording = this.getMeetingRecording(id);
    if (!recording) throw new Error("Meeting recording not found");
    if (recording.captureState === "ready" || recording.captureState === "incomplete") return recording;
    if (recording.audioState !== "available") throw new Error("Meeting recording audio is unavailable");
    this.sql
      .prepare(
        "UPDATE meeting_recordings SET capture_state = 'finalizing', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND capture_state IN ('recording', 'finalizing')"
      )
      .run(id);
    return this.getMeetingRecording(id) as MeetingRecordingDto;
  }

  finalizeMeetingRecording(
    id: string,
    input: {
      captureState: "ready" | "incomplete";
      endedAt: string;
      sourceMetadata?: Record<string, unknown>;
      errorCode?: string | null;
    }
  ): { recording: MeetingRecordingDto; initialRun: MeetingProcessingRunDto } {
    meetingRecordingIdSchema.parse(id);
    if (input.errorCode != null) meetingProcessingConfigErrorSchema.parse({ code: input.errorCode });
    if (!Number.isFinite(new Date(input.endedAt).getTime())) throw new RangeError("Invalid meeting end time");
    const sourceMetadata = JSON.stringify(input.sourceMetadata ?? {});
    const transaction = this.sql.transaction(() => {
      const current = this.sql.prepare("SELECT * FROM meeting_recordings WHERE id = ?").get(id) as
        | MeetingRecordingDbRow
        | undefined;
      if (!current) throw new Error("Meeting recording not found");
      if (current.audio_state !== "available") throw new Error("Meeting recording audio is unavailable");

      const existing = this.sql
        .prepare("SELECT * FROM meeting_processing_runs WHERE recording_id = ? AND kind = 'initial'")
        .get(id) as MeetingProcessingRunDbRow | undefined;
      if (existing) {
        return {
          recording: toMeetingRecordingDto(current),
          initialRun: toMeetingRunDto(existing),
        };
      }
      if (current.capture_state === "ready" || current.capture_state === "incomplete") {
        throw new Error("Finalized meeting recording is missing its initial run");
      }
      const openEpochs = (this.sql
        .prepare("SELECT COUNT(*) AS count FROM meeting_recording_epochs WHERE recording_id = ? AND state = 'open'")
        .get(id) as { count: number }).count;
      if (openEpochs > 0) throw new Error("Meeting recording epochs must be closed before finalization");

      const frames = (this.sql
        .prepare("SELECT COALESCE(SUM(frame_count), 0) AS frame_count FROM meeting_recording_epochs WHERE recording_id = ?")
        .get(id) as { frame_count: number }).frame_count;
      const incompleteEpochs = (this.sql
        .prepare("SELECT COUNT(*) AS count FROM meeting_recording_epochs WHERE recording_id = ? AND state = 'incomplete'")
        .get(id) as { count: number }).count;
      const captureState = frames > 0 && !input.errorCode && incompleteEpochs === 0 ? input.captureState : "incomplete";
      const noAudioError = frames > 0 ? null : "recording-audio-unavailable";
      this.sql
        .prepare(
          "UPDATE meeting_recordings SET capture_state = ?, ended_at = ?, source_metadata_json = ?, capture_error_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(captureState, input.endedAt, sourceMetadata, noAudioError ?? input.errorCode ?? null, id);

      const config = parseConfig(current.config_json);
      const configError = configErrorFromRow(current.config_error_code, current.config_error_message_key);
      const runId = randomUUID();
      const status = config === null || noAudioError || input.errorCode ? "blocked" : "pending";
      const errorCode = noAudioError ?? input.errorCode ?? configError?.code ?? null;
      const transcription = config?.transcription;
      const provider = transcription?.mode === "local" ? transcription.local?.provider ?? null : transcription?.provider ?? null;
      const model = transcription?.mode === "local" ? transcription.local?.model ?? null : transcription?.model ?? null;
      this.sql
        .prepare(
          "INSERT INTO meeting_processing_runs (id, recording_id, kind, provider, model, config_json, config_error_code, config_error_message_key, stage, status, error_code) VALUES (?, ?, 'initial', ?, ?, ?, ?, ?, 'prepare', ?, ?)"
        )
        .run(runId, id, provider, model, current.config_json, current.config_error_code, current.config_error_message_key, status, errorCode);
      this.sql
        .prepare(
          "UPDATE meeting_recordings SET current_run_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(runId, id);
      const recording = this.sql.prepare("SELECT * FROM meeting_recordings WHERE id = ?").get(id) as MeetingRecordingDbRow;
      const run = this.sql.prepare("SELECT * FROM meeting_processing_runs WHERE id = ?").get(runId) as MeetingProcessingRunDbRow;
      return { recording: toMeetingRecordingDto(recording), initialRun: toMeetingRunDto(run) };
    });
    return transaction();
  }

  createMeetingProcessingRun(
    recordingId: string,
    input: {
      kind: "reprocess" | "summary";
      config: MeetingProcessingConfig | null;
      configError?: MeetingProcessingConfigError | null;
      sourceRunId?: string | null;
      sourceRecordingIds?: string[];
    }
  ): MeetingProcessingRunDto {
    meetingRecordingIdSchema.parse(recordingId);
    if (input.config !== null) meetingProcessingConfigSchema.parse(input.config);
    if (input.configError != null) meetingProcessingConfigErrorSchema.parse(input.configError);
    const transaction = this.sql.transaction(() => {
      const recording = this.getMeetingRecording(recordingId);
      if (!recording) throw new Error("Meeting recording not found");
      const sourceRecordingIds = input.sourceRecordingIds ?? [recordingId];
      if (input.kind === "reprocess") {
        if (sourceRecordingIds[0] !== recordingId || new Set(sourceRecordingIds).size !== sourceRecordingIds.length) {
          throw new Error("Invalid meeting audio parts");
        }
        for (const sourceId of sourceRecordingIds) {
          meetingRecordingIdSchema.parse(sourceId);
          const source = this.getMeetingRecording(sourceId);
          if (!source || source.noteId !== recording.noteId || source.groupId !== recording.groupId || source.audioState !== "available" || !["ready", "incomplete"].includes(source.captureState)) {
            throw new Error("Meeting audio is unavailable for a selected part");
          }
        }
      }
      if (recording.captureState !== "ready" && recording.captureState !== "incomplete") {
        throw new Error("Meeting recording is not finalized");
      }
      if (
        this.isMeetingNoteDeletionPending(recording.noteId) ||
        (input.kind === "reprocess" && recording.audioState !== "available")
      ) {
        throw new Error("Meeting recording audio is unavailable");
      }
      let sourceRun: MeetingProcessingRunDbRow | undefined;
      if (input.kind === "summary") {
        if (!input.sourceRunId) throw new Error("Summary run requires a source transcript run");
        meetingRecordingIdSchema.parse(input.sourceRunId);
        sourceRun = this.sql
          .prepare(
            "SELECT * FROM meeting_processing_runs WHERE id = ? AND recording_id = ? AND transcript_path IS NOT NULL"
          )
          .get(input.sourceRunId, recordingId) as MeetingProcessingRunDbRow | undefined;
        if (!sourceRun) throw new Error("Summary source transcript not found");
      }
      const snapshot = input.config === null
        ? { config: null, error: input.configError ?? { code: "missing-config" } }
        : { config: meetingProcessingConfigSchema.parse(input.config), error: null };
      const runId = randomUUID();
      const stage: MeetingRunStage = input.kind === "summary" ? "summary" : "prepare";
      const summaryMissing = input.kind === "summary" && snapshot.config?.summary == null;
      const status: MeetingRunStatus = snapshot.config === null || summaryMissing ? "blocked" : "pending";
      const transcription = snapshot.config?.transcription;
      const provider = transcription?.mode === "local" ? transcription.local?.provider ?? null : transcription?.provider ?? null;
      const model = transcription?.mode === "local" ? transcription.local?.model ?? null : transcription?.model ?? null;
      this.sql
        .prepare(
          "INSERT INTO meeting_processing_runs (id, recording_id, source_recording_ids_json, kind, source_run_id, provider, model, config_json, config_error_code, config_error_message_key, stage, status, error_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          runId,
          recordingId,
          JSON.stringify(input.kind === "summary" ? sourceRun && JSON.parse(sourceRun.source_recording_ids_json ?? JSON.stringify([recordingId])) : sourceRecordingIds),
          input.kind,
          sourceRun?.id ?? null,
          provider,
          model,
          configJson(snapshot.config),
          snapshot.error?.code ?? null,
          snapshot.error?.messageKey ?? null,
          stage,
          status,
          snapshot.error?.code ?? (summaryMissing ? "missing-summary-config" : null)
        );
      this.sql
        .prepare("UPDATE meeting_recordings SET current_run_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(runId, recordingId);
      return toMeetingRunDto(
        this.sql.prepare("SELECT * FROM meeting_processing_runs WHERE id = ?").get(runId) as MeetingProcessingRunDbRow
      );
    });
    return transaction();
  }

  getMeetingProcessingRun(id: string): MeetingProcessingRunDto | null {
    meetingRecordingIdSchema.parse(id);
    const row = this.sql.prepare("SELECT * FROM meeting_processing_runs WHERE id = ?").get(id) as
      | MeetingProcessingRunDbRow
      | undefined;
    return row ? toMeetingRunDto(row) : null;
  }

  setMeetingRunBbThreadId(id: string, bbThreadId: string): boolean {
    meetingRecordingIdSchema.parse(id);
    if (!/^thr_[a-z0-9]+$/.test(bbThreadId)) throw new Error("Invalid bb thread id");
    const result = this.sql.prepare(
      "UPDATE meeting_processing_runs SET bb_thread_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND stage = 'summary' AND status = 'running' AND bb_thread_id IS NULL"
    ).run(bbThreadId, id);
    return result.changes === 1;
  }

  listMeetingProcessingRuns(recordingId: string): MeetingProcessingRunDto[] {
    meetingRecordingIdSchema.parse(recordingId);
    return (this.sql
      .prepare("SELECT * FROM meeting_processing_runs WHERE recording_id = ? ORDER BY created_at, rowid")
      .all(recordingId) as MeetingProcessingRunDbRow[]).map(toMeetingRunDto);
  }

  listAllMeetingProcessingRuns(): MeetingProcessingRunDto[] {
    return (this.sql
      .prepare("SELECT * FROM meeting_processing_runs ORDER BY created_at, rowid")
      .all() as MeetingProcessingRunDbRow[]).map(toMeetingRunDto);
  }

  recoverRunningMeetingProcessingRuns(): number {
    const result = this.sql.prepare(
      "UPDATE meeting_processing_runs SET status = 'pending', retry_count = CASE WHEN stage = 'asr' AND raw_response_path IS NULL THEN retry_count + 1 ELSE retry_count END, error_code = CASE WHEN stage = 'asr' AND raw_response_path IS NULL THEN 'asr-outcome-unknown' ELSE NULL END, retry_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'running' AND EXISTS (SELECT 1 FROM meeting_recordings r LEFT JOIN meeting_deletion_intents d ON d.note_id = r.note_id AND d.kind = 'note' WHERE r.id = meeting_processing_runs.recording_id AND d.id IS NULL)"
    ).run();
    return result.changes;
  }

  claimMeetingProcessingRun(id: string, now = new Date().toISOString()): boolean {
    meetingRecordingIdSchema.parse(id);
    if (!Number.isFinite(Date.parse(now))) throw new RangeError("Invalid meeting processing claim time");
    const result = this.sql.prepare(
      "UPDATE meeting_processing_runs SET status = 'running', error_code = NULL, retry_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending' AND (retry_at IS NULL OR retry_at <= ?) AND NOT EXISTS (SELECT 1 FROM meeting_processing_runs active WHERE active.status = 'running' AND active.id != meeting_processing_runs.id) AND EXISTS (SELECT 1 FROM meeting_recordings r LEFT JOIN meeting_deletion_intents d ON d.note_id = r.note_id AND d.kind = 'note' WHERE r.id = meeting_processing_runs.recording_id AND d.id IS NULL AND (r.audio_state = 'available' OR meeting_processing_runs.stage IN ('normalize', 'summary')))"
    ).run(id, now);
    return result.changes > 0;
  }

  retryMeetingProcessingRun(id: string): MeetingProcessingRunDto | null {
    meetingRecordingIdSchema.parse(id);
    const run = this.getMeetingProcessingRun(id);
    if (!run || !["blocked", "failed", "cancelled"].includes(run.status)) return null;
    const recording = this.getMeetingRecording(run.recordingId);
    if (!recording || this.isMeetingNoteDeletionPending(recording.noteId)) return null;
    if (recording.audioState !== "available" && !run.hasRawProviderResponse && run.kind !== "summary") {
      return null;
    }
    const stage = run.kind === "summary" ? "summary" : run.hasTranscript ? "summary" : run.hasRawProviderResponse ? "normalize" : "prepare";
    this.sql.prepare(
      "UPDATE meeting_processing_runs SET stage = ?, status = 'pending', error_code = NULL, retry_at = NULL, retry_count = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('blocked', 'failed', 'cancelled')"
    ).run(stage, id);
    return this.getMeetingProcessingRun(id);
  }

  setMeetingProcessingRunState(
    id: string,
    update: { stage: MeetingRunStage; status: MeetingRunStatus; errorCode?: string | null; retryAt?: string | null; retryCount?: number }
  ): { success: boolean } {
    meetingRecordingIdSchema.parse(id);
    if (update.errorCode != null) meetingProcessingConfigErrorSchema.parse({ code: update.errorCode });
    if (update.retryCount !== undefined && (!Number.isSafeInteger(update.retryCount) || update.retryCount < 0)) {
      throw new RangeError("Invalid meeting run retry count");
    }
    const result = this.sql
      .prepare(
        "UPDATE meeting_processing_runs SET stage = ?, status = ?, error_code = ?, retry_at = ?, retry_count = COALESCE(?, retry_count), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND EXISTS (SELECT 1 FROM meeting_recordings r LEFT JOIN meeting_deletion_intents d ON d.note_id = r.note_id AND d.kind = 'note' WHERE r.id = meeting_processing_runs.recording_id AND (r.audio_state = 'available' OR (? IN ('normalize', 'summary') AND (meeting_processing_runs.raw_response_path IS NOT NULL OR meeting_processing_runs.transcript_path IS NOT NULL OR (meeting_processing_runs.kind = 'summary' AND EXISTS (SELECT 1 FROM meeting_processing_runs source WHERE source.id = meeting_processing_runs.source_run_id AND source.transcript_path IS NOT NULL))))) AND d.id IS NULL)"
      )
      .run(update.stage, update.status, update.errorCode ?? null, update.retryAt ?? null, update.retryCount ?? null, id, update.stage);
    return { success: result.changes > 0 };
  }

  setMeetingRunArtifact(id: string, artifact: MeetingRunArtifact): { success: boolean } {
    meetingRecordingIdSchema.parse(id);
    meetingRunArtifactSchema.parse(artifact);
    const column = artifact === "provider-response"
      ? "raw_response_path"
      : artifact === "transcript"
        ? "transcript_path"
        : "summary_path";
    const name = artifact === "provider-response"
      ? "raw-provider-response.json"
      : artifact === "transcript"
        ? "transcript.json"
        : "summary.json";
    const audioRequired = artifact === "provider-response";
    const prerequisite = artifact === "transcript"
      ? "AND meeting_processing_runs.raw_response_path IS NOT NULL"
      : artifact === "summary"
        ? "AND (meeting_processing_runs.transcript_path IS NOT NULL OR (meeting_processing_runs.kind = 'summary' AND meeting_processing_runs.source_run_id IS NOT NULL))"
        : "";
    const immutableRawResponse = artifact === "provider-response" ? "AND raw_response_path IS NULL" : "";
    const result = this.sql.prepare(
      `UPDATE meeting_processing_runs SET ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? ${immutableRawResponse} ${prerequisite} AND EXISTS (SELECT 1 FROM meeting_recordings r LEFT JOIN meeting_deletion_intents d ON d.note_id = r.note_id AND d.kind = 'note' WHERE r.id = meeting_processing_runs.recording_id AND (? = 0 OR r.audio_state = 'available') AND d.id IS NULL)`
    ).run(name, id, audioRequired ? 1 : 0);
    return { success: result.changes > 0 };
  }

  reconcileMeetingRunArtifact(id: string, artifact: MeetingRunArtifact): { success: boolean } {
    meetingRecordingIdSchema.parse(id);
    meetingRunArtifactSchema.parse(artifact);
    const column = artifact === "provider-response"
      ? "raw_response_path"
      : artifact === "transcript"
        ? "transcript_path"
        : "summary_path";
    const name = meetingRunArtifactFileName(artifact);
    const prerequisite = artifact === "transcript"
      ? "AND raw_response_path IS NOT NULL"
      : artifact === "summary"
        ? "AND (transcript_path IS NOT NULL OR (kind = 'summary' AND source_run_id IS NOT NULL))"
        : "";
    const result = this.sql.prepare(
      `UPDATE meeting_processing_runs SET ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND ${column} IS NULL ${prerequisite} AND EXISTS (SELECT 1 FROM meeting_recordings r LEFT JOIN meeting_deletion_intents d ON d.note_id = r.note_id AND d.kind = 'note' WHERE r.id = meeting_processing_runs.recording_id AND (? = 0 OR r.audio_state = 'available') AND d.id IS NULL)`
    ).run(name, id, artifact === "provider-response" ? 1 : 0);
    return { success: result.changes > 0 };
  }

  updateBlockedMeetingRunConfig(
    id: string,
    config: MeetingProcessingConfig | null,
    error: MeetingProcessingConfigError | null = null
  ): MeetingProcessingRunDto | null {
    meetingRecordingIdSchema.parse(id);
    if (config !== null) meetingProcessingConfigSchema.parse(config);
    if (error !== null) meetingProcessingConfigErrorSchema.parse(error);
    const row = this.sql.prepare(
      "SELECT p.*, r.audio_state, r.note_id FROM meeting_processing_runs p JOIN meeting_recordings r ON r.id = p.recording_id WHERE p.id = ? AND p.status = 'blocked'"
    ).get(id) as (MeetingProcessingRunDbRow & { audio_state: MeetingAudioState; note_id: number }) | undefined;
    if (!row || row.kind === "summary" || this.isMeetingNoteDeletionPending(row.note_id)) return null;

    const hasNoArtifacts = row.raw_response_path === null && row.transcript_path === null && row.summary_path === null;
    if (!hasNoArtifacts) {
      const previousConfig = parseConfig(row.config_json);
      const summaryOnlyCorrection =
        row.stage === "summary" &&
        row.error_code === "missing-summary-config" &&
        row.config_error_code === null &&
        row.raw_response_path !== null &&
        row.transcript_path !== null &&
        row.summary_path === null &&
        config !== null &&
        config.summary != null &&
        error === null &&
        previousConfig?.summary == null &&
        JSON.stringify(previousConfig?.transcription) === JSON.stringify(config.transcription);
      if (!summaryOnlyCorrection) return null;
      const updated = this.sql.prepare(
        "UPDATE meeting_processing_runs SET config_json = ?, config_error_code = NULL, config_error_message_key = NULL, status = 'pending', error_code = NULL, retry_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'blocked' AND stage = 'summary' AND error_code = 'missing-summary-config' AND transcript_path IS NOT NULL AND summary_path IS NULL"
      ).run(configJson(config), id);
      return updated.changes === 1 ? this.getMeetingProcessingRun(id) : null;
    }

    if (row.kind === "reprocess" && row.audio_state !== "available") return null;
    const nextError = error ?? (config === null ? { code: "missing-config" } : null);
    const transcription = config?.transcription;
    const provider = transcription?.mode === "local" ? transcription.local?.provider ?? null : transcription?.provider ?? null;
    const model = transcription?.mode === "local" ? transcription.local?.model ?? null : transcription?.model ?? null;
    this.sql.prepare(
      "UPDATE meeting_processing_runs SET provider = ?, model = ?, config_json = ?, config_error_code = ?, config_error_message_key = ?, status = ?, error_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'blocked'"
    ).run(
      provider,
      model,
      configJson(config),
      nextError?.code ?? null,
      nextError?.messageKey ?? null,
      config === null || error !== null ? "blocked" : "pending",
      nextError?.code ?? null,
      id
    );
    return this.getMeetingProcessingRun(id);
  }

  setMeetingRunSpeakerCorrection(
    runId: string,
    speakerId: string,
    profileId: number | null,
    displayName: string
  ): { success: boolean } {
    meetingRecordingIdSchema.parse(runId);
    const run = this.getMeetingProcessingRun(runId);
    if (!run || !speakerId.trim() || !displayName.trim()) return { success: false };
    if (profileId !== null && (!Number.isSafeInteger(profileId) || profileId < 1)) return { success: false };
    const transaction = this.sql.transaction(() => {
      const recording = this.sql
        .prepare("SELECT note_id, current_run_id FROM meeting_recordings WHERE id = ?")
        .get(run.recordingId) as { note_id: number; current_run_id: string | null } | undefined;
      if (!recording || this.isMeetingNoteDeletionPending(recording.note_id)) return false;
      this.sql.prepare(
        "INSERT INTO meeting_run_speaker_corrections (run_id, speaker_id, profile_id, display_name) VALUES (?, ?, ?, ?) ON CONFLICT(run_id, speaker_id) DO UPDATE SET profile_id = excluded.profile_id, display_name = excluded.display_name"
      ).run(runId, speakerId, profileId, displayName.trim());
      if (recording.current_run_id === runId) {
        const note = this.sql
          .prepare("SELECT content, transcript FROM notes WHERE id = ?")
          .get(recording.note_id) as { content: string; transcript: string | null } | undefined;
        if (note?.transcript) {
          try {
            const segments = JSON.parse(note.transcript) as Array<Record<string, unknown>>;
            let changed = false;
            for (const segment of segments) {
              if (segment.speaker !== speakerId) continue;
              segment.speakerName = displayName.trim();
              segment.speakerIsPlaceholder = false;
              segment.speakerStatus = "locked";
              segment.speakerLocked = true;
              segment.speakerLockSource = "user";
              changed = true;
            }
            if (changed) {
              const transcript = JSON.stringify(segments);
              this.sql.prepare(
                "UPDATE notes SET transcript = ?, enhanced_at_content_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
              ).run(transcript, noteContentHash(`${note.content}\n${transcript}`), recording.note_id);
            }
          } catch (error) {
            throw new Error("Meeting transcript projection is invalid", { cause: error });
          }
        }
      }
      return true;
    });
    return { success: transaction() };
  }

  getMeetingRunSpeakerCorrections(runId: string): Array<{ speakerId: string; profileId: number | null; displayName: string }> {
    meetingRecordingIdSchema.parse(runId);
    return (this.sql.prepare(
      "SELECT speaker_id, profile_id, display_name FROM meeting_run_speaker_corrections WHERE run_id = ? ORDER BY speaker_id"
    ).all(runId) as Array<{ speaker_id: string; profile_id: number | null; display_name: string }>).map((row) => ({
      speakerId: row.speaker_id,
      profileId: row.profile_id,
      displayName: row.display_name,
    }));
  }

  selectMeetingProcessingRun(
    recordingId: string,
    runId: string,
    projection: { transcript: string; summary: string | null; summaryPrompt: string | null } | null
  ): { success: boolean; noteId?: number } {
    meetingRecordingIdSchema.parse(recordingId);
    meetingRecordingIdSchema.parse(runId);
    const transaction = this.sql.transaction(() => {
      const row = this.sql.prepare(
        "SELECT r.note_id FROM meeting_recordings r JOIN meeting_processing_runs p ON p.recording_id = r.id WHERE r.id = ? AND p.id = ? AND NOT EXISTS (SELECT 1 FROM meeting_deletion_intents d WHERE d.note_id = r.note_id AND d.kind = 'note')"
      ).get(recordingId, runId) as { note_id: number } | undefined;
      if (!row) return { success: false as const };
      if (projection) {
        const note = this.sql.prepare("SELECT content FROM notes WHERE id = ?").get(row.note_id) as
          | { content: string }
          | undefined;
        if (!note) throw new Error("Meeting note not found");
        this.sql.prepare(
          "UPDATE notes SET transcript = ?, enhanced_content = ?, enhancement_prompt = ?, enhanced_at_content_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).run(
          projection.transcript,
          projection.summary,
          projection.summaryPrompt,
          projection.summary === null
            ? null
            : noteContentHash(`${note.content}\n${projection.transcript}`),
          row.note_id
        );
      }
      this.sql.prepare(
        "UPDATE meeting_recordings SET current_run_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(runId, recordingId);
      return { success: true as const, noteId: row.note_id };
    });
    return transaction();
  }

  isMeetingNoteDeletionPending(noteId: number): boolean {
    return this.sql
      .prepare("SELECT 1 FROM meeting_deletion_intents WHERE note_id = ? AND kind = 'note'")
      .get(noteId) != null;
  }

  beginMeetingAudioDeletion(recordingId: string): MeetingDeletionIntentDto | null {
    meetingRecordingIdSchema.parse(recordingId);
    const transaction = this.sql.transaction(() => {
      const recording = this.getMeetingRecording(recordingId);
      if (!recording || recording.audioState === "deleted" || this.isMeetingNoteDeletionPending(recording.noteId)) {
        return null;
      }
      if (recording.captureState === "recording" || recording.captureState === "finalizing") {
        throw new Error("Active meeting recording must be stopped before deletion");
      }
      this.sql
        .prepare("UPDATE meeting_recordings SET audio_state = 'deleting', audio_error_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(recordingId);
      this.sql.prepare(
        "UPDATE meeting_processing_runs SET status = 'cancelled', error_code = 'audio-deletion-requested', retry_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE (recording_id = ? OR source_recording_ids_json LIKE ?) AND status IN ('pending', 'running') AND stage IN ('prepare', 'asr') AND raw_response_path IS NULL"
      ).run(recordingId, `%\"${recordingId}\"%`);
      const existing = this.sql
        .prepare("SELECT * FROM meeting_deletion_intents WHERE recording_id = ? AND kind = 'audio'")
        .get(recordingId) as MeetingDeletionIntentDbRow | undefined;
      const id = existing?.id ?? randomUUID();
      if (existing) {
        this.sql.prepare("UPDATE meeting_deletion_intents SET status = 'pending', error_code = NULL WHERE id = ?").run(id);
      } else {
        this.sql
          .prepare("INSERT INTO meeting_deletion_intents (id, kind, note_id, recording_id) VALUES (?, 'audio', ?, ?)")
          .run(id, recording.noteId, recordingId);
      }
      return toMeetingDeletionIntentDto(
        this.sql.prepare("SELECT * FROM meeting_deletion_intents WHERE id = ?").get(id) as MeetingDeletionIntentDbRow
      );
    });
    return transaction();
  }

  beginMeetingNoteDeletion(noteId: number): MeetingDeletionIntentDto | null {
    if (!Number.isSafeInteger(noteId) || noteId < 1 || !this.getNote(noteId)) return null;
    const transaction = this.sql.transaction(() => {
      const active = this.sql
        .prepare("SELECT 1 FROM meeting_recordings WHERE note_id = ? AND capture_state IN ('recording', 'finalizing') LIMIT 1")
        .get(noteId);
      if (active) throw new Error("Active meeting recording must be stopped before deletion");
      const existing = this.sql
        .prepare("SELECT * FROM meeting_deletion_intents WHERE note_id = ? AND kind = 'note'")
        .get(noteId) as MeetingDeletionIntentDbRow | undefined;
      const id = existing?.id ?? randomUUID();
      if (existing) {
        this.sql.prepare("UPDATE meeting_deletion_intents SET status = 'pending', error_code = NULL WHERE id = ?").run(id);
      } else {
        this.sql.prepare("INSERT INTO meeting_deletion_intents (id, kind, note_id) VALUES (?, 'note', ?)").run(id, noteId);
      }
      this.sql
        .prepare("UPDATE meeting_recordings SET audio_state = 'deleting', audio_error_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE note_id = ?")
        .run(noteId);
      return toMeetingDeletionIntentDto(
        this.sql.prepare("SELECT * FROM meeting_deletion_intents WHERE id = ?").get(id) as MeetingDeletionIntentDbRow
      );
    });
    return transaction();
  }

  listMeetingDeletionIntents(): MeetingDeletionIntentDto[] {
    return (this.sql
      .prepare("SELECT * FROM meeting_deletion_intents ORDER BY requested_at, id")
      .all() as MeetingDeletionIntentDbRow[]).map(toMeetingDeletionIntentDto);
  }

  getMeetingNoteStorageIds(noteId: number): { recordingIds: string[]; runIds: string[] } {
    return {
      recordingIds: (this.sql
        .prepare("SELECT id FROM meeting_recordings WHERE note_id = ? ORDER BY id")
        .all(noteId) as Array<{ id: string }>).map((row) => row.id),
      runIds: (this.sql
        .prepare("SELECT id FROM meeting_processing_runs WHERE recording_id IN (SELECT id FROM meeting_recordings WHERE note_id = ?) ORDER BY id")
        .all(noteId) as Array<{ id: string }>).map((row) => row.id),
    };
  }

  failMeetingDeletion(id: string, errorCode: string): { success: boolean } {
    meetingRecordingIdSchema.parse(id);
    meetingProcessingConfigErrorSchema.parse({ code: errorCode });
    const transaction = this.sql.transaction(() => {
      const intent = this.sql.prepare("SELECT * FROM meeting_deletion_intents WHERE id = ?").get(id) as
        | MeetingDeletionIntentDbRow
        | undefined;
      if (!intent) return false;
      this.sql.prepare("UPDATE meeting_deletion_intents SET status = 'failed', error_code = ? WHERE id = ?").run(errorCode, id);
      if (intent.kind === "audio" && intent.recording_id) {
        this.sql.prepare("UPDATE meeting_recordings SET audio_error_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(errorCode, intent.recording_id);
      }
      return true;
    });
    return { success: transaction() };
  }

  completeMeetingAudioDeletion(id: string): { success: boolean } {
    meetingRecordingIdSchema.parse(id);
    const transaction = this.sql.transaction(() => {
      const intent = this.sql.prepare("SELECT * FROM meeting_deletion_intents WHERE id = ? AND kind = 'audio'").get(id) as
        | MeetingDeletionIntentDbRow
        | undefined;
      if (!intent?.recording_id) return false;
      this.sql
        .prepare("UPDATE meeting_recordings SET audio_state = 'deleted', audio_error_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(intent.recording_id);
      this.sql.prepare("DELETE FROM meeting_deletion_intents WHERE id = ?").run(id);
      return true;
    });
    return { success: transaction() };
  }

  completeMeetingNoteDeletion(id: string): { success: boolean } {
    meetingRecordingIdSchema.parse(id);
    const transaction = this.sql.transaction(() => {
      const intent = this.sql.prepare("SELECT * FROM meeting_deletion_intents WHERE id = ? AND kind = 'note'").get(id) as
        | MeetingDeletionIntentDbRow
        | undefined;
      if (!intent) return false;
      this.sql.prepare("DELETE FROM meeting_recordings WHERE note_id = ?").run(intent.note_id);
      this.sql.prepare("DELETE FROM meeting_deletion_intents WHERE id = ?").run(id);
      return this.sql.prepare("DELETE FROM notes WHERE id = ?").run(intent.note_id).changes > 0;
    });
    return { success: transaction() };
  }

  _privateSpaceId(): number | null {
    return (
      (this.sql.prepare("SELECT id FROM spaces WHERE kind = 'private' LIMIT 1").get() as
        | { id: number }
        | undefined)?.id ?? null
    );
  }

  getPrivateSpaceId(): number | null {
    return this._privateSpaceId();
  }

  _spaceRow(row: SpaceRow | undefined | null): SpaceRow | null {
    return row ? { ...row, kind: "private" } : null;
  }

  getSpaces(): SpaceRow[] {
    return (this.sql.prepare("SELECT * FROM spaces ORDER BY sort_order, id").all() as SpaceRow[]).map(
      (row) => this._spaceRow(row) as SpaceRow
    );
  }

  getSpace(id: number): SpaceRow | null {
    return this._spaceRow(
      this.sql.prepare("SELECT * FROM spaces WHERE id = ?").get(id) as SpaceRow | undefined
    );
  }

  updateSpace(
    id: number,
    { name, emoji }: { name?: string; emoji?: string | null } = {}
  ): { success: boolean; space?: SpaceRow | null } {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (name !== undefined) {
      fields.push("name = ?");
      values.push(name);
    }
    if (emoji !== undefined) {
      fields.push("emoji = ?");
      values.push(emoji);
    }
    if (fields.length === 0) return { success: false };
    values.push(id);
    const result = this.sql
      .prepare(`UPDATE spaces SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(...values);
    return { success: result.changes > 0, space: this.getSpace(id) };
  }

  getFolders(spaceId: number | null = null): FolderRow[] {
    const sql =
      spaceId == null
        ? "SELECT * FROM folders ORDER BY sort_order, created_at"
        : "SELECT * FROM folders WHERE space_id = ? ORDER BY sort_order, created_at";
    return (spaceId == null
      ? this.sql.prepare(sql).all()
      : this.sql.prepare(sql).all(spaceId)) as FolderRow[];
  }

  createFolder(
    name: unknown,
    spaceId: number | null = null
  ): { success: boolean; error?: string; folder?: FolderRow } {
    const trimmed = String(name || "").trim();
    spaceId ??= this._privateSpaceId();
    if (!trimmed) return { success: false, error: "Folder name is required" };
    if (!spaceId || !this.getSpace(spaceId)) return { success: false, error: "Space not found" };
    const max = (this.sql
      .prepare("SELECT COALESCE(MAX(sort_order), -1) AS value FROM folders WHERE space_id = ?")
      .get(spaceId) as { value: number }).value;
    try {
      const result = this.sql
        .prepare("INSERT INTO folders (name, sort_order, space_id) VALUES (?, ?, ?)")
        .run(trimmed, max + 1, spaceId);
      return {
        success: true,
        folder: this.sql.prepare("SELECT * FROM folders WHERE id = ?").get(result.lastInsertRowid) as
          | FolderRow
          | undefined,
      };
    } catch (error) {
      if (isSqliteUniqueConstraint(error))
        return { success: false, error: "A folder with that name already exists" };
      throw error;
    }
  }

  renameFolder(id: number, name: unknown): { success: boolean; error?: string; folder?: FolderRow } {
    const trimmed = String(name || "").trim();
    if (!trimmed) return { success: false, error: "Folder name is required" };
    try {
      const result = this.sql
        .prepare("UPDATE folders SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(trimmed, id);
      return {
        success: result.changes > 0,
        folder: this.sql.prepare("SELECT * FROM folders WHERE id = ?").get(id) as
          | FolderRow
          | undefined,
      };
    } catch (error) {
      if (isSqliteUniqueConstraint(error))
        return { success: false, error: "A folder with that name already exists" };
      throw error;
    }
  }

  deleteFolder(id: number): { success: boolean } {
    const result = this.sql.transaction(() => {
      // A note whose primary folder goes away keeps living in its next folder.
      this.sql.prepare(`
        UPDATE notes SET folder_id = (
          SELECT MIN(nf.folder_id) FROM note_folders nf WHERE nf.note_id = notes.id AND nf.folder_id != ?
        )
        WHERE folder_id = ? AND EXISTS (
          SELECT 1 FROM note_folders nf WHERE nf.note_id = notes.id AND nf.folder_id != ?
        )
      `).run(id, id, id);
      this.pruneNoteFolderLinks();
      return this.sql.prepare("DELETE FROM folders WHERE id = ?").run(id);
    })();
    return { success: result.changes > 0 };
  }

  /** Extra folders must share the note's space and never repeat its primary folder. */
  private pruneNoteFolderLinks(): void {
    this.sql.prepare(`
      DELETE FROM note_folders WHERE EXISTS (
        SELECT 1 FROM notes n JOIN folders f ON f.id = note_folders.folder_id
        WHERE n.id = note_folders.note_id AND (f.space_id != n.space_id OR n.folder_id = note_folders.folder_id)
      )
    `).run();
  }

  moveFolderToSpace(
    id: number,
    spaceId: number
  ): { success: boolean; error?: string; folder?: FolderRow | null; notes?: NoteRow[] } {
    if (!this.getSpace(spaceId)) return { success: false, error: "Space not found" };
    try {
      const result = this.sql.transaction(() => {
        const folder = this.sql.prepare("SELECT id FROM folders WHERE id = ?").get(id);
        if (!folder) return { changes: 0, notes: [] as NoteRow[] };
        const updated = this.sql
          .prepare("UPDATE folders SET space_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(spaceId, id);
        this.sql
          .prepare("UPDATE notes SET space_id = ?, updated_at = CURRENT_TIMESTAMP WHERE folder_id = ?")
          .run(spaceId, id);
        this.pruneNoteFolderLinks();
        const notes = (this.sql
          .prepare(`SELECT ${noteColumns("notes")} FROM notes WHERE folder_id = ?`)
          .all(id) as RawNoteRow[]).map(hydrateNote);
        return { changes: updated.changes, notes };
      })();
      return {
        success: result.changes > 0,
        folder: (this.sql.prepare("SELECT * FROM folders WHERE id = ?").get(id) as FolderRow | undefined) ?? null,
        notes: result.notes,
      };
    } catch (error) {
      if (isSqliteUniqueConstraint(error))
        return { success: false, error: "A folder with that name already exists" };
      throw error;
    }
  }

  getFolderNoteCounts(): FolderNoteCountRow[] {
    return this.sql.prepare(`
      SELECT folder_id, space_id, COUNT(*) AS count FROM (
        SELECT folder_id, space_id FROM notes
        UNION ALL
        SELECT nf.folder_id, n.space_id FROM note_folders nf JOIN notes n ON n.id = nf.note_id
      ) GROUP BY folder_id, space_id
    `).all() as FolderNoteCountRow[];
  }

  getMeetingsFolder(spaceId: number | null = null): FolderRow | null {
    spaceId ??= this._privateSpaceId();
    return (
      (this.sql
        .prepare("SELECT * FROM folders WHERE space_id = ? AND name = 'Meetings' LIMIT 1")
        .get(spaceId) as FolderRow | undefined) || null
    );
  }

  saveTranscription(
    text: string,
    rawText: string | null = null,
    options: {
      status?: string;
      errorMessage?: string | null;
      errorCode?: string | null;
      routeKind?: string | null;
      occurredAt?: unknown;
    } = {}
  ): { id: number; success: boolean; transcription: TranscriptionRow | null } {
    const { status = "completed", errorMessage = null, errorCode = null, routeKind = null } = options;
    const timestamp = toDbTimestamp(options.occurredAt) || null;
    const result = this.sql.prepare(`
      INSERT INTO transcriptions (text, raw_text, status, error_message, error_code, route_kind, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
    `).run(text, rawText, status, errorMessage, errorCode, routeKind, timestamp);
    return {
      id: Number(result.lastInsertRowid),
      success: true,
      transcription: this.getTranscriptionById(result.lastInsertRowid),
    };
  }

  getTranscriptions(limit = 50, { includeDiscarded = false } = {}): TranscriptionRow[] {
    const filter = includeDiscarded ? "" : " WHERE status != 'discarded'";
    return this.sql
      .prepare(`SELECT * FROM transcriptions${filter} ORDER BY timestamp DESC LIMIT ?`)
      .all(limit) as TranscriptionRow[];
  }

  clearTranscriptions(): { success: boolean; cleared: number } {
    const result = this.sql.prepare("DELETE FROM transcriptions").run();
    return { success: true, cleared: result.changes };
  }

  deleteTranscriptionsExpiredBefore(retentionDays: number): { ids: number[] } {
    const cutoff = (this.sql.prepare("SELECT datetime('now', ?) AS cutoff").get(`-${retentionDays} days`) as { cutoff: string }).cutoff;
    const ids = (this.sql
      .prepare("SELECT id FROM transcriptions WHERE created_at < ?")
      .all(cutoff) as Array<{ id: number }>).map((row) => row.id);
    this.sql.prepare("DELETE FROM transcriptions WHERE created_at < ?").run(cutoff);
    return { ids };
  }

  deleteTranscription(id: number): { success: boolean; id: number } {
    const result = this.sql.prepare("DELETE FROM transcriptions WHERE id = ?").run(id);
    return { success: result.changes > 0, id };
  }

  updateTranscriptionAudio(
    id: number,
    {
      hasAudio,
      audioDurationMs,
      provider,
      model,
    }: {
      hasAudio?: boolean | number;
      audioDurationMs?: number | null;
      provider?: string | null;
      model?: string | null;
    }
  ): { success: boolean } {
    this.sql
      .prepare(
        "UPDATE transcriptions SET has_audio = ?, audio_duration_ms = ?, provider = ?, model = ? WHERE id = ?"
      )
      .run(hasAudio ? 1 : 0, audioDurationMs, provider, model, id);
    return { success: true };
  }

  updateTranscriptionText(id: number, text: string, rawText: string | null): { success: boolean } {
    this.sql
      .prepare("UPDATE transcriptions SET text = ?, raw_text = ? WHERE id = ?")
      .run(text, rawText, id);
    return { success: true };
  }

  updateTranscriptionStatus(
    id: number,
    status: string,
    errorMessage: string | null = null,
    errorCode: string | null = null
  ): { success: boolean } {
    this.sql
      .prepare("UPDATE transcriptions SET status = ?, error_message = ?, error_code = ? WHERE id = ?")
      .run(status, errorMessage, errorCode, id);
    return { success: true };
  }

  getTranscriptionById(id: number | bigint): TranscriptionRow | null {
    return (
      (this.sql.prepare("SELECT * FROM transcriptions WHERE id = ?").get(id) as
        | TranscriptionRow
        | undefined) || null
    );
  }

  getAudioFlaggedIds(): Array<{ id: number }> {
    return this.sql
      .prepare("SELECT id FROM transcriptions WHERE has_audio = 1")
      .all() as Array<{ id: number }>;
  }

  // IDs arrive both numeric (DB rows) and string-typed (audio filenames);
  // SQLite INTEGER affinity coerces either form, as it always has.
  clearAudioFlags(ids: Array<number | string>): { success: boolean } {
    if (!ids?.length) return { success: true };
    const update = this.sql.prepare("UPDATE transcriptions SET has_audio = 0 WHERE id = ?");
    this.sql.transaction(() => ids.forEach((id) => update.run(id)))();
    return { success: true };
  }

  getDictionary(): string[] {
    return (this.sql
      .prepare("SELECT word FROM custom_dictionary ORDER BY id")
      .all() as Array<{ word: string }>).map((row) => row.word);
  }

  setDictionary(words: unknown): { success: boolean } {
    const incoming = normalizeWords(words);
    const current = this.sql.prepare("SELECT id, word FROM custom_dictionary").all() as Array<{
      id: number;
      word: string;
    }>;
    const transaction = this.sql.transaction(() => {
      const remove = this.sql.prepare("DELETE FROM custom_dictionary WHERE id = ?");
      current.forEach((row) => {
        if (!incoming.has(row.word.toLowerCase())) remove.run(row.id);
      });
      const insert = this.sql.prepare("INSERT OR IGNORE INTO custom_dictionary (word) VALUES (?)");
      incoming.forEach((word) => insert.run(word));
    });
    transaction();
    return { success: true };
  }

  applyDictionaryChanges({
    add = [],
    remove = [],
  }: { add?: unknown; remove?: unknown } = {}): {
    success: boolean;
    added: number;
    removed: number;
  } {
    const additions = normalizeWords(add);
    const removals = normalizeWords(remove);
    const transaction = this.sql.transaction(() => {
      const removeStmt = this.sql.prepare(
        "DELETE FROM custom_dictionary WHERE lower(word) = lower(?)"
      );
      removals.forEach((word) => removeStmt.run(word));
      const addStmt = this.sql.prepare("INSERT OR IGNORE INTO custom_dictionary (word) VALUES (?)");
      additions.forEach((word) => addStmt.run(word));
    });
    transaction();
    return { success: true, added: additions.size, removed: removals.size };
  }

  hardDeleteDictionaryEntry(id: number): { success: boolean } {
    return {
      success: this.sql.prepare("DELETE FROM custom_dictionary WHERE id = ?").run(id).changes > 0,
    };
  }

  getSnippets(): Array<{ trigger: string; replacement: string }> {
    return this.sql
      .prepare("SELECT trigger, replacement FROM snippets ORDER BY id")
      .all() as Array<{ trigger: string; replacement: string }>;
  }

  setSnippets(snippets: unknown): { success: boolean } {
    const incoming = new Map<string, { trigger: string; replacement: string }>();
    for (const item of (Array.isArray(snippets) ? snippets : []) as Array<Record<string, unknown>>) {
      const trigger = typeof item?.trigger === "string" ? item.trigger.trim() : "";
      const replacement = typeof item?.replacement === "string" ? item.replacement.trim() : "";
      if (trigger && replacement && trigger.length <= MAX_SNIPPET_TRIGGER_LENGTH)
        incoming.set(trigger.toLowerCase(), { trigger, replacement });
    }
    const transaction = this.sql.transaction(() => {
      this.sql.prepare("DELETE FROM snippets").run();
      const insert = this.sql.prepare("INSERT INTO snippets (trigger, replacement) VALUES (?, ?)");
      incoming.forEach(({ trigger, replacement }) => insert.run(trigger, replacement));
    });
    transaction();
    return { success: true };
  }

  hardDeleteSnippet(id: number): { success: boolean } {
    return { success: this.sql.prepare("DELETE FROM snippets WHERE id = ?").run(id).changes > 0 };
  }

  saveNote(
    title: string,
    content: string,
    noteType = "personal",
    sourceFile: string | null = null,
    audioDuration: number | null = null,
    folderId: number | null = null,
    spaceId: number | null = null
  ): { success: boolean; note: NoteRow | null } {
    spaceId ??= this._privateSpaceId();
    if (folderId != null) {
      spaceId = (this.sql.prepare("SELECT space_id FROM folders WHERE id = ?").get(folderId) as
        | { space_id: number }
        | undefined)?.space_id ?? null;
    }
    if (!spaceId || !this.getSpace(spaceId)) throw new Error("Space not found");
    if (folderId == null) {
      const folderName = noteType === "meeting" ? "Meetings" : "Personal";
      folderId =
        (this.sql
          .prepare("SELECT id FROM folders WHERE space_id = ? AND name = ? LIMIT 1")
          .get(spaceId, folderName) as { id: number } | undefined)?.id ?? null;
    }
    const result = this.sql
      .prepare(
        "INSERT INTO notes (title, content, note_type, source_file, audio_duration_seconds, folder_id, space_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(title, content, noteType, sourceFile, audioDuration, folderId, spaceId);
    return { success: true, note: this.getNote(result.lastInsertRowid) };
  }

  importNotes(
    rows: unknown,
    { noteType = "meeting", folderName = "Imported" } = {}
  ): {
    success: boolean;
    imported: number;
    skipped: number;
    folderId: number | null;
    noteIds: number[];
    errors: Array<{ error: string }>;
  } {
    const spaceId = this._privateSpaceId();
    let folderId: number | null =
      (this.sql
        .prepare("SELECT id FROM folders WHERE space_id = ? AND name = ?")
        .get(spaceId, folderName) as { id: number } | undefined)?.id ?? null;
    if (!folderId) folderId = this.createFolder(folderName, spaceId).folder?.id ?? null;
    let imported = 0;
    const noteIds: number[] = [];
    const errors: Array<{ error: string }> = [];
    const insert = this.sql.prepare(
      "INSERT INTO notes (title, content, note_type, source_file, folder_id, space_id, transcript, participants, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))"
    );
    this.sql.transaction(() => {
      for (const row of (Array.isArray(rows) ? rows : []) as Array<Record<string, unknown>>) {
        try {
          const result = insert.run(
            row.title,
            row.content,
            noteType,
            row.sourceFile,
            folderId,
            spaceId,
            row.transcript,
            row.participants,
            row.createdAt,
            row.createdAt
          );
          imported += 1;
          noteIds.push(Number(result.lastInsertRowid));
        } catch (error) {
          errors.push({ error: (error as Error).message });
        }
      }
    })();
    return { success: true, imported, skipped: 0, folderId, noteIds, errors };
  }

  getNote(id: number | bigint): NoteRow | null {
    const raw = this.sql
      .prepare(`SELECT ${noteColumns("notes")} FROM notes WHERE id = ?`)
      .get(id) as RawNoteRow | undefined;
    return raw ? hydrateNote(raw) : null;
  }

  getNotes(
    noteType: string | null = null,
    limit = 100,
    folderId: number | null = null,
    spaceId: number | null = null
  ): NoteRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (noteType) {
      conditions.push("note_type = ?");
      params.push(noteType);
    }
    if (folderId != null) {
      conditions.push("(folder_id = ? OR id IN (SELECT note_id FROM note_folders WHERE folder_id = ?))");
      params.push(folderId, folderId);
    }
    if (spaceId != null) {
      conditions.push("space_id = ?");
      params.push(spaceId);
      if (folderId == null) conditions.push("folder_id IS NULL");
    }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    return (this.sql
      .prepare(`SELECT ${noteColumns("notes")} FROM notes${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, limit) as RawNoteRow[]).map(hydrateNote);
  }

  getNotesForSpace(spaceId: number, limit = 50): NoteRow[] {
    return (this.sql
      .prepare(`SELECT ${noteColumns("notes")} FROM notes WHERE space_id = ? ORDER BY updated_at DESC LIMIT ?`)
      .all(spaceId, limit) as RawNoteRow[]).map(hydrateNote);
  }

  getNoteIdsInFolder(folderId: number): number[] {
    return (this.sql
      .prepare("SELECT id FROM notes WHERE (folder_id = ? OR id IN (SELECT note_id FROM note_folders WHERE folder_id = ?))")
      .all(folderId, folderId) as Array<{ id: number }>).map((row) => row.id);
  }

  getNoteIdsInScope(
    spaceId: number | null = null,
    folderId: number | null = null,
    candidateIds: number[] | null = null
  ): number[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (spaceId != null) {
      conditions.push("space_id = ?");
      params.push(spaceId);
    }
    if (folderId != null) {
      conditions.push("(folder_id = ? OR id IN (SELECT note_id FROM note_folders WHERE folder_id = ?))");
      params.push(folderId, folderId);
    }
    if (candidateIds) {
      if (!candidateIds.length) return [];
      conditions.push(`id IN (${candidateIds.map(() => "?").join(",")})`);
      params.push(...candidateIds);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    return (this.sql
      .prepare(`SELECT id FROM notes${where}`)
      .all(...params) as Array<{ id: number }>).map((row) => row.id);
  }

  updateNote(
    id: number,
    updates: Partial<{
      title: string;
      content: string;
      enhanced_content: string | null;
      enhancement_prompt: string | null;
      enhanced_at_content_hash: string | null;
      folder_id: number | null;
      /** Full folder membership; the current primary stays primary when kept. */
      folder_ids: number[];
      space_id: number;
      transcript: string | null;
      calendar_event_id: string | null;
      participants: string | null;
      diarization_enabled: number | null;
      expected_speaker_count: number | null;
      source_file: string | null;
      audio_duration_seconds: number | null;
      note_type: string;
    }>
  ): { success: boolean; error?: string; note?: NoteRow | null } {
    const current = this.getNote(id);
    if (!current) return { success: false, error: "Note not found" };
    let extraFolderIds: number[] | null = null;
    if (updates.folder_ids !== undefined) {
      if (updates.folder_id !== undefined) {
        return { success: false, error: "Pass folder_id or folder_ids, not both" };
      }
      const ids = [...new Set(updates.folder_ids)];
      const known = ids.length
        ? (this.sql
            .prepare(`SELECT COUNT(*) AS count FROM folders WHERE id IN (${ids.map(() => "?").join(",")})`)
            .get(...ids) as { count: number }).count
        : 0;
      if (known !== ids.length) return { success: false, error: "Folder not found" };
      const primary =
        ids.length === 0 ? null : current.folder_id != null && ids.includes(current.folder_id) ? current.folder_id : ids[0];
      updates = { ...updates, folder_id: primary };
      extraFolderIds = ids.filter((folderId) => folderId !== primary);
    }
    const allowed = [
      "title",
      "content",
      "enhanced_content",
      "enhancement_prompt",
      "enhanced_at_content_hash",
      "folder_id",
      "space_id",
      "transcript",
      "calendar_event_id",
      "participants",
      "diarization_enabled",
      "expected_speaker_count",
      "source_file",
      "audio_duration_seconds",
      "note_type",
    ] as const;
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const key of allowed)
      if (updates[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(updates[key]);
      }
    if (updates.folder_id != null) {
      const folder = this.sql.prepare("SELECT space_id FROM folders WHERE id = ?").get(
        updates.folder_id
      ) as { space_id: number } | undefined;
      if (!folder) return { success: false, error: "Folder not found" };
      if (updates.space_id === undefined) {
        fields.push("space_id = ?");
        values.push(folder.space_id);
      }
    }
    if (!fields.length) return { success: false };
    values.push(id);
    const result = this.sql.transaction(() => {
      const updated = this.sql
        .prepare(`UPDATE notes SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(...values);
      if (extraFolderIds) {
        this.sql.prepare("DELETE FROM note_folders WHERE note_id = ?").run(id);
        const link = this.sql.prepare("INSERT INTO note_folders (note_id, folder_id) VALUES (?, ?)");
        for (const folderId of extraFolderIds) link.run(id, folderId);
      }
      if (extraFolderIds || updates.folder_id !== undefined || updates.space_id !== undefined) {
        this.pruneNoteFolderLinks();
      }
      return updated;
    })();
    return { success: result.changes > 0, note: this.getNote(id) };
  }

  deleteNote(id: number): { success: boolean } {
    if (
      this.sql.prepare("SELECT 1 FROM meeting_recordings WHERE note_id = ? LIMIT 1").get(id) != null ||
      this.isMeetingNoteDeletionPending(id)
    ) {
      return { success: false };
    }
    const result = this.sql.prepare("DELETE FROM notes WHERE id = ?").run(id);
    return { success: result.changes > 0 };
  }

  getFolderNoteCountsBySpace(spaceId: number): FolderNoteCountRow[] {
    return this.getFolderNoteCounts().filter((row) => row.space_id === spaceId);
  }

  getActions(): ActionRow[] {
    return this.sql.prepare("SELECT * FROM actions ORDER BY sort_order, id").all() as ActionRow[];
  }
  getAction(id: number): ActionRow | null {
    return (
      (this.sql.prepare("SELECT * FROM actions WHERE id = ?").get(id) as ActionRow | undefined) ||
      null
    );
  }
  createAction(name: string, description: string, prompt: string, icon = "wand-sparkles"): {
    success: boolean;
    action: ActionRow | null;
  } {
    const result = this.sql
      .prepare("INSERT INTO actions (name, description, prompt, icon) VALUES (?, ?, ?, ?)")
      .run(name, description, prompt, icon);
    return { success: true, action: this.getAction(Number(result.lastInsertRowid)) };
  }
  updateAction(
    id: number,
    updates: Partial<{ name: string; description: string; prompt: string; icon: string; sort_order: number }>
  ): { success: boolean; action?: ActionRow | null } {
    const allowed = ["name", "description", "prompt", "icon", "sort_order"] as const;
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const key of allowed)
      if (updates[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(updates[key]);
      }
    if (!fields.length) return { success: false };
    values.push(id);
    const result = this.sql
      .prepare(`UPDATE actions SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(...values);
    return { success: result.changes > 0, action: this.getAction(id) };
  }
  deleteAction(id: number): { success: boolean } {
    return {
      success:
        this.sql.prepare("DELETE FROM actions WHERE id = ? AND is_builtin = 0").run(id).changes > 0,
    };
  }

  createAgentConversation(
    title = "Untitled",
    noteId: number | null = null,
    spaceId: number | null = null,
    folderId: number | null = null
  ): AgentConversationRow | null {
    const result = this.sql
      .prepare("INSERT INTO agent_conversations (title, note_id, space_id, folder_id) VALUES (?, ?, ?, ?)")
      .run(title, noteId, spaceId, folderId);
    return this.getAgentConversation(result.lastInsertRowid);
  }
  getAgentConversation(id: number | bigint): (AgentConversationRow & { messages: AgentMessageRow[] }) | null {
    const conversation = this.sql.prepare("SELECT * FROM agent_conversations WHERE id = ?").get(
      id
    ) as AgentConversationRow | undefined;
    return conversation ? { ...conversation, messages: this.getAgentMessages(Number(id)) } : null;
  }
  getAgentConversations(limit = 50): AgentConversationRow[] {
    return this.sql
      .prepare(
        "SELECT * FROM agent_conversations WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT ?"
      )
      .all(limit) as AgentConversationRow[];
  }
  getConversationsForNote(noteId: number, limit = 20): AgentConversationRow[] {
    return this.sql
      .prepare(
        "SELECT * FROM agent_conversations WHERE note_id = ? ORDER BY updated_at DESC LIMIT ?"
      )
      .all(noteId, limit) as AgentConversationRow[];
  }
  getConversationsForContainer(
    spaceId: number,
    folderId: number | null = null,
    limit = 20
  ): ContainerConversationRow[] {
    const fields =
      "c.*, (SELECT COUNT(*) FROM agent_messages m WHERE m.conversation_id = c.id) AS message_count";
    const sql =
      folderId == null
        ? `SELECT ${fields} FROM agent_conversations c WHERE c.space_id = ? AND c.folder_id IS NULL ORDER BY c.updated_at DESC LIMIT ?`
        : `SELECT ${fields} FROM agent_conversations c WHERE c.space_id = ? AND c.folder_id = ? ORDER BY c.updated_at DESC LIMIT ?`;
    return (folderId == null
      ? this.sql.prepare(sql).all(spaceId, limit)
      : this.sql.prepare(sql).all(spaceId, folderId, limit)) as ContainerConversationRow[];
  }
  addAgentMessage(
    conversationId: number,
    role: AgentMessageRow["role"],
    content: string,
    metadata: unknown
  ): AgentMessageRow | null {
    if (!this.getAgentConversation(conversationId)) return null;
    const result = this.sql
      .prepare(
        "INSERT INTO agent_messages (conversation_id, role, content, metadata) VALUES (?, ?, ?, ?)"
      )
      .run(conversationId, role, content, metadata ? JSON.stringify(metadata) : null);
    this.sql
      .prepare("UPDATE agent_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(conversationId);
    return (
      (this.sql.prepare("SELECT * FROM agent_messages WHERE id = ?").get(
        result.lastInsertRowid
      ) as AgentMessageRow | undefined) ?? null
    );
  }
  getAgentMessages(conversationId: number): AgentMessageRow[] {
    return this.sql
      .prepare("SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY created_at")
      .all(conversationId) as AgentMessageRow[];
  }
  getAgentConversationsWithPreview(
    limit = 50,
    offset = 0,
    includeArchived = false
  ): ConversationPreviewRow[] {
    const archive = includeArchived ? "" : "WHERE c.archived_at IS NULL";
    return this.sql
      .prepare(
        `SELECT c.*, (SELECT content FROM agent_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS preview FROM agent_conversations c ${archive} ORDER BY c.updated_at DESC LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as ConversationPreviewRow[];
  }
  searchAgentConversations(query: string, limit = 20): AgentConversationRow[] {
    const pattern = `%${query || ""}%`;
    return this.sql
      .prepare(
        "SELECT * FROM agent_conversations WHERE title LIKE ? ORDER BY updated_at DESC LIMIT ?"
      )
      .all(pattern, limit) as AgentConversationRow[];
  }
  updateAgentConversationTitle(id: number, title: string): { success: boolean } {
    const result = this.sql
      .prepare("UPDATE agent_conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(title, id);
    return { success: result.changes > 0 };
  }
  archiveAgentConversation(id: number): { success: boolean } {
    const result = this.sql
      .prepare("UPDATE agent_conversations SET archived_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(id);
    return { success: result.changes > 0 };
  }
  unarchiveAgentConversation(id: number): { success: boolean } {
    const result = this.sql
      .prepare("UPDATE agent_conversations SET archived_at = NULL WHERE id = ?")
      .run(id);
    return { success: result.changes > 0 };
  }
  deleteAgentConversation(id: number): { success: boolean } {
    const result = this.sql.prepare("DELETE FROM agent_conversations WHERE id = ?").run(id);
    return { success: result.changes > 0 };
  }

  private _discardPlaintextCalendarTokens(): void {
    const google = this.sql
      .prepare(
        "SELECT google_email AS email FROM google_calendar_tokens WHERE access_token NOT GLOB ? OR refresh_token NOT GLOB ?"
      )
      .all(`${CALENDAR_TOKEN_PREFIX}*`, `${CALENDAR_TOKEN_PREFIX}*`) as Array<{ email: string }>;
    const microsoft = this.sql
      .prepare(
        "SELECT microsoft_email AS email FROM microsoft_calendar_tokens WHERE access_token NOT GLOB ? OR refresh_token NOT GLOB ?"
      )
      .all(`${CALENDAR_TOKEN_PREFIX}*`, `${CALENDAR_TOKEN_PREFIX}*`) as Array<{ email: string }>;
    if (!google.length && !microsoft.length) return;

    const discard = this.sql.transaction(() => {
      for (const account of google) this.removeGoogleAccount(account.email);
      for (const account of microsoft) this.removeMicrosoftAccount(account.email);
    });
    discard();

    const checkpoint = this.sql.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
      | { busy?: number }
      | undefined;
    if (checkpoint?.busy !== 0) {
      throw new Error("Could not clear legacy plaintext calendar tokens from SQLite WAL");
    }
    debugLogger.info(
      "Removed legacy plaintext calendar credentials; reconnect required",
      { google: google.length, microsoft: microsoft.length },
      "database"
    );
  }

  private _hasTokenEncryptionBackend(): boolean {
    try {
      return secretCrypto.isAvailable();
    } catch {
      return false;
    }
  }

  private _decodeGoogleTokenRow(row: GoogleTokenRow | undefined): GoogleTokenRow | null {
    if (!row) return null;
    if (
      !row.access_token.startsWith(CALENDAR_TOKEN_PREFIX) ||
      !row.refresh_token.startsWith(CALENDAR_TOKEN_PREFIX)
    ) {
      this.removeGoogleAccount(row.google_email);
      return null;
    }
    try {
      return {
        ...row,
        access_token: decryptCalendarToken(row.access_token),
        refresh_token: decryptCalendarToken(row.refresh_token),
      };
    } catch {
      if (!this._hasTokenEncryptionBackend()) return null;
      this.removeGoogleAccount(row.google_email);
      debugLogger.warn("Unreadable Google Calendar credentials removed; reconnect required", {}, "database");
      return null;
    }
  }

  private _decodeMicrosoftTokenRow(row: MicrosoftTokenRow | undefined): MicrosoftTokenRow | null {
    if (!row) return null;
    if (
      !row.access_token.startsWith(CALENDAR_TOKEN_PREFIX) ||
      !row.refresh_token.startsWith(CALENDAR_TOKEN_PREFIX)
    ) {
      this.removeMicrosoftAccount(row.microsoft_email);
      return null;
    }
    try {
      return {
        ...row,
        access_token: decryptCalendarToken(row.access_token),
        refresh_token: decryptCalendarToken(row.refresh_token),
      };
    } catch {
      if (!this._hasTokenEncryptionBackend()) return null;
      this.removeMicrosoftAccount(row.microsoft_email);
      debugLogger.warn("Unreadable Microsoft Calendar credentials removed; reconnect required", {}, "database");
      return null;
    }
  }

  saveGoogleTokens(tokens: {
    google_email: string;
    access_token: string;
    refresh_token: string;
    expires_at: number;
    scope: string;
  }): { success: boolean } {
    this.sql
      .prepare(
        "INSERT INTO google_calendar_tokens (google_email, access_token, refresh_token, expires_at, scope) VALUES (?, ?, ?, ?, ?) ON CONFLICT(google_email) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, scope = excluded.scope, updated_at = CURRENT_TIMESTAMP"
      )
      .run(
        tokens.google_email,
        encryptCalendarToken(tokens.access_token),
        encryptCalendarToken(tokens.refresh_token),
        tokens.expires_at,
        tokens.scope
      );
    return { success: true };
  }
  getGoogleTokens(): GoogleTokenRow | null {
    return this.getAllGoogleTokens()[0] ?? null;
  }
  getGoogleTokensByEmail(email: string): GoogleTokenRow | null {
    const row = this.sql
      .prepare("SELECT * FROM google_calendar_tokens WHERE google_email = ?")
      .get(email) as GoogleTokenRow | undefined;
    return this._decodeGoogleTokenRow(row);
  }
  getAllGoogleTokens(): GoogleTokenRow[] {
    const rows = this.sql
      .prepare("SELECT * FROM google_calendar_tokens ORDER BY created_at")
      .all() as GoogleTokenRow[];
    return rows.flatMap((row) => {
      const decoded = this._decodeGoogleTokenRow(row);
      return decoded ? [decoded] : [];
    });
  }
  getGoogleAccounts(): CalendarAccountRow[] {
    return this.getAllGoogleTokens().map((tokens) => ({ email: tokens.google_email }));
  }
  deleteGoogleTokens(): { success: boolean } {
    this.sql.prepare("DELETE FROM google_calendar_tokens").run();
    return { success: true };
  }
  removeGoogleAccount(email: string): { success: boolean } {
    this.sql.prepare("DELETE FROM google_calendar_tokens WHERE google_email = ?").run(email);
    this.sql.prepare("DELETE FROM google_calendars WHERE account_email = ?").run(email);
    return { success: true };
  }
  saveGoogleCalendars(calendars: GoogleCalendarInput[], accountEmail: string | null = null): {
    success: boolean;
  } {
    const stmt = this.sql.prepare(
      "INSERT INTO google_calendars (id, summary, description, background_color, account_email, is_primary) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, description = excluded.description, background_color = excluded.background_color, account_email = excluded.account_email, is_primary = excluded.is_primary"
    );
    calendars.forEach((cal) =>
      stmt.run(
        cal.id,
        cal.summary,
        cal.description || null,
        cal.background_color || null,
        accountEmail,
        cal.is_primary ? 1 : 0
      )
    );
    return { success: true };
  }
  getGoogleCalendars(accountEmail: string | null = null): GoogleCalendarRow[] {
    return (accountEmail
      ? this.sql.prepare("SELECT * FROM google_calendars WHERE account_email = ?").all(accountEmail)
      : this.sql.prepare("SELECT * FROM google_calendars").all()) as GoogleCalendarRow[];
  }
  getSelectedCalendars(accountEmail: string | null = null): GoogleCalendarRow[] {
    return (accountEmail
      ? this.sql
          .prepare("SELECT * FROM google_calendars WHERE is_selected = 1 AND account_email = ?")
          .all(accountEmail)
      : this.sql.prepare("SELECT * FROM google_calendars WHERE is_selected = 1").all()) as GoogleCalendarRow[];
  }
  applyPrimaryOnlyToSelection(primaryOnly: boolean): { success: boolean } {
    this.sql
      .prepare("UPDATE google_calendars SET is_selected = CASE WHEN ? = 1 THEN is_primary ELSE 1 END")
      .run(primaryOnly ? 1 : 0);
    return { success: true };
  }
  updateCalendarSelection(id: string, selected: boolean): { success: boolean } {
    this.sql.prepare("UPDATE google_calendars SET is_selected = ? WHERE id = ?").run(
      selected ? 1 : 0,
      id
    );
    return { success: true };
  }

  saveMicrosoftTokens(tokens: {
    microsoft_email: string;
    access_token: string;
    refresh_token: string;
    expires_at: number;
    scope: string;
  }): { success: boolean } {
    this.sql
      .prepare(
        "INSERT INTO microsoft_calendar_tokens (microsoft_email, access_token, refresh_token, expires_at, scope) VALUES (?, ?, ?, ?, ?) ON CONFLICT(microsoft_email) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, scope = excluded.scope, updated_at = CURRENT_TIMESTAMP"
      )
      .run(
        tokens.microsoft_email,
        encryptCalendarToken(tokens.access_token),
        encryptCalendarToken(tokens.refresh_token),
        tokens.expires_at,
        tokens.scope
      );
    return { success: true };
  }
  getMicrosoftTokensByEmail(email: string): MicrosoftTokenRow | null {
    const row = this.sql
      .prepare("SELECT * FROM microsoft_calendar_tokens WHERE microsoft_email = ?")
      .get(email) as MicrosoftTokenRow | undefined;
    return this._decodeMicrosoftTokenRow(row);
  }
  getMicrosoftAccounts(): CalendarAccountRow[] {
    const rows = this.sql
      .prepare("SELECT * FROM microsoft_calendar_tokens ORDER BY created_at")
      .all() as MicrosoftTokenRow[];
    return rows.flatMap((row) => {
      const decoded = this._decodeMicrosoftTokenRow(row);
      return decoded ? [{ email: decoded.microsoft_email }] : [];
    });
  }
  removeMicrosoftAccount(email: string): { success: boolean } {
    this.sql.prepare("DELETE FROM microsoft_calendar_tokens WHERE microsoft_email = ?").run(email);
    this.sql.prepare("DELETE FROM microsoft_calendars WHERE account_email = ?").run(email);
    return { success: true };
  }
  saveMicrosoftCalendars(calendars: MicrosoftCalendarInput[], accountEmail: string): {
    success: boolean;
  } {
    const stmt = this.sql.prepare(
      "INSERT INTO microsoft_calendars (id, summary, background_color, account_email, is_primary) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, background_color = excluded.background_color, account_email = excluded.account_email, is_primary = excluded.is_primary"
    );
    calendars.forEach((cal) =>
      stmt.run(cal.id, cal.summary, cal.background_color || null, accountEmail, cal.is_primary ? 1 : 0)
    );
    return { success: true };
  }
  applyMicrosoftPrimaryOnlyToSelection(primaryOnly: boolean): { success: boolean } {
    this.sql
      .prepare(
        "UPDATE microsoft_calendars SET is_selected = CASE WHEN ? = 1 THEN is_primary ELSE 1 END"
      )
      .run(primaryOnly ? 1 : 0);
    return { success: true };
  }
  getSelectedMicrosoftCalendars(): MicrosoftCalendarRow[] {
    return this.sql
      .prepare("SELECT * FROM microsoft_calendars WHERE is_selected = 1")
      .all() as MicrosoftCalendarRow[];
  }

  saveAppleCalendars(calendars: AppleCalendarInput[]): { success: boolean } {
    const tx = this.sql.transaction((list: AppleCalendarInput[]) => {
      this.sql.prepare("DELETE FROM apple_calendars").run();
      const stmt = this.sql.prepare(
        "INSERT INTO apple_calendars (id, title, color, source_name) VALUES (?, ?, ?, ?)"
      );
      list.forEach((cal) =>
        stmt.run(cal.id, cal.title, cal.color || null, cal.source_name || null)
      );
    });
    tx(calendars);
    return { success: true };
  }
  getAppleCalendars(): AppleCalendarRow[] {
    return this.sql.prepare("SELECT * FROM apple_calendars").all() as AppleCalendarRow[];
  }
  upsertCalendarEvents(events: CalendarEventInput[]): { success: boolean } {
    const stmt = this.sql.prepare(
      "INSERT OR REPLACE INTO calendar_events (id, calendar_id, provider, summary, start_time, end_time, is_all_day, status, availability_status, self_response_status, hangout_link, conference_data, event_url, organizer_email, attendees_count, attendees, description, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
    );
    this.sql.transaction((list: CalendarEventInput[]) =>
      list.forEach((e) =>
        stmt.run(
          e.id,
          e.calendar_id,
          e.provider || "google",
          e.summary || null,
          e.start_time,
          e.end_time,
          e.is_all_day ? 1 : 0,
          e.status || "confirmed",
          e.availability_status || "unknown",
          e.self_response_status || "unknown",
          e.hangout_link || null,
          e.conference_data || null,
          e.event_url || null,
          e.organizer_email || null,
          e.attendees_count || 0,
          e.attendees || null,
          e.description || null
        )
      )
    )(events);
    return { success: true };
  }
  getActiveEvents(): CalendarEventRow[] {
    return (this.sql
      .prepare(
        dedupedEventsQuery(
          "datetime(start_time) <= datetime('now') AND datetime(end_time) > datetime('now') AND is_all_day = 0 AND status IN ('confirmed', 'tentative')"
        )
      )
      .all() as Array<CalendarEventRow & { has_synced: number }>).map(stripDedupeColumn);
  }
  getUpcomingEvents(windowMinutes = 1440): CalendarEventRow[] {
    const rows = this.sql
      .prepare(
        dedupedEventsQuery(
          "((datetime(start_time) > datetime('now') AND datetime(start_time) <= datetime('now', '+' || ? || ' minutes')) OR (datetime(start_time) <= datetime('now') AND datetime(end_time) > datetime('now'))) AND is_all_day = 0 AND status IN ('confirmed', 'tentative')"
        )
      )
      .all(windowMinutes) as Array<CalendarEventRow & { has_synced: number }>;
    return rows.map(stripDedupeColumn);
  }
  getCalendarEventsInRange(start: string, end: string, providers: string[]): CalendarEventRow[] {
    const from = Date.parse(start);
    const to = Date.parse(end);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from)
      throw new RangeError("Invalid calendar event range");
    const selected = [...new Set(providers)].filter((provider) => CALENDAR_PROVIDERS.has(provider));
    if (!selected.length) return [];
    const placeholders = selected.map(() => "?").join(", ");
    const events = (
      this.sql
        .prepare(
          dedupedEventsQuery(
            `provider IN (${placeholders}) AND status IN ('confirmed', 'tentative') AND ${selectedCalendarFilter()}`
          )
        )
        .all(...selected) as Array<CalendarEventRow & { has_synced: number }>
    ).map(stripDedupeColumn);
    return events.filter((event) => {
      const eventStart = parseEventTime(event.start_time, event.is_all_day === 1);
      const eventEnd = parseEventTime(event.end_time, event.is_all_day === 1);
      return (
        eventStart !== null &&
        eventEnd !== null &&
        eventStart < to &&
        eventEnd > from
      );
    });
  }
  getCalendarEventById(id: string): CalendarEventRow | null {
    return (
      (this.sql.prepare("SELECT * FROM calendar_events WHERE id = ?").get(id) as
        | CalendarEventRow
        | undefined) || null
    );
  }
  getNoteByCalendarEventId(eventId: string, excludeNoteId: number | null = null): NoteRow | null {
    const raw = (excludeNoteId == null
      ? this.sql
          .prepare(`SELECT ${noteColumns("notes")} FROM notes WHERE calendar_event_id = ? LIMIT 1`)
          .get(eventId)
      : this.sql
          .prepare(`SELECT ${noteColumns("notes")} FROM notes WHERE calendar_event_id = ? AND id != ? LIMIT 1`)
          .get(eventId, excludeNoteId)) as RawNoteRow | undefined;
    return raw ? hydrateNote(raw) : null;
  }
  updateCalendarSyncToken(id: string, token: string, expiresAt: number): { success: boolean } {
    this.sql
      .prepare("UPDATE google_calendars SET sync_token = ?, sync_token_expires_at = ? WHERE id = ?")
      .run(token, expiresAt, id);
    return { success: true };
  }
  updateMicrosoftCalendarSyncToken(id: string, token: string, expiresAt: number): { success: boolean } {
    this.sql
      .prepare(
        "UPDATE microsoft_calendars SET sync_token = ?, sync_token_expires_at = ? WHERE id = ?"
      )
      .run(token, expiresAt, id);
    return { success: true };
  }
  removeCalendarEvents(ids: string[]): { success: boolean } {
    if (ids?.length)
      this.sql
        .prepare(`DELETE FROM calendar_events WHERE id IN (${ids.map(() => "?").join(",")})`)
        .run(...ids);
    return { success: true };
  }
  removeStaleCalendarEvents(
    provider: string,
    calendarId: string,
    freshIds: string[]
  ): { success: boolean } {
    const filter = freshIds?.length ? `AND id NOT IN (${freshIds.map(() => "?").join(",")})` : "";
    this.sql
      .prepare(
        `DELETE FROM calendar_events WHERE provider = ? AND calendar_id = ? ${filter} AND id NOT IN (SELECT calendar_event_id FROM notes WHERE calendar_event_id IS NOT NULL)`
      )
      .run(provider, calendarId, ...(freshIds || []));
    return { success: true };
  }
  removeEventsFromDeselectedCalendars(provider: string): { success: boolean } {
    const table = CALENDARS_TABLE_BY_PROVIDER[provider];
    if (!table) throw new Error(`Unknown calendar provider: ${provider}`);
    this.sql
      .prepare(
        `DELETE FROM calendar_events WHERE provider = ? AND calendar_id NOT IN (SELECT id FROM ${table} WHERE is_selected = 1)`
      )
      .run(provider);
    return { success: true };
  }
  replaceAppleCalendarEvents(events: CalendarEventInput[]): { success: boolean } {
    const tx = this.sql.transaction((list: CalendarEventInput[]) => {
      this.sql
        .prepare(
          "DELETE FROM calendar_events WHERE provider = 'apple' AND id NOT IN (SELECT calendar_event_id FROM notes WHERE calendar_event_id IS NOT NULL)"
        )
        .run();
      const stmt = this.sql.prepare(
        "INSERT OR REPLACE INTO calendar_events (id, calendar_id, provider, summary, start_time, end_time, is_all_day, status, availability_status, self_response_status, hangout_link, conference_data, event_url, organizer_email, attendees_count, attendees, description, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
      );
      list.forEach((e) =>
        stmt.run(
          e.id,
          e.calendar_id,
          e.provider || "apple",
          e.summary || null,
          e.start_time,
          e.end_time,
          e.is_all_day ? 1 : 0,
          e.status || "confirmed",
          e.availability_status || "unknown",
          e.self_response_status || "unknown",
          e.hangout_link || null,
          e.conference_data || null,
          e.event_url || null,
          e.organizer_email || null,
          e.attendees_count || 0,
          e.attendees || null,
          e.description || null
        )
      );
    });
    tx(events);
    return { success: true };
  }
  clearGoogleCalendarData(): { success: boolean } {
    this.sql.prepare("DELETE FROM calendar_events WHERE provider = 'google'").run();
    this.sql.prepare("DELETE FROM google_calendars").run();
    this.sql.prepare("DELETE FROM google_calendar_tokens").run();
    return { success: true };
  }
  clearMicrosoftCalendarData(): { success: boolean } {
    this.sql.prepare("DELETE FROM calendar_events WHERE provider = 'microsoft'").run();
    this.sql.prepare("DELETE FROM microsoft_calendars").run();
    this.sql.prepare("DELETE FROM microsoft_calendar_tokens").run();
    return { success: true };
  }
  clearAppleCalendarData(): { success: boolean } {
    this.sql.prepare("DELETE FROM calendar_events WHERE provider = 'apple'").run();
    this.sql.prepare("DELETE FROM apple_calendars").run();
    return { success: true };
  }

  searchNotes(
    query: unknown,
    limit = 50,
    spaceId: number | null = null,
    folderId: number | null = null
  ): NoteRow[] {
    const ftsQuery = buildNoteSearchQuery(query);
    if (!ftsQuery) return [];
    const conditions = ["notes_fts MATCH ?"];
    const params: unknown[] = [ftsQuery];
    if (spaceId != null) {
      conditions.push("n.space_id = ?");
      params.push(spaceId);
    }
    if (folderId != null) {
      conditions.push("(n.folder_id = ? OR n.id IN (SELECT note_id FROM note_folders WHERE folder_id = ?))");
      params.push(folderId, folderId);
    }
    params.push(limit);
    return (this.sql
      .prepare(
        `SELECT ${noteColumns("n")} FROM notes n JOIN notes_fts ON notes_fts.rowid = n.id WHERE ${conditions.join(" AND ")} ORDER BY notes_fts.rank LIMIT ?`
      )
      .all(...params) as RawNoteRow[]).map(hydrateNote);
  }

  upsertContacts(contacts: Array<{ email?: string; displayName?: string | null }>): {
    success: boolean;
  } {
    const stmt = this.sql.prepare(
      "INSERT INTO contacts (email, display_name) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET display_name = COALESCE(excluded.display_name, contacts.display_name), updated_at = CURRENT_TIMESTAMP"
    );
    this.sql.transaction((list: Array<{ email?: string; displayName?: string | null }>) =>
      list.forEach((contact) => {
        if (contact.email) stmt.run(contact.email.toLowerCase().trim(), contact.displayName || null);
      })
    )(contacts);
    return { success: true };
  }
  /** Names and photos from Google People; a profile without either leaves the row as it was. */
  upsertGooglePeople(
    profiles: Array<{ email: string; displayName: string | null; photoUrl: string | null }>
  ): { success: boolean } {
    const stmt = this.sql.prepare(
      "INSERT INTO contacts (email, people_name, photo_url) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET people_name = COALESCE(excluded.people_name, contacts.people_name), photo_url = COALESCE(excluded.photo_url, contacts.photo_url), updated_at = CURRENT_TIMESTAMP"
    );
    this.sql.transaction((list: typeof profiles) =>
      list.forEach((profile) => {
        const email = profile.email.toLowerCase().trim();
        if (email) stmt.run(email, profile.displayName || null, profile.photoUrl || null);
      })
    )(profiles);
    return { success: true };
  }
  getContactProfiles(emails: string[]): ContactProfileRow[] {
    const normalized = [...new Set(emails.map((email) => email.toLowerCase().trim()).filter(Boolean))];
    if (normalized.length === 0) return [];
    return this.sql
      .prepare(
        `SELECT email, COALESCE(people_name, display_name) AS display_name, photo_url FROM contacts WHERE email IN (${normalized.map(() => "?").join(", ")})`
      )
      .all(...normalized) as ContactProfileRow[];
  }
  searchContacts(query: string): ContactRow[] {
    const pattern = `%${query || ""}%`;
    return this.sql
      .prepare(
        "SELECT email, COALESCE(people_name, display_name) AS display_name, photo_url, created_at, updated_at FROM contacts WHERE email LIKE ? OR display_name LIKE ? OR people_name LIKE ? ORDER BY COALESCE(people_name, display_name), email LIMIT 20"
      )
      .all(pattern, pattern, pattern) as ContactRow[];
  }
  upsertSpeakerProfile(
    name: string,
    email: string | null | undefined,
    embeddingBuffer: Buffer,
    profileId: number | null = null
  ): SpeakerProfileRow | null {
    if (profileId != null) {
      this.sql
        .prepare(
          "UPDATE speaker_profiles SET display_name = ?, email = ?, embedding = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(name, email || null, embeddingBuffer, profileId);
      return (this.sql
        .prepare("SELECT * FROM speaker_profiles WHERE id = ?")
        .get(profileId) as SpeakerProfileRow | undefined) ?? null;
    }
    const result = this.sql
      .prepare("INSERT INTO speaker_profiles (display_name, email, embedding) VALUES (?, ?, ?)")
      .run(name, email || null, embeddingBuffer);
    return (this.sql
      .prepare("SELECT * FROM speaker_profiles WHERE id = ?")
      .get(result.lastInsertRowid) as SpeakerProfileRow | undefined) ?? null;
  }
  getSpeakerProfiles(includeEmbedding = false): SpeakerProfileRow[] {
    return this.sql
      .prepare(
        `SELECT ${includeEmbedding ? "*" : "id, display_name, email, sample_count, created_at, updated_at"} FROM speaker_profiles ORDER BY display_name`
      )
      .all() as SpeakerProfileRow[];
  }
  attachEmailToProfile(profileId: number, email: string): { success: boolean } {
    this.sql
      .prepare("UPDATE speaker_profiles SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(email, profileId);
    return { success: true };
  }
  mergeSpeakerProfiles(a: number, b: number): { success: boolean } {
    this.sql.prepare("UPDATE speaker_mappings SET profile_id = ? WHERE profile_id = ?").run(a, b);
    this.sql.prepare("DELETE FROM speaker_profiles WHERE id = ?").run(b);
    return { success: true };
  }
  setSpeakerMapping(
    noteId: number,
    speakerId: string,
    profileId: number | null,
    displayName: string
  ): { success: boolean } {
    this.sql
      .prepare(
        "INSERT INTO speaker_mappings (note_id, speaker_id, profile_id, display_name) VALUES (?, ?, ?, ?) ON CONFLICT(note_id, speaker_id) DO UPDATE SET profile_id = excluded.profile_id, display_name = excluded.display_name"
      )
      .run(noteId, speakerId, profileId, displayName);
    return { success: true };
  }
  getSpeakerMappings(noteId: number): SpeakerMappingRow[] {
    return this.sql
      .prepare("SELECT * FROM speaker_mappings WHERE note_id = ?")
      .all(noteId) as SpeakerMappingRow[];
  }
  removeSpeakerMapping(noteId: number, speakerId: string): { success: boolean } {
    return {
      success:
        this.sql
          .prepare("DELETE FROM speaker_mappings WHERE note_id = ? AND speaker_id = ?")
          .run(noteId, speakerId).changes > 0,
    };
  }
  saveNoteSpeakerEmbeddings(
    noteId: number,
    embeddings: Array<{ speakerId: string; embedding: Buffer }>
  ): { success: boolean } {
    const tx = this.sql.transaction((list: Array<{ speakerId: string; embedding: Buffer }>) => {
      const stmt = this.sql.prepare(
        "INSERT INTO note_speaker_embeddings (note_id, speaker_id, embedding) VALUES (?, ?, ?) ON CONFLICT(note_id, speaker_id) DO UPDATE SET embedding = excluded.embedding"
      );
      list.forEach((item) => stmt.run(noteId, item.speakerId, item.embedding));
    });
    tx(embeddings);
    return { success: true };
  }
  getNoteSpeakerEmbeddings(noteId: number): NoteSpeakerEmbeddingRow[] {
    return this.sql
      .prepare("SELECT * FROM note_speaker_embeddings WHERE note_id = ?")
      .all(noteId) as NoteSpeakerEmbeddingRow[];
  }
  getNotesWithUnmappedSpeakers(): NoteRow[] {
    return (this.sql
      .prepare(
        `SELECT ${noteColumns("n")} FROM notes n WHERE EXISTS (SELECT 1 FROM speaker_mappings m WHERE m.note_id = n.id AND m.profile_id IS NULL) ORDER BY n.updated_at DESC`
      )
      .all() as RawNoteRow[]).map(hydrateNote);
  }

  cleanup(): void {
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }
  close(): void {
    this.cleanup();
  }
}

// The original module was `module.exports = DatabaseManager`, and every
// runtime consumer (main.js, ipcHandlers.js, test harnesses) invokes the
// required value directly. Restore that CommonJS contract — tsc's ESM emit
// alone would expose only `exports.default`.
module.exports = DatabaseManager;
module.exports.DatabaseManager = DatabaseManager;
