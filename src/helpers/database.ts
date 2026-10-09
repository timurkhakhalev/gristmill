// The persistence adapter over better-sqlite3. One DatabaseManager, the same
// SQL, transactions and schema as the JS version — this conversion only adds
// strict types at the SQL boundary. Internal row shapes are deliberately NOT
// public IPC DTOs: tokens and embedding buffers stay main-only; shared
// contracts own the renderer-facing projections.
//
// Exact-file lint override (.oxlintrc.json): no-unknown-parameters,
// no-runtime-typeof and no-unsafe-dictionary-type stay off here because this
// manager IS the IPC input boundary — setDictionary/setSnippets/importNotes/
// searchNotes/normalizeWords deliberately coerce tolerant legacy payloads
// (trim, drop junk, tolerate unknown fields) before SQL. Parsing happens in
// the flagged helpers themselves; every caller above this layer is typed.
import path from "path";
import { z } from "zod";
import { migrateMeetingPlatformEvidence } from "./meetingPlatformMigration.js";
import { migrateMeetingAudio } from "./meetingAudioMigration.js";
import { migrateSpaces } from "./spacesMigration.js";
import { createHash, randomUUID } from "crypto";
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
  meetingPlatformObservationSchema,
  meetingAudioClockAnchorSchema,
  meetingPlatformDecisionSchema,
  meetingPlatformCoverageSchema,
  type MeetingPlatform,
  type MeetingPlatformObservation,
  type MeetingAudioClockAnchor,
  type MeetingPlatformDecision,
  type MeetingPlatformCoverage,
  meetingProcessingConfigSchema,
  meetingProcessingConfigErrorSchema,
  MEETING_ASR_GATE_MS,
  meetingRecordingIdSchema,
  meetingRunAudioPartIds,
  meetingRecordingConfigInputSchema,
  meetingRunArtifactSchema,
  meetingSourceSchema,
  meetingIntentionalIntervalSchema,
  meetingFrameAlignmentSegmentSchema,
  type MeetingAudioState,
  type MeetingCaptureState,
  type MeetingDeletionIntentDto,
  type MeetingProcessingConfig,
  type MeetingProcessingConfigError,
  type MeetingProcessingRunDto,
  type MeetingRecordingDto,
  type MeetingRecordingEpochDto,
  type MeetingFrameAlignmentSegment,
  type MeetingFrameAlignmentPoint,
  type MeetingIntentionalInterval,
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
  // Generic so call sites annotate the row shape once, inline, instead of
  // asserting away `unknown` after every query.
  get<Row = unknown>(...params: unknown[]): Row | undefined;
  all<Row = unknown>(...params: unknown[]): Row[];
}

export interface SqliteDatabase {
  pragma<Row = unknown>(source: string): Row;
  exec(source: string): void;
  prepare(source: string): SqliteStatement;
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
  close(): void;
}

type BetterSqlite3Constructor = new (filename: string) => SqliteDatabase;

// SAFETY: better-sqlite3 ships no declarations; this module defines the exact
// structural surface used above (SqliteDatabase/SqliteStatement).
const Database = require("better-sqlite3") as BetterSqlite3Constructor;

const MAX_SNIPPET_TRIGGER_LENGTH = 100;

// Owner contract for provider→table lookups; both providers are created here.
const CALENDARS_TABLE_BY_PROVIDER = {
  google: "google_calendars",
  microsoft: "microsoft_calendars",
};

type CalendarProvider = keyof typeof CALENDARS_TABLE_BY_PROVIDER;

function calendarsTableFor(provider: string): string {
  // SAFETY: callers pass the provider column, whose CHECK constrains it to the
  // two keys of CALENDARS_TABLE_BY_PROVIDER.
  return CALENDARS_TABLE_BY_PROVIDER[provider as CalendarProvider];
}

const CALENDAR_PROVIDERS: ReadonlySet<string> = new Set(["google", "microsoft", "apple"]);

const CALENDAR_TOKEN_PREFIX = "ohenc:v1:";

const GOOGLE_CALENDARS_SCHEMA = `CREATE TABLE IF NOT EXISTS google_calendars (
          id TEXT NOT NULL,
          summary TEXT NOT NULL,
          description TEXT,
          background_color TEXT,
          is_selected INTEGER NOT NULL DEFAULT 1,
          is_primary INTEGER NOT NULL DEFAULT 0,
          sync_token TEXT,
          sync_token_expires_at INTEGER,
          account_email TEXT NOT NULL DEFAULT '',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id, account_email)
        );`;

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

/** Palette names a folder glyph can be tinted with. */
export const FOLDER_COLORS = ["red", "orange", "amber", "green", "teal", "blue", "violet", "pink"];

export interface FolderRow {
  id: number;
  name: string;
  is_default: number;
  sort_order: number;
  /** Emoji shown instead of the default folder glyph. */
  icon?: string | null;
  /** Palette name tinting the folder glyph. */
  color?: string | null;
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
  transcript: string | null;
  calendar_event_id: string | null;
  participants: string | null;
  diarization_enabled: number | null;
  expected_speaker_count: number | null;
  /** Emoji shown instead of the default note glyph. */
  icon?: string | null;
}

type RawNoteRow = Omit<NoteRow, "folder_ids"> & { extra_folder_ids_json: string | null };

// Extra folders live in note_folders; this column rides along with every note read.
const noteColumns = (alias: string) =>
  `${alias}.*, (SELECT json_group_array(nf.folder_id) FROM note_folders nf WHERE nf.note_id = ${alias}.id) AS extra_folder_ids_json`;

function hydrateNote(raw: RawNoteRow): NoteRow {
  const { extra_folder_ids_json, ...note } = raw;
  // SAFETY: extra_folder_ids_json is written by this manager as JSON of number[].
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
  timeline_start_frame: number | null;
  source_start_frame: number | null;
  source_generation: number | null;
  alignment_error_code: string | null;
  sample_rate: 24_000;
  channels: 1;
  encoding: "opus";
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
  omitted_recording_ids_json: string;
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
  speaker_naming_error_code: string | null;
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

// The persisted row always carries the embedding (the column is NOT NULL); the
// retroactive-mapping pass needs it, so the promoted shape names it required.
export interface SpeakerProfileWithEmbedding {
  id: number;
  display_name: string;
  email: string | null;
  embedding: Buffer;
  sample_count: number;
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
        AND google_calendars.account_email != ''
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

  for (const raw of z.array(z.unknown()).catch([]).parse(words)) {
    if (typeof raw !== "string") continue;
    const word = raw.trim();

    if (word && !result.has(word.toLowerCase())) result.set(word.toLowerCase(), word);
  }

  return result;
}

function isSqliteUniqueConstraint(error: unknown): boolean {
  // SAFETY: better-sqlite3 throws errno-style errors with a `code` field.
  return (error as NodeJS.ErrnoException).code === "SQLITE_CONSTRAINT_UNIQUE";
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid meeting recording JSON metadata");
  }

  // SAFETY: the guards above established a non-null, non-array object.
  return parsed as Record<string, unknown>;
}

function parseConfig(value: string | null): MeetingProcessingConfig | null {
  return value === null ? null : meetingProcessingConfigSchema.parse(JSON.parse(value));
}

function configErrorFromRow(
  code: string | null,
  messageKey: string | null
): MeetingProcessingConfigError | null {
  return code === null
    ? null
    : meetingProcessingConfigErrorSchema.parse({ code, ...(messageKey && { messageKey }) });
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

function toMeetingEpochDto(
  row: MeetingRecordingEpochDbRow,
  alignmentSegments: MeetingFrameAlignmentSegment[]
): MeetingRecordingEpochDto {
  return {
    recordingId: row.recording_id,
    source: row.source,
    epochIndex: row.epoch_index,
    timelineStartFrame: row.timeline_start_frame,
    sourceStartFrame: row.source_start_frame,
    sourceGeneration: row.source_generation,
    alignmentSegments,
    alignmentErrorCode: row.alignment_error_code,
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
    // SAFETY: this manager stores string[] of recording ids in this column.
    sourceRecordingIds: row.source_recording_ids_json
      ? (JSON.parse(row.source_recording_ids_json) as string[])
      : [row.recording_id],
    hasExplicitAudioParts: row.source_recording_ids_json !== null,
    omittedRecordingIds: z
      .array(meetingRecordingIdSchema)
      .parse(JSON.parse(row.omitted_recording_ids_json)),
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
    speakerNamingErrorCode: row.speaker_naming_error_code,
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

interface StoredConfig {
  config: MeetingProcessingConfig | null;
  error: MeetingProcessingConfigError | null;
}

function storedConfig(config: unknown, error: unknown): StoredConfig {
  const parsedInput = meetingRecordingConfigInputSchema.safeParse({ config, configError: error });

  if (!parsedInput.success)
    return { config: null, error: { code: "invalid-config" } } satisfies StoredConfig;

  if (parsedInput.data.config === null) {
    return { config: null, error: parsedInput.data.configError ?? { code: "missing-config" } };
  }

  return { config: parsedInput.data.config, error: null };
}

function configJson(config: MeetingProcessingConfig | null): string | null {
  return config === null ? null : JSON.stringify(config);
}

function relativeEpochPath(source: MeetingSource, index: number): string {
  return `${source}/epoch-${String(index).padStart(6, "0")}.opus`;
}

function meetingRunArtifactFileName(artifact: MeetingRunArtifact): string {
  if (artifact === "provider-response") return "raw-provider-response.json";

  return artifact === "transcript" ? "transcript.json" : "summary.json";
}

// Named results for manager methods; keeps inference honest at every return.
export interface SuccessResult {
  success: boolean;
}

export interface NoteMutationDbResult {
  success: boolean;
  note?: NoteRow | null;
}

export interface FolderMutationDbResult {
  success: boolean;
  error?: string;
  folder?: FolderRow;
}

export interface FolderStyleMutationDbResult {
  success: boolean;
  folder?: FolderRow | null;
}

export interface FolderDeleteDbResult {
  success: boolean;
  relocatedNoteIds: number[];
}

export interface DictionaryChangeDbResult {
  success: boolean;
  added: number;
  removed: number;
}

export interface NoteSaveDbResult {
  success: boolean;
  note: NoteRow | null;
}

export interface NoteUpdateDbResult {
  success: boolean;
  error?: string;
  note?: NoteRow | null;
}

export interface ActionMutationDbResult {
  success: boolean;
  action?: ActionRow | null;
}

export interface ClearedResult {
  success: boolean;
  cleared: number;
}

export interface DeletedIdResult {
  success: boolean;
  id: number;
}

export interface IdsResult {
  ids: number[];
}

export interface DictionaryApplyDelta {
  add?: unknown;
  remove?: unknown;
}

export interface StorageIdsResult {
  recordingIds: string[];
  runIds: string[];
}

export interface TranscriptionSaveResult {
  id: number;
  success: boolean;
  transcription: TranscriptionRow | null;
}

export interface ImportNotesResult {
  success: boolean;
  imported: number;
  skipped: number;
  folderId: number | null;
  noteIds: number[];
  errors: Array<{ error: string }>;
}

export interface ActionCreateResult {
  success: boolean;
  action?: ActionRow | null;
}

export interface CalendarSaveResult {
  success: boolean;
  failed: number;
}

export interface ContactUpsertResult {
  success: boolean;
  merged: number;
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

      const isNewProfile = !this._db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'folders'")
        .get();

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

        CREATE TABLE IF NOT EXISTS folders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          is_default INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (name)
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
          timeline_start_frame INTEGER CHECK(timeline_start_frame IS NULL OR timeline_start_frame >= 0),
          source_start_frame INTEGER CHECK(source_start_frame IS NULL OR source_start_frame >= 0),
          source_generation INTEGER CHECK(source_generation IS NULL OR source_generation > 0),
          alignment_error_code TEXT,
          sample_rate INTEGER NOT NULL CHECK(sample_rate = 24000),
          channels INTEGER NOT NULL CHECK(channels = 1),
          encoding TEXT NOT NULL CHECK(encoding = 'opus'),
          relative_path TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open', 'finalized', 'incomplete')),
          frame_count INTEGER NOT NULL DEFAULT 0 CHECK(frame_count >= 0),
          ignored_trailing_bytes INTEGER NOT NULL DEFAULT 0 CHECK(ignored_trailing_bytes >= 0),
          error_code TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (recording_id, source, epoch_index)
        );

        CREATE TABLE IF NOT EXISTS meeting_recording_intentional_intervals (
          id TEXT PRIMARY KEY,
          recording_id TEXT NOT NULL REFERENCES meeting_recordings(id) ON DELETE CASCADE,
          source TEXT NOT NULL CHECK(source IN ('mic', 'system')),
          source_generation INTEGER CHECK(source_generation IS NULL OR source_generation > 0),
          timeline_start_frame INTEGER CHECK(timeline_start_frame IS NULL OR timeline_start_frame >= 0),
          timeline_end_frame INTEGER CHECK(timeline_end_frame IS NULL OR timeline_end_frame >= 0),
          source_start_frame INTEGER CHECK(source_start_frame IS NULL OR source_start_frame >= 0),
          source_end_frame INTEGER CHECK(source_end_frame IS NULL OR source_end_frame >= 0),
          start_alignment_json TEXT,
          end_alignment_json TEXT,
          reason TEXT NOT NULL CHECK(reason IN ('manual-muted', 'platform-muted')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS meeting_recording_epoch_alignments (
          recording_id TEXT NOT NULL,
          source TEXT NOT NULL CHECK(source IN ('mic', 'system')),
          epoch_index INTEGER NOT NULL CHECK(epoch_index >= 0),
          segment_index INTEGER NOT NULL CHECK(segment_index >= 0),
          source_generation INTEGER NOT NULL CHECK(source_generation > 0),
          source_start_frame INTEGER NOT NULL CHECK(source_start_frame >= 0),
          source_end_frame INTEGER NOT NULL CHECK(source_end_frame > source_start_frame),
          timeline_start_frame INTEGER NOT NULL CHECK(timeline_start_frame >= 0),
          rate REAL NOT NULL CHECK(rate BETWEEN 0.999 AND 1.001),
          uncertainty_start_frames INTEGER NOT NULL CHECK(uncertainty_start_frames >= 0),
          uncertainty_end_frames INTEGER NOT NULL CHECK(uncertainty_end_frames >= 0),
          helper_generation TEXT NOT NULL,
          source_start_ns TEXT NOT NULL,
          source_end_ns TEXT NOT NULL,
          helper_start_ns TEXT NOT NULL,
          helper_end_ns TEXT NOT NULL,
          sampled_source_start_ns TEXT NOT NULL,
          sampled_source_end_ns TEXT NOT NULL,
          freshness_source_ns TEXT NOT NULL,
          FOREIGN KEY (recording_id, source, epoch_index)
            REFERENCES meeting_recording_epochs(recording_id, source, epoch_index) ON DELETE CASCADE,
          PRIMARY KEY (recording_id, source, epoch_index, segment_index)
        );

        CREATE TABLE IF NOT EXISTS meeting_processing_runs (
          id TEXT PRIMARY KEY,
          recording_id TEXT NOT NULL REFERENCES meeting_recordings(id) ON DELETE CASCADE,
          source_recording_ids_json TEXT,
          omitted_recording_ids_json TEXT NOT NULL DEFAULT '[]',
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
          llm_source_snapshot_json TEXT,
          speaker_naming_error_code TEXT,
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

        CREATE TABLE IF NOT EXISTS agent_bb_threads (
          conversation_id INTEGER PRIMARY KEY REFERENCES agent_conversations(id) ON DELETE CASCADE,
          thread_id TEXT NOT NULL UNIQUE,
          provider TEXT NOT NULL
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

        ${GOOGLE_CALENDARS_SCHEMA}

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
          learned_name TEXT,
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
          participant_email TEXT,
          source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('voice', 'platform', 'model', 'user')),
          revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
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

      migrateMeetingAudio(this.sql, app.getPath("userData"));

      this.sql.pragma("foreign_keys = OFF");

      try {
        this.sql.transaction(() => {
          const epochColumns = this.sql.pragma<
            Array<{
              name: string;
            }>
          >("table_info(meeting_recording_epochs)");

          if (
            epochColumns.some((column) => column.name === "start_frame") &&
            !epochColumns.some((column) => column.name === "timeline_start_frame")
          ) {
            this.sql.exec(
              "ALTER TABLE meeting_recording_epochs RENAME COLUMN start_frame TO timeline_start_frame"
            );
          }

          const currentEpochColumns = this.sql.pragma<Array<{ name: string }>>(
            "table_info(meeting_recording_epochs)"
          );

          if (!currentEpochColumns.some((column) => column.name === "source_start_frame")) {
            this.sql.exec(
              "ALTER TABLE meeting_recording_epochs ADD COLUMN source_start_frame INTEGER"
            );
          }

          if (!currentEpochColumns.some((column) => column.name === "source_generation")) {
            this.sql.exec(
              "ALTER TABLE meeting_recording_epochs ADD COLUMN source_generation INTEGER"
            );
          }

          if (!currentEpochColumns.some((column) => column.name === "alignment_error_code")) {
            this.sql.exec(
              "ALTER TABLE meeting_recording_epochs ADD COLUMN alignment_error_code TEXT"
            );
          }

          const intervalColumns = this.sql.pragma<Array<{ name: string }>>(
            "table_info(meeting_recording_intentional_intervals)"
          );

          if (
            intervalColumns.some((column) => column.name === "start_frame") &&
            !intervalColumns.some((column) => column.name === "timeline_start_frame")
          ) {
            this.sql.exec(
              "ALTER TABLE meeting_recording_intentional_intervals RENAME COLUMN start_frame TO timeline_start_frame"
            );
          }

          const currentIntervalColumns = this.sql.pragma<Array<{ name: string }>>(
            "table_info(meeting_recording_intentional_intervals)"
          );

          if (
            currentIntervalColumns.some((column) => column.name === "end_frame") &&
            !currentIntervalColumns.some((column) => column.name === "timeline_end_frame")
          ) {
            this.sql.exec(
              "ALTER TABLE meeting_recording_intentional_intervals RENAME COLUMN end_frame TO timeline_end_frame"
            );
          }

          for (const [name, definition] of [
            ["source_generation", "INTEGER"],
            ["timeline_start_frame", "INTEGER"],
            ["timeline_end_frame", "INTEGER"],
            ["source_start_frame", "INTEGER"],
            ["source_end_frame", "INTEGER"],
            ["start_alignment_json", "TEXT"],
            ["end_alignment_json", "TEXT"],
          ] as const) {
            const columns = this.sql.pragma<Array<{ name: string }>>(
              "table_info(meeting_recording_intentional_intervals)"
            );

            if (!columns.some((column) => column.name === name))
              this.sql.exec(
                `ALTER TABLE meeting_recording_intentional_intervals ADD COLUMN ${name} ${definition}`
              );
          }

          // Renaming a NOT NULL column does not make unknown alignment nullable.
          for (const table of [
            "meeting_recording_epochs",
            "meeting_recording_intentional_intervals",
          ]) {
            const row = this.sql
              .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
              .get<{ sql: string }>(table);

            // The table was just listed as existing; sqlite_master has its DDL.
            if (!row) throw new Error(`Missing sqlite_master row for ${table}`);

            const nullable = row.sql.replace(
              /("?timeline_start_frame"?\s+INTEGER)\s+NOT NULL/gi,
              "$1"
            );

            if (nullable === row.sql) continue;
            this.sql.exec(nullable.replace(table, `${table}_aligned`));
            this.sql.exec(
              `INSERT INTO ${table}_aligned SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_aligned RENAME TO ${table}`
            );
          }
        })();
      } finally {
        this.sql.pragma("foreign_keys = ON");
      }

      this.sql.exec(`
        DROP INDEX IF EXISTS idx_meeting_open_intentional_interval;
        DROP INDEX IF EXISTS idx_meeting_intentional_intervals_range;
        CREATE UNIQUE INDEX idx_meeting_open_intentional_interval
          ON meeting_recording_intentional_intervals(recording_id, source, source_generation, reason) WHERE source_end_frame IS NULL;
        CREATE INDEX idx_meeting_intentional_intervals_range
          ON meeting_recording_intentional_intervals(recording_id, source, source_generation, source_start_frame, source_end_frame);
      `);

      const recordingColumns = this.sql.pragma<
        Array<{
          name: string;
        }>
      >("table_info(meeting_recordings)");

      if (!recordingColumns.some((column) => column.name === "group_id")) {
        this.sql.exec("ALTER TABLE meeting_recordings ADD COLUMN group_id TEXT");
      }

      const runColumns = this.sql.pragma<
        Array<{
          name: string;
        }>
      >("table_info(meeting_processing_runs)");

      if (!runColumns.some((column) => column.name === "bb_thread_id")) {
        this.sql.exec("ALTER TABLE meeting_processing_runs ADD COLUMN bb_thread_id TEXT");
      }

      if (!runColumns.some((column) => column.name === "source_recording_ids_json")) {
        this.sql.exec(
          "ALTER TABLE meeting_processing_runs ADD COLUMN source_recording_ids_json TEXT"
        );
      }

      if (!runColumns.some((column) => column.name === "omitted_recording_ids_json")) {
        this.sql.exec(
          "ALTER TABLE meeting_processing_runs ADD COLUMN omitted_recording_ids_json TEXT NOT NULL DEFAULT '[]'"
        );
      }

      if (!runColumns.some((column) => column.name === "llm_source_snapshot_json")) {
        this.sql.exec(
          "ALTER TABLE meeting_processing_runs ADD COLUMN llm_source_snapshot_json TEXT"
        );
      }

      if (!runColumns.some((column) => column.name === "speaker_naming_error_code")) {
        this.sql.exec(
          "ALTER TABLE meeting_processing_runs ADD COLUMN speaker_naming_error_code TEXT"
        );
      }

      const speakerCorrectionColumns = this.sql.pragma<Array<{ name: string }>>(
        "table_info(meeting_run_speaker_corrections)"
      );

      if (!speakerCorrectionColumns.some((column) => column.name === "source")) {
        this.sql.exec(
          "ALTER TABLE meeting_run_speaker_corrections ADD COLUMN source TEXT NOT NULL DEFAULT 'user'"
        );
      }

      if (!speakerCorrectionColumns.some((column) => column.name === "revision")) {
        this.sql.exec(
          "ALTER TABLE meeting_run_speaker_corrections ADD COLUMN revision INTEGER NOT NULL DEFAULT 1"
        );
      }

      if (!speakerCorrectionColumns.some((column) => column.name === "participant_email")) {
        this.sql.exec(
          "ALTER TABLE meeting_run_speaker_corrections ADD COLUMN participant_email TEXT"
        );
      }

      const correctionSql = this.sql
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'meeting_run_speaker_corrections'")
        .get<{ sql: string }>();

      // The table exists when this migration check runs; sqlite_master has its DDL.
      if (correctionSql && !correctionSql.sql.includes("'platform'")) {
        this.sql.transaction(() => {
          this.sql.exec(`
            CREATE TABLE meeting_run_speaker_corrections_next (
              run_id TEXT NOT NULL REFERENCES meeting_processing_runs(id) ON DELETE CASCADE,
              speaker_id TEXT NOT NULL, profile_id INTEGER REFERENCES speaker_profiles(id) ON DELETE SET NULL,
              display_name TEXT NOT NULL, participant_email TEXT,
              source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('voice', 'platform', 'model', 'user')),
              revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0), PRIMARY KEY (run_id, speaker_id)
            );
            INSERT INTO meeting_run_speaker_corrections_next SELECT run_id, speaker_id, profile_id, display_name, participant_email, source, revision FROM meeting_run_speaker_corrections;
            DROP TABLE meeting_run_speaker_corrections;
            ALTER TABLE meeting_run_speaker_corrections_next RENAME TO meeting_run_speaker_corrections;
          `);
        })();
      }

      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS meeting_audio_clock_anchors (
          id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES meeting_recordings(id) ON DELETE CASCADE, evidence_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS meeting_audio_clock_anchors_recording ON meeting_audio_clock_anchors(recording_id);
        CREATE TABLE IF NOT EXISTS meeting_platform_coverage (
          recording_id TEXT PRIMARY KEY REFERENCES meeting_recordings(id) ON DELETE CASCADE, coverage_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meeting_run_platform_decisions (
          run_id TEXT PRIMARY KEY REFERENCES meeting_processing_runs(id) ON DELETE CASCADE, decisions_json TEXT NOT NULL
        );
      `);
      // Cut over stored decisions without claiming the new heuristic was used
      // for historical results. Keep their original evidence/policy fields.
      this.sql.exec(`
        UPDATE meeting_run_platform_decisions
        SET decisions_json = (
          SELECT json_group_array(json_set(value, '$.timingPolicy', json('null')))
          FROM json_each(meeting_run_platform_decisions.decisions_json)
        )
        WHERE EXISTS (
          SELECT 1 FROM json_each(meeting_run_platform_decisions.decisions_json)
          WHERE json_type(value, '$.timingPolicy') IS NULL
        );
      `);
      migrateMeetingPlatformEvidence(this.sql);
      this.recoverMeetingPlatformCoverage();

      for (const [table, added] of [
        ["folders", ["icon", "color"]],
        ["notes", ["icon"]],
      ] as const) {
        const columns = this.sql.pragma<Array<{ name: string }>>(`table_info(${table})`);

        for (const name of added) {
          if (!columns.some((column) => column.name === name))
            this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} TEXT`);
        }
      }

      migrateSpaces(this.sql);

      const googleCalendarColumns = this.sql.pragma<
        Array<{
          name: string;
          pk: number;
        }>
      >("table_info(google_calendars)");

      if (
        !googleCalendarColumns.some((column) => column.name === "account_email" && column.pk > 0)
      ) {
        this.sql.transaction(() => {
          this.sql.exec("ALTER TABLE google_calendars RENAME TO google_calendars_single_account");
          this.sql.exec(GOOGLE_CALENDARS_SCHEMA);
          this.sql.exec(`INSERT INTO google_calendars
            (id, summary, description, background_color, is_selected, is_primary, sync_token, sync_token_expires_at, account_email, created_at)
            SELECT id, summary, description, background_color, is_selected, is_primary, sync_token, sync_token_expires_at,
              COALESCE(account_email, ''), created_at FROM google_calendars_single_account`);
          this.sql.exec("DROP TABLE google_calendars_single_account");
        })();
      }

      const calendarEventColumns = this.sql.pragma<
        Array<{
          name: string;
        }>
      >("table_info(calendar_events)");

      if (!calendarEventColumns.some((column) => column.name === "event_url")) {
        this.sql.exec("ALTER TABLE calendar_events ADD COLUMN event_url TEXT");
      }

      const contactColumns = this.sql.pragma<Array<{ name: string }>>("table_info(contacts)");

      if (!contactColumns.some((column) => column.name === "learned_name")) {
        this.sql.exec("ALTER TABLE contacts ADD COLUMN learned_name TEXT");
      }

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
        this.sql.exec(
          "UPDATE google_calendars SET sync_token = NULL, sync_token_expires_at = NULL"
        );
        this.sql.exec(
          "UPDATE microsoft_calendars SET sync_token = NULL, sync_token_expires_at = NULL"
        );
      }

      if (isNewProfile)
        this.sql
          .prepare("INSERT INTO folders (name, is_default, sort_order) VALUES ('Personal', 1, 0)")
          .run();

      const insertAction = this.sql.prepare(
        "INSERT INTO actions (name, description, prompt, icon, is_builtin, sort_order, translation_key) VALUES (?, ?, ?, ?, 1, ?, ?)"
      );

      const reseedBuiltinPrompt = this.sql.prepare(
        "UPDATE actions SET prompt = ? WHERE id = ? AND prompt = ? AND is_builtin = 1"
      );

      for (const action of BUILTIN_ACTIONS) {
        const existing = this.sql
          .prepare("SELECT id, prompt FROM actions WHERE translation_key = ? AND is_builtin = 1")
          .get<{ id: number; prompt: string }>(action.translationKey);

        if (!existing) {
          insertAction.run(
            action.name,
            action.description,
            action.prompt,
            action.icon,
            action.sortOrder,
            action.translationKey
          );
          continue;
        }

        const previousHash = createHash("sha256").update(existing.prompt, "utf8").digest("hex");

        if (
          action.previousPrompts.includes(existing.prompt) ||
          action.previousPromptHashes?.includes(previousHash)
        ) {
          reseedBuiltinPrompt.run(action.prompt, existing.id, existing.prompt);
        }
      }

      this._discardPlaintextCalendarTokens();

      return true;
    } catch (error) {
      // SAFETY: log sites only read `message`; a non-Error throw yields undefined.
      debugLogger.error(
        "Database initialization failed",
        { error: error instanceof Error ? error.message : String(error) },
        "database"
      );

      // Close is best-effort during failed init; the original error rethrows.
      try {
        this._db?.close();
      } catch {
        /* close during failed init */
      }

      this._db = null;
      throw error;
    }
  }

  createMeetingRecording(
    noteId: number,
    input: { config: unknown; configError?: unknown } | null,
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

    if (this.isMeetingNoteDeletionPending(noteId))
      throw new Error("Meeting note deletion is pending");
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

    // SAFETY: the UPDATE above just touched this row; it cannot be absent.
    return this.getMeetingRecording(id) as MeetingRecordingDto;
  }

  setMeetingRecordingMicIntentionallyEmpty(id: string, intentionallyEmpty: boolean): void {
    meetingRecordingIdSchema.parse(id);

    const result = this.sql
      .prepare(`UPDATE meeting_recordings
      SET source_metadata_json = json_set(source_metadata_json, '$.mic.intentionallyEmpty', json(?))
      WHERE id = ? AND capture_state IN ('recording', 'finalizing')`)
      .run(JSON.stringify(intentionallyEmpty), id);

    if (result.changes !== 1)
      throw new Error("Meeting recording is not accepting microphone intent");
  }

  getMeetingRecording(id: string): MeetingRecordingDto | null {
    meetingRecordingIdSchema.parse(id);

    const row = this.sql
      .prepare("SELECT * FROM meeting_recordings WHERE id = ?")
      .get<MeetingRecordingDbRow>(id);

    return row ? toMeetingRecordingDto(row) : null;
  }

  listOpenMeetingRecordings(): MeetingRecordingDto[] {
    return this.sql
      .prepare(
        "SELECT * FROM meeting_recordings WHERE capture_state IN ('recording', 'finalizing') ORDER BY started_at, id"
      )
      .all<MeetingRecordingDbRow>()
      .map((row) => toMeetingRecordingDto(row));
  }

  listMeetingRecordingsForNote(noteId: number): MeetingRecordingDto[] {
    if (!Number.isSafeInteger(noteId) || noteId < 1) return [];

    return this.sql
      .prepare("SELECT * FROM meeting_recordings WHERE note_id = ? ORDER BY started_at, id")
      .all<MeetingRecordingDbRow>(noteId)
      .map((row) => toMeetingRecordingDto(row));
  }

  listAllMeetingRecordings(): MeetingRecordingDto[] {
    return this.sql
      .prepare("SELECT * FROM meeting_recordings ORDER BY started_at, id")
      .all<MeetingRecordingDbRow>()
      .map((row) => toMeetingRecordingDto(row));
  }

  createMeetingRecordingEpoch(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number,
    sourceGeneration: number,
    sourceStartFrame: number,
    timelineStartFrame: number | null = null
  ): MeetingRecordingEpochDto {
    meetingRecordingIdSchema.parse(recordingId);
    meetingSourceSchema.parse(source);

    if (
      !Number.isSafeInteger(epochIndex) ||
      epochIndex < 0 ||
      epochIndex > 999_999 ||
      !Number.isSafeInteger(sourceGeneration) ||
      sourceGeneration < 1 ||
      !Number.isSafeInteger(sourceStartFrame) ||
      sourceStartFrame < 0 ||
      (timelineStartFrame !== null &&
        (!Number.isSafeInteger(timelineStartFrame) || timelineStartFrame < 0))
    ) {
      throw new RangeError("Invalid recording epoch position");
    }

    const recording = this.getMeetingRecording(recordingId);

    if (
      !recording ||
      recording.captureState !== "recording" ||
      recording.audioState !== "available"
    ) {
      throw new Error("Meeting recording is not accepting audio");
    }

    if (this.isMeetingNoteDeletionPending(recording.noteId)) {
      throw new Error("Meeting note deletion is pending");
    }

    const relativePath = relativeEpochPath(source, epochIndex);
    this.sql
      .prepare(
        "INSERT INTO meeting_recording_epochs (recording_id, source, epoch_index, timeline_start_frame, source_start_frame, source_generation, sample_rate, channels, encoding, relative_path) VALUES (?, ?, ?, ?, ?, ?, 24000, 1, 'opus', ?)"
      )
      .run(
        recordingId,
        source,
        epochIndex,
        timelineStartFrame,
        sourceStartFrame,
        sourceGeneration,
        relativePath
      );

    // SAFETY: the write above just touched this epoch row; it cannot be absent.
    return this.getMeetingRecordingEpoch(
      recordingId,
      source,
      epochIndex
    ) as MeetingRecordingEpochDto;
  }

  addMeetingRecordingEpochAlignment(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number,
    input: MeetingFrameAlignmentSegment
  ): MeetingRecordingEpochDto {
    meetingRecordingIdSchema.parse(recordingId);
    meetingSourceSchema.parse(source);
    const segment = meetingFrameAlignmentSegmentSchema.parse(input);
    const epoch = this.getMeetingRecordingEpoch(recordingId, source, epochIndex);

    if (
      !epoch ||
      epoch.sourceGeneration === null ||
      epoch.sourceGeneration <= 0 ||
      epoch.sourceStartFrame === null ||
      segment.sourceStartFrame < epoch.sourceStartFrame ||
      epoch.sourceGeneration !== segment.sourceGeneration
    ) {
      throw new Error("Audio alignment segment does not match its source epoch");
    }

    this.sql
      .prepare(`DELETE FROM meeting_recording_epoch_alignments
      WHERE recording_id = ? AND source = ? AND epoch_index = ?
      AND helper_generation = ? AND source_start_frame >= ? AND source_end_frame <= ?`)
      .run(
        recordingId,
        source,
        epochIndex,
        segment.helperGeneration,
        segment.sourceStartFrame,
        segment.sourceEndFrame
      );

    // Aggregate without GROUP BY always returns exactly one row in SQLite.
    const nextIndex = (
      this.sql
        .prepare(
          "SELECT COALESCE(MAX(segment_index), -1) + 1 AS next FROM meeting_recording_epoch_alignments WHERE recording_id = ? AND source = ? AND epoch_index = ?"
        )
        .get<{ next: number }>(recordingId, source, epochIndex) ?? { next: 0 }
    ).next;

    this.sql
      .prepare(`
      INSERT INTO meeting_recording_epoch_alignments (
        recording_id, source, epoch_index, segment_index, source_generation, source_start_frame, source_end_frame,
        timeline_start_frame, rate, uncertainty_start_frames, uncertainty_end_frames,
        helper_generation, source_start_ns, source_end_ns, helper_start_ns, helper_end_ns,
        sampled_source_start_ns, sampled_source_end_ns, freshness_source_ns
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        recordingId,
        source,
        epochIndex,
        nextIndex,
        segment.sourceGeneration,
        segment.sourceStartFrame,
        segment.sourceEndFrame,
        segment.timelineStartFrame,
        segment.rate,
        segment.uncertaintyStartFrames,
        segment.uncertaintyEndFrames,
        segment.helperGeneration,
        segment.sourceStartNs,
        segment.sourceEndNs,
        segment.helperStartNs,
        segment.helperEndNs,
        segment.sampledSourceStartNs,
        segment.sampledSourceEndNs,
        segment.freshnessSourceNs
      );

    // SAFETY: the write above just touched this epoch row; it cannot be absent.
    return this.getMeetingRecordingEpoch(
      recordingId,
      source,
      epochIndex
    ) as MeetingRecordingEpochDto;
  }

  markMeetingRecordingEpochAlignmentUnknown(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number,
    errorCode: string
  ): void {
    meetingRecordingIdSchema.parse(recordingId);
    meetingSourceSchema.parse(source);

    if (!/^[a-z0-9-]{1,80}$/.test(errorCode))
      throw new RangeError("Invalid audio alignment reason");
    this.sql
      .prepare(
        "UPDATE meeting_recording_epochs SET alignment_error_code = COALESCE(alignment_error_code, ?) WHERE recording_id = ? AND source = ? AND epoch_index = ?"
      )
      .run(errorCode, recordingId, source, epochIndex);
  }

  private listMeetingRecordingEpochAlignments(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number
  ): MeetingFrameAlignmentSegment[] {
    return this.sql
      .prepare(`
      SELECT source_generation, source_start_frame, source_end_frame, timeline_start_frame, rate,
        uncertainty_start_frames, uncertainty_end_frames, helper_generation,
        source_start_ns, source_end_ns, helper_start_ns, helper_end_ns,
        sampled_source_start_ns, sampled_source_end_ns, freshness_source_ns
      FROM meeting_recording_epoch_alignments
      WHERE recording_id = ? AND source = ? AND epoch_index = ? ORDER BY source_start_frame, segment_index
    `)
      .all<{
        source_generation: number;
        source_start_frame: number;
        source_end_frame: number;
        timeline_start_frame: number;
        rate: number;
        uncertainty_start_frames: number;
        uncertainty_end_frames: number;
        helper_generation: string;
        source_start_ns: string;
        source_end_ns: string;
        helper_start_ns: string;
        helper_end_ns: string;
        sampled_source_start_ns: string;
        sampled_source_end_ns: string;
        freshness_source_ns: string;
      }>(recordingId, source, epochIndex)
      .map((row) =>
        meetingFrameAlignmentSegmentSchema.parse({
          sourceGeneration: row.source_generation,
          sourceStartFrame: row.source_start_frame,
          sourceEndFrame: row.source_end_frame,
          timelineStartFrame: row.timeline_start_frame,
          rate: row.rate,
          uncertaintyStartFrames: row.uncertainty_start_frames,
          uncertaintyEndFrames: row.uncertainty_end_frames,
          helperGeneration: row.helper_generation,
          sourceStartNs: row.source_start_ns,
          sourceEndNs: row.source_end_ns,
          helperStartNs: row.helper_start_ns,
          helperEndNs: row.helper_end_ns,
          sampledSourceStartNs: row.sampled_source_start_ns,
          sampledSourceEndNs: row.sampled_source_end_ns,
          freshnessSourceNs: row.freshness_source_ns,
        })
      );
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
        "SELECT recording_id, source, epoch_index, timeline_start_frame, source_start_frame, source_generation, alignment_error_code, sample_rate, channels, encoding, relative_path, state, frame_count, ignored_trailing_bytes, error_code FROM meeting_recording_epochs WHERE recording_id = ? AND source = ? AND epoch_index = ?"
      )
      .get<MeetingRecordingEpochDbRow>(recordingId, source, epochIndex);

    if (!row) return null;

    if (row.relative_path !== relativeEpochPath(row.source, row.epoch_index)) {
      throw new Error("Invalid meeting recording epoch path");
    }

    return toMeetingEpochDto(
      row,
      this.listMeetingRecordingEpochAlignments(recordingId, source, epochIndex)
    );
  }

  listMeetingRecordingEpochs(recordingId: string): MeetingRecordingEpochDto[] {
    meetingRecordingIdSchema.parse(recordingId);

    return this.sql
      .prepare(
        "SELECT recording_id, source, epoch_index, timeline_start_frame, source_start_frame, source_generation, alignment_error_code, sample_rate, channels, encoding, relative_path, state, frame_count, ignored_trailing_bytes, error_code FROM meeting_recording_epochs WHERE recording_id = ? ORDER BY COALESCE(timeline_start_frame, source_start_frame, 0), source, epoch_index"
      )
      .all<MeetingRecordingEpochDbRow>(recordingId)
      .map((row) => {
        if (row.relative_path !== relativeEpochPath(row.source, row.epoch_index)) {
          throw new Error("Invalid meeting recording epoch path");
        }

        return toMeetingEpochDto(
          row,
          this.listMeetingRecordingEpochAlignments(recordingId, row.source, row.epoch_index)
        );
      });
  }

  openMeetingIntentionalInterval(
    recordingId: string,
    source: MeetingSource,
    sourceGeneration: number,
    startFrame: number,
    reason: MeetingIntentionalInterval["reason"],
    alignment: MeetingFrameAlignmentPoint | null = null
  ): MeetingIntentionalInterval {
    const existing = this.listMeetingIntentionalIntervals(recordingId).find(
      (item) =>
        item.source === source &&
        item.sourceGeneration === sourceGeneration &&
        item.reason === reason &&
        item.sourceEndFrame === null
    );

    if (existing) return existing;

    const interval = meetingIntentionalIntervalSchema.parse({
      id: randomUUID(),
      recordingId,
      source,
      sourceGeneration,
      reason,
      sourceStartFrame: startFrame,
      sourceEndFrame: null,
      timelineStartFrame: alignment?.timelineFrame ?? null,
      timelineEndFrame: null,
      startAlignment: alignment,
      endAlignment: null,
    });

    this.sql
      .prepare(`INSERT INTO meeting_recording_intentional_intervals
      (id, recording_id, source, source_generation, source_start_frame, timeline_start_frame, start_alignment_json, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        interval.id,
        recordingId,
        source,
        sourceGeneration,
        startFrame,
        interval.timelineStartFrame,
        alignment ? JSON.stringify(alignment) : null,
        reason
      );

    return interval;
  }

  closeMeetingIntentionalInterval(
    recordingId: string,
    source: MeetingSource,
    sourceGeneration: number,
    endFrame: number,
    reason: MeetingIntentionalInterval["reason"],
    alignment: MeetingFrameAlignmentPoint | null = null
  ): MeetingIntentionalInterval | null {
    const interval = this.listMeetingIntentionalIntervals(recordingId).find(
      (item) =>
        item.source === source &&
        item.sourceGeneration === sourceGeneration &&
        item.reason === reason &&
        item.sourceEndFrame === null
    );

    if (!interval) return null;

    const closed = meetingIntentionalIntervalSchema.parse({
      ...interval,
      sourceEndFrame: endFrame,
      timelineEndFrame: alignment?.timelineFrame ?? null,
      endAlignment: alignment,
    });

    this.sql
      .prepare(`UPDATE meeting_recording_intentional_intervals
      SET source_end_frame = ?, timeline_end_frame = ?, end_alignment_json = ? WHERE id = ? AND source_end_frame IS NULL`)
      .run(
        endFrame,
        closed.timelineEndFrame,
        alignment ? JSON.stringify(alignment) : null,
        interval.id
      );

    return closed;
  }

  listMeetingIntentionalIntervals(recordingId: string): MeetingIntentionalInterval[] {
    meetingRecordingIdSchema.parse(recordingId);

    return this.sql
      .prepare(`SELECT * FROM meeting_recording_intentional_intervals
      WHERE recording_id = ? ORDER BY COALESCE(source_start_frame, timeline_start_frame), id`)
      .all<{
        id: string;
        source: MeetingSource;
        source_generation: number | null;
        reason: MeetingIntentionalInterval["reason"];
        source_start_frame: number | null;
        source_end_frame: number | null;
        timeline_start_frame: number | null;
        timeline_end_frame: number | null;
        start_alignment_json: string | null;
        end_alignment_json: string | null;
      }>(recordingId)
      .map((row) =>
        meetingIntentionalIntervalSchema.parse({
          id: row.id,
          recordingId,
          source: row.source,
          reason: row.reason,
          sourceGeneration: row.source_generation,
          sourceStartFrame: row.source_start_frame,
          sourceEndFrame: row.source_end_frame,
          timelineStartFrame: row.timeline_start_frame,
          timelineEndFrame: row.timeline_end_frame,
          // SAFETY: alignment columns hold this manager's JSON segments.
          startAlignment: row.start_alignment_json
            ? (JSON.parse(row.start_alignment_json) as MeetingFrameAlignmentSegment[])
            : null,
          // SAFETY: manager-owned alignment column, same as startAlignment.
          endAlignment: row.end_alignment_json
            ? (JSON.parse(row.end_alignment_json) as MeetingFrameAlignmentSegment[])
            : null,
        })
      );
  }

  updateMeetingRecordingEpochRecovery(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number,
    result: { frameCount: number; ignoredTrailingBytes: number; errorCode?: string | null }
  ): MeetingRecordingEpochDto {
    meetingRecordingIdSchema.parse(recordingId);
    meetingSourceSchema.parse(source);

    if (!Number.isSafeInteger(epochIndex) || epochIndex < 0 || epochIndex > 999_999) {
      throw new RangeError("Invalid recording epoch index");
    }

    if (!Number.isSafeInteger(result.frameCount) || result.frameCount < 0) {
      throw new RangeError("Invalid recovered frame count");
    }

    if (!Number.isSafeInteger(result.ignoredTrailingBytes) || result.ignoredTrailingBytes < 0) {
      throw new RangeError("Invalid recovered frame remainder");
    }

    if (result.errorCode != null)
      meetingProcessingConfigErrorSchema.parse({ code: result.errorCode });
    const state = result.errorCode || result.ignoredTrailingBytes ? "incomplete" : "finalized";

    const update = this.sql
      .prepare(
        "UPDATE meeting_recording_epochs SET state = ?, frame_count = ?, ignored_trailing_bytes = ?, error_code = ?, updated_at = CURRENT_TIMESTAMP WHERE recording_id = ? AND source = ? AND epoch_index = ?"
      )
      .run(
        state,
        result.frameCount,
        result.ignoredTrailingBytes,
        result.errorCode ?? null,
        recordingId,
        source,
        epochIndex
      );

    if (!update.changes) throw new Error("Meeting recording epoch not found");

    // SAFETY: the write above just touched this epoch row; it cannot be absent.
    return this.getMeetingRecordingEpoch(
      recordingId,
      source,
      epochIndex
    ) as MeetingRecordingEpochDto;
  }

  markMeetingRecordingFinalizing(id: string): MeetingRecordingDto {
    meetingRecordingIdSchema.parse(id);
    const recording = this.getMeetingRecording(id);

    if (!recording) throw new Error("Meeting recording not found");

    if (recording.captureState === "ready" || recording.captureState === "incomplete")
      return recording;

    if (recording.audioState !== "available")
      throw new Error("Meeting recording audio is unavailable");
    this.sql
      .prepare(
        "UPDATE meeting_recordings SET capture_state = 'finalizing', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND capture_state IN ('recording', 'finalizing')"
      )
      .run(id);

    // SAFETY: the UPDATE above just touched this row; it cannot be absent.
    return this.getMeetingRecording(id) as MeetingRecordingDto;
  }

  finalizeMeetingRecording(
    id: string,
    input: {
      captureState: "ready" | "incomplete";
      endedAt: string;
      processingNotBefore?: string;
      // Free-form JSON metadata (mic.intentionallyEmpty, captureEndFrame,
      // ...) read back via parseJsonObject.
      sourceMetadata?: Record<string, unknown> | null;
      errorCode?: string | null;
    }
  ): { recording: MeetingRecordingDto; initialRun: MeetingProcessingRunDto } {
    meetingRecordingIdSchema.parse(id);

    if (input.errorCode != null)
      meetingProcessingConfigErrorSchema.parse({ code: input.errorCode });

    if (!Number.isFinite(new Date(input.endedAt).getTime()))
      throw new RangeError("Invalid meeting end time");

    if (
      input.processingNotBefore !== undefined &&
      !Number.isFinite(Date.parse(input.processingNotBefore))
    ) {
      throw new RangeError("Invalid meeting processing deadline");
    }

    const sourceMetadata = JSON.stringify(input.sourceMetadata ?? {});

    const transaction = this.sql.transaction(() => {
      const current = this.sql
        .prepare("SELECT * FROM meeting_recordings WHERE id = ?")
        .get<MeetingRecordingDbRow>(id);

      if (!current) throw new Error("Meeting recording not found");

      if (current.audio_state !== "available")
        throw new Error("Meeting recording audio is unavailable");

      const existing = this.sql
        .prepare(
          "SELECT * FROM meeting_processing_runs WHERE recording_id = ? AND kind = 'initial'"
        )
        .get<MeetingProcessingRunDbRow>(id);

      if (existing) {
        return {
          recording: toMeetingRecordingDto(current),
          initialRun: toMeetingRunDto(existing),
        };
      }

      if (current.capture_state === "ready" || current.capture_state === "incomplete") {
        throw new Error("Finalized meeting recording is missing its initial run");
      }

      const openEpochs = (
        this.sql
          .prepare(
            "SELECT COUNT(*) AS count FROM meeting_recording_epochs WHERE recording_id = ? AND state = 'open'"
          )
          .get<{ count: number }>(id) ?? { count: 0 }
      ).count;

      if (openEpochs > 0)
        throw new Error("Meeting recording epochs must be closed before finalization");

      const frames = (
        this.sql
          .prepare(
            "SELECT COALESCE(SUM(frame_count), 0) AS frame_count FROM meeting_recording_epochs WHERE recording_id = ?"
          )
          .get<{ frame_count: number }>(id) ?? { frame_count: 0 }
      ).frame_count;

      const incompleteEpochs = (
        this.sql
          .prepare(
            "SELECT COUNT(*) AS count FROM meeting_recording_epochs WHERE recording_id = ? AND state = 'incomplete'"
          )
          .get<{ count: number }>(id) ?? { count: 0 }
      ).count;

      const captureState =
        frames > 0 && !input.errorCode && incompleteEpochs === 0
          ? input.captureState
          : "incomplete";

      const noAudioError = frames > 0 ? null : "recording-audio-unavailable";
      this.sql
        .prepare(
          "UPDATE meeting_recordings SET capture_state = ?, ended_at = ?, source_metadata_json = ?, capture_error_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(
          captureState,
          input.endedAt,
          sourceMetadata,
          noAudioError ?? input.errorCode ?? null,
          id
        );

      const sourceRecordingIds = this.listMeetingRecordingsForNote(current.note_id)
        .filter(
          (part) =>
            part.audioState === "available" &&
            ["ready", "incomplete"].includes(part.captureState) &&
            part.captureErrorCode !== "recording-audio-unavailable"
        )
        .map((part) => part.id);

      const config = parseConfig(current.config_json);

      const configError = configErrorFromRow(
        current.config_error_code,
        current.config_error_message_key
      );

      const runId = randomUUID();
      const status = config === null || noAudioError ? "blocked" : "pending";
      const errorCode = noAudioError ?? configError?.code ?? null;

      const retryAt = !noAudioError
        ? (input.processingNotBefore ?? new Date(Date.now() + MEETING_ASR_GATE_MS).toISOString())
        : null;

      const transcription = config?.transcription;

      const provider =
        transcription?.mode === "local"
          ? (transcription.local?.provider ?? null)
          : (transcription?.provider ?? null);

      const model =
        transcription?.mode === "local"
          ? (transcription.local?.model ?? null)
          : (transcription?.model ?? null);

      this.sql
        .prepare(
          "INSERT INTO meeting_processing_runs (id, recording_id, source_recording_ids_json, kind, provider, model, config_json, config_error_code, config_error_message_key, stage, status, error_code, retry_at) VALUES (?, ?, ?, 'initial', ?, ?, ?, ?, ?, 'prepare', ?, ?, ?)"
        )
        .run(
          runId,
          id,
          JSON.stringify(sourceRecordingIds.length ? sourceRecordingIds : [id]),
          provider,
          model,
          current.config_json,
          current.config_error_code,
          current.config_error_message_key,
          status,
          errorCode,
          retryAt
        );
      this.sql
        .prepare(
          "UPDATE meeting_recordings SET current_run_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(runId, id);

      const recording = this.sql
        .prepare("SELECT * FROM meeting_recordings WHERE id = ?")
        .get<MeetingRecordingDbRow>(id);

      const run = this.sql
        .prepare("SELECT * FROM meeting_processing_runs WHERE id = ?")
        .get<MeetingProcessingRunDbRow>(runId);

      if (!recording || !run)
        throw new Error("Recording or run vanished inside its own transaction");

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
      retryAt?: string | null;
    }
  ): MeetingProcessingRunDto {
    meetingRecordingIdSchema.parse(recordingId);

    if (input.config !== null) meetingProcessingConfigSchema.parse(input.config);

    if (input.configError != null) meetingProcessingConfigErrorSchema.parse(input.configError);

    if (input.retryAt != null && !Number.isFinite(Date.parse(input.retryAt))) {
      throw new RangeError("Invalid meeting processing deadline");
    }

    const transaction = this.sql.transaction(() => {
      const recording = this.getMeetingRecording(recordingId);

      if (!recording) throw new Error("Meeting recording not found");
      const sourceRecordingIds = input.sourceRecordingIds ?? [recordingId];

      if (input.kind === "reprocess") {
        if (
          sourceRecordingIds[0] !== recordingId ||
          new Set(sourceRecordingIds).size !== sourceRecordingIds.length
        ) {
          throw new Error("Invalid meeting audio parts");
        }

        for (const sourceId of sourceRecordingIds) {
          meetingRecordingIdSchema.parse(sourceId);
          const source = this.getMeetingRecording(sourceId);

          if (
            !source ||
            source.noteId !== recording.noteId ||
            source.audioState !== "available" ||
            !["ready", "incomplete"].includes(source.captureState)
          ) {
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
          .get<MeetingProcessingRunDbRow>(input.sourceRunId, recordingId);

        if (!sourceRun) throw new Error("Summary source transcript not found");
      }

      const snapshot =
        input.config === null
          ? { config: null, error: input.configError ?? { code: "missing-config" } }
          : { config: meetingProcessingConfigSchema.parse(input.config), error: null };

      const runId = randomUUID();
      const stage: MeetingRunStage = input.kind === "summary" ? "summary" : "prepare";
      const summaryMissing = input.kind === "summary" && snapshot.config?.summary == null;

      const status: MeetingRunStatus =
        snapshot.config === null || summaryMissing ? "blocked" : "pending";

      const transcription = snapshot.config?.transcription;

      const provider =
        transcription?.mode === "local"
          ? (transcription.local?.provider ?? null)
          : (transcription?.provider ?? null);

      const model =
        transcription?.mode === "local"
          ? (transcription.local?.model ?? null)
          : (transcription?.model ?? null);

      this.sql
        .prepare(
          "INSERT INTO meeting_processing_runs (id, recording_id, source_recording_ids_json, omitted_recording_ids_json, kind, source_run_id, provider, model, config_json, config_error_code, config_error_message_key, stage, status, error_code, retry_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          runId,
          recordingId,
          JSON.stringify(
            input.kind === "summary"
              ? sourceRun &&
                  JSON.parse(sourceRun.source_recording_ids_json ?? JSON.stringify([recordingId]))
              : sourceRecordingIds
          ),
          sourceRun ? sourceRun.omitted_recording_ids_json : "[]",
          input.kind,
          sourceRun?.id ?? null,
          provider,
          model,
          configJson(snapshot.config),
          snapshot.error?.code ?? null,
          snapshot.error?.messageKey ?? null,
          stage,
          status,
          snapshot.error?.code ?? (summaryMissing ? "missing-summary-config" : null),
          input.retryAt ?? null
        );
      this.sql
        .prepare(
          "UPDATE meeting_recordings SET current_run_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(runId, recordingId);

      const updated = this.sql
        .prepare("SELECT * FROM meeting_processing_runs WHERE id = ?")
        .get<MeetingProcessingRunDbRow>(runId);

      if (!updated) throw new Error("Run vanished inside its own transaction");

      return toMeetingRunDto(updated);
    });

    return transaction();
  }

  getMeetingProcessingRun(id: string): MeetingProcessingRunDto | null {
    meetingRecordingIdSchema.parse(id);

    const row = this.sql
      .prepare("SELECT * FROM meeting_processing_runs WHERE id = ?")
      .get<MeetingProcessingRunDbRow>(id);

    return row ? toMeetingRunDto(row) : null;
  }

  setMeetingRunBbThreadId(id: string, bbThreadId: string): boolean {
    meetingRecordingIdSchema.parse(id);

    if (!/^thr_[a-z0-9]+$/.test(bbThreadId)) throw new Error("Invalid bb thread id");

    const result = this.sql
      .prepare(
        "UPDATE meeting_processing_runs SET bb_thread_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND stage IN ('normalize', 'summary') AND status = 'running' AND bb_thread_id IS NULL"
      )
      .run(bbThreadId, id);

    return result.changes === 1;
  }

  listMeetingProcessingRuns(recordingId: string): MeetingProcessingRunDto[] {
    meetingRecordingIdSchema.parse(recordingId);

    return this.sql
      .prepare(
        "SELECT * FROM meeting_processing_runs WHERE recording_id = ? ORDER BY created_at, rowid"
      )
      .all<MeetingProcessingRunDbRow>(recordingId)
      .map(toMeetingRunDto);
  }

  listAllMeetingProcessingRuns(): MeetingProcessingRunDto[] {
    return this.sql
      .prepare("SELECT * FROM meeting_processing_runs ORDER BY created_at, rowid")
      .all<MeetingProcessingRunDbRow>()
      .map(toMeetingRunDto);
  }

  recoverRunningMeetingProcessingRuns(): number {
    const result = this.sql
      .prepare(
        "UPDATE meeting_processing_runs SET status = 'pending', retry_count = CASE WHEN stage = 'asr' AND raw_response_path IS NULL THEN retry_count + 1 ELSE retry_count END, error_code = CASE WHEN stage = 'asr' AND raw_response_path IS NULL THEN 'asr-outcome-unknown' ELSE NULL END, updated_at = CURRENT_TIMESTAMP WHERE status = 'running' AND EXISTS (SELECT 1 FROM meeting_recordings r LEFT JOIN meeting_deletion_intents d ON d.note_id = r.note_id AND d.kind = 'note' WHERE r.id = meeting_processing_runs.recording_id AND d.id IS NULL)"
      )
      .run();

    return result.changes;
  }

  claimMeetingProcessingRun(id: string, now = new Date().toISOString()): boolean {
    meetingRecordingIdSchema.parse(id);

    if (!Number.isFinite(Date.parse(now)))
      throw new RangeError("Invalid meeting processing claim time");

    const result = this.sql
      .prepare(
        "UPDATE meeting_processing_runs SET status = 'running', error_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending' AND (retry_at IS NULL OR retry_at <= ?) AND NOT EXISTS (SELECT 1 FROM meeting_processing_runs active WHERE active.status = 'running' AND active.id != meeting_processing_runs.id) AND EXISTS (SELECT 1 FROM meeting_recordings r LEFT JOIN meeting_deletion_intents d ON d.note_id = r.note_id AND d.kind = 'note' WHERE r.id = meeting_processing_runs.recording_id AND d.id IS NULL AND (r.audio_state = 'available' OR meeting_processing_runs.stage IN ('normalize', 'summary')))"
      )
      .run(id, now);

    return result.changes > 0;
  }

  retryMeetingProcessingRun(id: string): MeetingProcessingRunDto | null {
    meetingRecordingIdSchema.parse(id);
    const run = this.getMeetingProcessingRun(id);

    if (!run || !["blocked", "failed", "cancelled"].includes(run.status)) return null;
    const recording = this.getMeetingRecording(run.recordingId);

    if (!recording || this.isMeetingNoteDeletionPending(recording.noteId)) return null;

    if (
      recording.audioState !== "available" &&
      !run.hasRawProviderResponse &&
      run.kind !== "summary"
    ) {
      return null;
    }

    const stage =
      run.kind === "summary"
        ? "summary"
        : run.hasTranscript
          ? "summary"
          : run.hasRawProviderResponse
            ? "normalize"
            : "prepare";

    const retryAt =
      stage === "prepare" && run.retryAt && Date.parse(run.retryAt) > Date.now()
        ? run.retryAt
        : null;

    this.sql
      .prepare(
        "UPDATE meeting_processing_runs SET stage = ?, status = 'pending', error_code = NULL, retry_at = ?, retry_count = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('blocked', 'failed', 'cancelled')"
      )
      .run(stage, retryAt, id);

    return this.getMeetingProcessingRun(id);
  }

  setMeetingProcessingRunState(
    id: string,
    update: {
      stage: MeetingRunStage;
      status: MeetingRunStatus;
      errorCode?: string | null;
      retryAt?: string | null;
      retryCount?: number;
    }
  ): SuccessResult {
    meetingRecordingIdSchema.parse(id);

    if (update.errorCode != null)
      meetingProcessingConfigErrorSchema.parse({ code: update.errorCode });

    if (
      update.retryCount !== undefined &&
      (!Number.isSafeInteger(update.retryCount) || update.retryCount < 0)
    ) {
      throw new RangeError("Invalid meeting run retry count");
    }

    const result = this.sql
      .prepare(
        "UPDATE meeting_processing_runs SET stage = ?, status = ?, error_code = ?, retry_at = ?, retry_count = COALESCE(?, retry_count), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND EXISTS (SELECT 1 FROM meeting_recordings r LEFT JOIN meeting_deletion_intents d ON d.note_id = r.note_id AND d.kind = 'note' WHERE r.id = meeting_processing_runs.recording_id AND (r.audio_state = 'available' OR (? IN ('normalize', 'summary') AND (meeting_processing_runs.raw_response_path IS NOT NULL OR meeting_processing_runs.transcript_path IS NOT NULL OR (meeting_processing_runs.kind = 'summary' AND EXISTS (SELECT 1 FROM meeting_processing_runs source WHERE source.id = meeting_processing_runs.source_run_id AND source.transcript_path IS NOT NULL))))) AND d.id IS NULL)"
      )
      .run(
        update.stage,
        update.status,
        update.errorCode ?? null,
        update.retryAt ?? null,
        update.retryCount ?? null,
        id,
        update.stage
      );

    return { success: result.changes > 0 };
  }

  setMeetingRunOmittedRecordings(id: string, ids: string[]): boolean {
    meetingRecordingIdSchema.parse(id);
    const omitted = z.array(meetingRecordingIdSchema).parse(ids);
    const run = this.getMeetingProcessingRun(id);

    if (!run || run.status !== "running" || run.stage !== "prepare" || run.hasRawProviderResponse)
      return false;

    if (
      new Set(omitted).size !== omitted.length ||
      omitted.some((part) => !run.sourceRecordingIds.includes(part))
    )
      throw new Error("Invalid omitted meeting audio parts");

    const result = this.sql
      .prepare(
        "UPDATE meeting_processing_runs SET omitted_recording_ids_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND stage = 'prepare' AND status = 'running' AND raw_response_path IS NULL"
      )
      .run(JSON.stringify(omitted), id);

    return result.changes === 1;
  }

  setMeetingRunArtifact(id: string, artifact: MeetingRunArtifact): SuccessResult {
    meetingRecordingIdSchema.parse(id);
    meetingRunArtifactSchema.parse(artifact);

    const column =
      artifact === "provider-response"
        ? "raw_response_path"
        : artifact === "transcript"
          ? "transcript_path"
          : "summary_path";

    const name =
      artifact === "provider-response"
        ? "raw-provider-response.json"
        : artifact === "transcript"
          ? "transcript.json"
          : "summary.json";

    const audioRequired = artifact === "provider-response";

    const prerequisite =
      artifact === "transcript"
        ? "AND meeting_processing_runs.raw_response_path IS NOT NULL"
        : artifact === "summary"
          ? "AND (meeting_processing_runs.transcript_path IS NOT NULL OR (meeting_processing_runs.kind = 'summary' AND meeting_processing_runs.source_run_id IS NOT NULL))"
          : "";

    const immutableRawResponse =
      artifact === "provider-response" ? "AND raw_response_path IS NULL" : "";

    const result = this.sql
      .prepare(
        `UPDATE meeting_processing_runs SET ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? ${immutableRawResponse} ${prerequisite} AND EXISTS (SELECT 1 FROM meeting_recordings r LEFT JOIN meeting_deletion_intents d ON d.note_id = r.note_id AND d.kind = 'note' WHERE r.id = meeting_processing_runs.recording_id AND (? = 0 OR r.audio_state = 'available') AND d.id IS NULL)`
      )
      .run(name, id, audioRequired ? 1 : 0);

    return { success: result.changes > 0 };
  }

  reconcileMeetingRunArtifact(id: string, artifact: MeetingRunArtifact): SuccessResult {
    meetingRecordingIdSchema.parse(id);
    meetingRunArtifactSchema.parse(artifact);

    const column =
      artifact === "provider-response"
        ? "raw_response_path"
        : artifact === "transcript"
          ? "transcript_path"
          : "summary_path";

    const name = meetingRunArtifactFileName(artifact);

    const prerequisite =
      artifact === "transcript"
        ? "AND raw_response_path IS NOT NULL"
        : artifact === "summary"
          ? "AND (transcript_path IS NOT NULL OR (kind = 'summary' AND source_run_id IS NOT NULL))"
          : "";

    const result = this.sql
      .prepare(
        `UPDATE meeting_processing_runs SET ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND ${column} IS NULL ${prerequisite} AND EXISTS (SELECT 1 FROM meeting_recordings r LEFT JOIN meeting_deletion_intents d ON d.note_id = r.note_id AND d.kind = 'note' WHERE r.id = meeting_processing_runs.recording_id AND (? = 0 OR r.audio_state = 'available') AND d.id IS NULL)`
      )
      .run(name, id, artifact === "provider-response" ? 1 : 0);

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

    const row = this.sql
      .prepare(
        "SELECT p.*, r.audio_state, r.note_id FROM meeting_processing_runs p JOIN meeting_recordings r ON r.id = p.recording_id WHERE p.id = ? AND p.status = 'blocked'"
      )
      .get<MeetingProcessingRunDbRow & { audio_state: MeetingAudioState; note_id: number }>(id);

    if (!row || row.kind === "summary" || this.isMeetingNoteDeletionPending(row.note_id))
      return null;

    const hasNoArtifacts =
      row.raw_response_path === null && row.transcript_path === null && row.summary_path === null;

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

      const updated = this.sql
        .prepare(
          "UPDATE meeting_processing_runs SET config_json = ?, config_error_code = NULL, config_error_message_key = NULL, status = 'pending', error_code = NULL, retry_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'blocked' AND stage = 'summary' AND error_code = 'missing-summary-config' AND transcript_path IS NOT NULL AND summary_path IS NULL"
        )
        .run(configJson(config), id);

      return updated.changes === 1 ? this.getMeetingProcessingRun(id) : null;
    }

    if (row.kind === "reprocess" && row.audio_state !== "available") return null;
    const nextError = error ?? (config === null ? { code: "missing-config" } : null);
    const transcription = config?.transcription;

    const provider =
      transcription?.mode === "local"
        ? (transcription.local?.provider ?? null)
        : (transcription?.provider ?? null);

    const model =
      transcription?.mode === "local"
        ? (transcription.local?.model ?? null)
        : (transcription?.model ?? null);

    this.sql
      .prepare(
        "UPDATE meeting_processing_runs SET provider = ?, model = ?, config_json = ?, config_error_code = ?, config_error_message_key = ?, status = ?, error_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'blocked'"
      )
      .run(
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
    displayName: string,
    source: "voice" | "platform" | "model" | "user" = "user",
    participantEmail?: string,
    platform?: MeetingPlatform
  ): SuccessResult & { noteId?: number } {
    meetingRecordingIdSchema.parse(runId);
    const run = this.getMeetingProcessingRun(runId);

    if (source === "platform" && !platform) return { success: false };

    if (!run || !speakerId.trim() || !displayName.trim()) return { success: false };

    if (profileId !== null && (!Number.isSafeInteger(profileId) || profileId < 1))
      return { success: false };

    const transaction = this.sql.transaction(() => {
      const recording = this.sql
        .prepare("SELECT note_id, current_run_id FROM meeting_recordings WHERE id = ?")
        .get<{ note_id: number; current_run_id: string | null }>(run.recordingId);

      if (!recording || this.isMeetingNoteDeletionPending(recording.note_id))
        return { success: false };
      this.sql
        .prepare(
          "INSERT INTO meeting_run_speaker_corrections (run_id, speaker_id, profile_id, display_name, participant_email, source, platform, revision) VALUES (?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT(run_id, speaker_id) DO UPDATE SET profile_id = excluded.profile_id, display_name = excluded.display_name, participant_email = excluded.participant_email, source = excluded.source, platform = excluded.platform, revision = meeting_run_speaker_corrections.revision + 1"
        )
        .run(
          runId,
          speakerId,
          profileId,
          displayName.trim(),
          participantEmail?.toLowerCase() ?? null,
          source,
          source === "platform" ? platform : null
        );

      if (participantEmail) this.rememberContactName(participantEmail, displayName);

      const selected = recording.current_run_id
        ? this.getMeetingProcessingRun(recording.current_run_id)
        : null;

      const selectedTranscriptRunId =
        selected?.kind === "summary" ? selected.sourceRunId : selected?.id;

      let noteId: number | undefined;

      if (selectedTranscriptRunId === runId) {
        const note = this.sql
          .prepare("SELECT transcript FROM notes WHERE id = ?")
          .get<{ transcript: string | null }>(recording.note_id);

        if (note?.transcript) {
          try {
            // SAFETY: transcript segments are JSON objects written by the
            // transcription pipeline; only field reads/mutates happen here.
            const segments = JSON.parse(note.transcript) as Array<Record<string, unknown>>;
            let changed = false;

            for (const segment of segments) {
              if (segment.speaker !== speakerId) continue;
              segment.speakerName = displayName.trim();
              segment.speakerIsPlaceholder = false;
              segment.speakerStatus = "locked";
              segment.speakerLocked = true;
              segment.speakerLockSource = source;

              if (source === "platform") segment.speakerPlatform = platform;
              else delete segment.speakerPlatform;
              changed = true;
            }

            if (changed) {
              const transcript = JSON.stringify(segments);
              this.sql
                .prepare(
                  "UPDATE notes SET transcript = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
                )
                .run(transcript, recording.note_id);
              noteId = recording.note_id;
            }
          } catch (error) {
            throw new Error("Meeting transcript projection is invalid", { cause: error });
          }
        }
      }

      return { success: true, ...(noteId === undefined ? {} : { noteId }) };
    });

    return transaction();
  }

  getMeetingRunSpeakerCorrections(runId: string): Array<{
    speakerId: string;
    profileId: number | null;
    displayName: string;
    participantEmail: string | null;
    source: "voice" | "platform" | "model" | "user";
    platform?: MeetingPlatform;
    revision: number;
  }> {
    meetingRecordingIdSchema.parse(runId);

    return this.sql
      .prepare(
        "SELECT speaker_id, profile_id, display_name, participant_email, source, platform, revision FROM meeting_run_speaker_corrections WHERE run_id = ? AND display_name <> '' ORDER BY speaker_id"
      )
      .all<{
        speaker_id: string;
        profile_id: number | null;
        display_name: string;
        participant_email: string | null;
        source: "voice" | "platform" | "model" | "user";
        platform: MeetingPlatform | null;
        revision: number;
      }>(runId)
      .map((row) => ({
        speakerId: row.speaker_id,
        profileId: row.profile_id,
        displayName: row.display_name,
        participantEmail: row.participant_email,
        source: row.source,
        ...(row.source === "platform" && row.platform ? { platform: row.platform } : {}),
        revision: row.revision,
      }));
  }

  getMeetingRunSpeakerCorrectionRevision(runId: string): number {
    meetingRecordingIdSchema.parse(runId);

    const row = this.sql
      .prepare(
        "SELECT COALESCE(SUM(revision), 0) AS revision FROM meeting_run_speaker_corrections WHERE run_id = ?"
      )
      .get<{ revision: number }>(runId);

    // Aggregate without GROUP BY always returns exactly one row in SQLite.
    return row?.revision ?? 0;
  }

  applyAutomaticMeetingSpeakerCorrections(
    runId: string,
    expectedCurrentRunId: string,
    expectedRevision: number,
    corrections: Array<{
      speakerId: string;
      profileId: number | null;
      displayName: string;
      platform?: MeetingPlatform;
    }>,
    source: "voice" | "platform" | "model",
    rejectedModelSpeakerIds: string[] = []
  ): boolean {
    meetingRecordingIdSchema.parse(runId);
    meetingRecordingIdSchema.parse(expectedCurrentRunId);
    const run = this.getMeetingProcessingRun(runId);
    const currentRun = this.getMeetingProcessingRun(expectedCurrentRunId);

    if (
      !run ||
      !currentRun ||
      currentRun.recordingId !== run.recordingId ||
      corrections.some(
        (item) =>
          !item.speakerId.trim() ||
          !item.displayName.trim() ||
          (source === "platform" && !item.platform) ||
          (item.profileId !== null && (!Number.isSafeInteger(item.profileId) || item.profileId < 1))
      )
    )
      return false;

    if (new Set(corrections.map((item) => item.speakerId)).size !== corrections.length)
      return false;

    if (
      rejectedModelSpeakerIds.length &&
      (source !== "model" ||
        new Set(rejectedModelSpeakerIds).size !== rejectedModelSpeakerIds.length ||
        rejectedModelSpeakerIds.some(
          (id) => !id.trim() || corrections.some((item) => item.speakerId === id)
        ))
    )
      return false;

    const transaction = this.sql.transaction(() => {
      const recording = this.sql
        .prepare("SELECT note_id, current_run_id FROM meeting_recordings WHERE id = ?")
        .get<{ note_id: number; current_run_id: string | null }>(run.recordingId);

      if (
        !recording ||
        recording.current_run_id !== expectedCurrentRunId ||
        this.isMeetingNoteDeletionPending(recording.note_id) ||
        this.getMeetingRunSpeakerCorrectionRevision(runId) !== expectedRevision
      )
        return false;

      const exists = this.sql.prepare(
        "SELECT source, display_name FROM meeting_run_speaker_corrections WHERE run_id = ? AND speaker_id = ?"
      );

      if (
        corrections.some((correction) => {
          const existing = exists.get<{ source: string; display_name: string }>(
            runId,
            correction.speakerId
          );

          // SAFETY: `source` is the table's CHECK-constrained enum; unknown
          // sources sort last via ??.
          const priority = new Map<string, number>([
            ["model", 0],
            ["platform", 1],
            ["voice", 2],
            ["user", 3],
          ]);

          return (
            !!existing?.display_name &&
            ((priority.get(existing.source) ?? Number.MAX_SAFE_INTEGER) >
              (priority.get(source) ?? Number.MAX_SAFE_INTEGER) ||
              (existing.source === source && source !== "model"))
          );
        })
      )
        return false;

      if (
        rejectedModelSpeakerIds.some(
          // SAFETY: the corrections table `source` column is a string enum.
          (id) => (exists.get(runId, id) as { source: string } | undefined)?.source !== "model"
        )
      )
        return false;

      const insert = this.sql.prepare(
        "INSERT INTO meeting_run_speaker_corrections (run_id, speaker_id, profile_id, display_name, source, platform, revision) VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(run_id, speaker_id) DO UPDATE SET profile_id = excluded.profile_id, display_name = excluded.display_name, participant_email = NULL, source = excluded.source, platform = excluded.platform, revision = meeting_run_speaker_corrections.revision + 1"
      );

      for (const correction of corrections) {
        insert.run(
          runId,
          correction.speakerId,
          correction.profileId,
          correction.displayName.trim(),
          source,
          source === "platform" ? correction.platform : null
        );
      }

      // Keep a cleared proposal's row so SUM(revision) never returns to an old value.
      const clear = this.sql.prepare(
        "UPDATE meeting_run_speaker_corrections SET display_name = '', profile_id = NULL, participant_email = NULL, revision = revision + 1 WHERE run_id = ? AND speaker_id = ? AND source = 'model'"
      );

      for (const id of rejectedModelSpeakerIds) clear.run(runId, id);

      return true;
    });

    return transaction();
  }

  recoverMeetingPlatformCoverage(): void {
    this.sql.exec(
      "UPDATE meeting_platform_coverage SET coverage_json = json_set(coverage_json, '$.state', 'incomplete', '$.reason', 'app-restarted') WHERE json_extract(coverage_json, '$.state') = 'collecting'"
    );
  }

  saveMeetingPlatformObservation(input: MeetingPlatformObservation): void {
    const observation = meetingPlatformObservationSchema.parse(input);
    this.sql
      .prepare(
        "INSERT INTO meeting_platform_observations (id, recording_id, evidence_json) VALUES (?, ?, ?)"
      )
      .run(observation.id, observation.recordingId, JSON.stringify(observation));
  }

  listMeetingPlatformObservations(recordingId: string): MeetingPlatformObservation[] {
    meetingRecordingIdSchema.parse(recordingId);

    return this.sql
      .prepare(
        "SELECT evidence_json FROM meeting_platform_observations WHERE recording_id = ? ORDER BY rowid"
      )
      .all<{ evidence_json: string }>(recordingId)
      .map((row) => meetingPlatformObservationSchema.parse(JSON.parse(row.evidence_json)));
  }

  saveMeetingAudioClockAnchor(input: MeetingAudioClockAnchor): void {
    const anchor = meetingAudioClockAnchorSchema.parse(input);

    const epoch = this.listMeetingRecordingEpochs(anchor.recordingId).find(
      (item) => item.source === "system" && item.epochIndex === anchor.epochIndex
    );

    if (!epoch || epoch.timelineStartFrame !== anchor.epochStartFrame)
      throw new Error("Clock anchor epoch does not match captured audio");
    this.sql
      .prepare(
        "INSERT INTO meeting_audio_clock_anchors (id, recording_id, evidence_json) VALUES (?, ?, ?)"
      )
      .run(anchor.id, anchor.recordingId, JSON.stringify(anchor));
  }

  listMeetingAudioClockAnchors(recordingId: string): MeetingAudioClockAnchor[] {
    meetingRecordingIdSchema.parse(recordingId);

    return this.sql
      .prepare(
        "SELECT evidence_json FROM meeting_audio_clock_anchors WHERE recording_id = ? ORDER BY rowid"
      )
      .all<{ evidence_json: string }>(recordingId)
      .map((row) => meetingAudioClockAnchorSchema.parse(JSON.parse(row.evidence_json)));
  }

  setMeetingPlatformCoverage(recordingId: string, input: MeetingPlatformCoverage): void {
    meetingRecordingIdSchema.parse(recordingId);
    const coverage = meetingPlatformCoverageSchema.parse(input);
    this.sql
      .prepare(
        "INSERT INTO meeting_platform_coverage (recording_id, coverage_json) VALUES (?, ?) ON CONFLICT(recording_id) DO UPDATE SET coverage_json = excluded.coverage_json"
      )
      .run(recordingId, JSON.stringify(coverage));
  }

  getMeetingPlatformCoverage(recordingId: string): MeetingPlatformCoverage | null {
    meetingRecordingIdSchema.parse(recordingId);

    const row = this.sql
      .prepare("SELECT coverage_json FROM meeting_platform_coverage WHERE recording_id = ?")
      .get<{ coverage_json: string }>(recordingId);

    return row ? meetingPlatformCoverageSchema.parse(JSON.parse(row.coverage_json)) : null;
  }

  getMeetingRunPlatformDecisions(runId: string): MeetingPlatformDecision[] {
    meetingRecordingIdSchema.parse(runId);

    const row = this.sql
      .prepare("SELECT decisions_json FROM meeting_run_platform_decisions WHERE run_id = ?")
      .get<{ decisions_json: string }>(runId);

    return row
      ? // SAFETY: decisions_json is this manager's JSON array of decisions;
        // every item is schema-parsed right after the cast.
        (JSON.parse(row.decisions_json) as unknown[]).map((item) =>
          meetingPlatformDecisionSchema.parse(item)
        )
      : [];
  }

  // Same transaction owns accepted corrections and evidence; guards also protect
  // rejection-only results from stale selection, cancellation and manual edits.
  applyMeetingPlatformDecisions(
    runId: string,
    expectedRevision: number,
    inputs: MeetingPlatformDecision[]
  ): boolean {
    const decisions = inputs.map((input) => meetingPlatformDecisionSchema.parse(input));

    return this.sql.transaction(() => {
      const run = this.getMeetingProcessingRun(runId);

      if (!run || run.status !== "running") return false;
      const recording = this.getMeetingRecording(run.recordingId);

      if (
        !recording ||
        recording.currentRunId !== runId ||
        this.isMeetingNoteDeletionPending(recording.noteId) ||
        this.getMeetingRunSpeakerCorrectionRevision(runId) !== expectedRevision
      )
        return false;
      const corrections = this.getMeetingRunSpeakerCorrections(runId);

      const accepted: Array<{
        speakerId: string;
        profileId: null;
        displayName: string;
        platform: MeetingPlatform;
      }> = [];

      for (const decision of decisions) {
        if (decision.status !== "accepted" || !decision.speakerId || !decision.displayName)
          continue;

        if (
          !decision.speakerId.startsWith("system:") ||
          !decision.timingPolicy ||
          !decision.observationIds.length ||
          !decision.clockAnchorIds.length
        )
          return false;

        const observations = meetingRunAudioPartIds(run).flatMap((id) =>
          this.listMeetingPlatformObservations(id)
        );

        const anchors = meetingRunAudioPartIds(run).flatMap((id) =>
          this.listMeetingAudioClockAnchors(id)
        );

        if (
          decision.observationIds.some(
            (id) =>
              !observations.some((item) => item.id === id && item.platform === decision.platform)
          ) ||
          decision.clockAnchorIds.some((id) => !anchors.some((item) => item.id === id))
        )
          return false;
        const existing = corrections.find((item) => item.speakerId === decision.speakerId);

        if (existing?.source === "user" || existing?.source === "voice") {
          decision.status = "rejected";
          decision.reason = existing.source + "-precedence";
        } else if (
          !(existing?.source === "platform" && existing.displayName === decision.displayName)
        ) {
          const duplicate = accepted.find((item) => item.speakerId === decision.speakerId);

          if (duplicate && duplicate.displayName !== decision.displayName) return false;

          if (!duplicate)
            accepted.push({
              speakerId: decision.speakerId,
              profileId: null,
              displayName: decision.displayName,
              platform: decision.platform,
            });
        }
      }

      if (
        accepted.length &&
        !this.applyAutomaticMeetingSpeakerCorrections(
          runId,
          runId,
          expectedRevision,
          accepted,
          "platform"
        )
      )
        return false;
      this.sql
        .prepare(
          "INSERT INTO meeting_run_platform_decisions (run_id, decisions_json) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET decisions_json = excluded.decisions_json"
        )
        .run(runId, JSON.stringify(decisions));

      return true;
    })();
  }

  getMeetingRunLlmSourceSnapshot(runId: string): string | null {
    meetingRecordingIdSchema.parse(runId);

    const row = this.sql
      .prepare("SELECT llm_source_snapshot_json FROM meeting_processing_runs WHERE id = ?")
      .get<{ llm_source_snapshot_json: string | null }>(runId);

    return row?.llm_source_snapshot_json ?? null;
  }

  setMeetingRunLlmSourceSnapshot(runId: string, snapshotJson: string): boolean {
    meetingRecordingIdSchema.parse(runId);

    const result = this.sql
      .prepare(
        "UPDATE meeting_processing_runs SET llm_source_snapshot_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running' AND stage IN ('normalize', 'summary')"
      )
      .run(snapshotJson, runId);

    return result.changes === 1;
  }

  updateMeetingRunLlmSourceSnapshot(
    runId: string,
    snapshotJson: string,
    expectedSnapshotJson: string
  ): boolean {
    meetingRecordingIdSchema.parse(runId);

    const result = this.sql
      .prepare(
        "UPDATE meeting_processing_runs SET llm_source_snapshot_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running' AND stage IN ('normalize', 'summary') AND llm_source_snapshot_json = ?"
      )
      .run(snapshotJson, runId, expectedSnapshotJson);

    return result.changes === 1;
  }

  applyMeetingGeneratedTitle(
    runId: string,
    noteId: number,
    expectedTitle: string | null,
    title: string,
    expectedSnapshotJson: string
  ): boolean {
    return this.sql.transaction(() => {
      const run = this.getMeetingProcessingRun(runId);

      if (
        !run ||
        run.status !== "running" ||
        this.getMeetingRunLlmSourceSnapshot(runId) !== expectedSnapshotJson
      )
        return false;
      const recording = this.getMeetingRecording(run.recordingId);

      if (!recording || recording.noteId !== noteId || recording.currentRunId !== runId)
        return false;
      // SAFETY: expectedSnapshotJson is this manager's own snapshot object;
      // individual fields are compared without further validation, as before.

      const snapshot = JSON.parse(expectedSnapshotJson) as {
        sourceRunId?: string;
        sourceRecordingIds?: string[];
        manualNoteRevision?: string;
        manualNotes?: string;
        meetingTitle?: string | null;
        participants?: unknown;
        speakerCorrectionRevision?: number;
        promptModel?: unknown;
      };

      const changed = this.sql
        .prepare(
          "UPDATE notes SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND title IS ?"
        )
        .run(title, noteId, expectedTitle);

      if (changed.changes !== 1) return false;

      if (
        !this.updateMeetingRunLlmSourceSnapshot(
          runId,
          JSON.stringify({ ...snapshot, meetingTitle: title }),
          expectedSnapshotJson
        )
      )
        throw new Error("Meeting title snapshot was not saved");

      return true;
    })();
  }

  updateMeetingSummaryIfCurrent(input: {
    recordingId: string;
    runId: string;
    sourceRunId: string;
    expectedSnapshotJson: string;
    expectedSpeakerCorrectionRevision: number;
    expectedTitle: string | null;
    expectedManualNotes: string;
    expectedTranscript: string | null;
    expectedProjection: string | null;
    summary: string;
  }): boolean {
    meetingRecordingIdSchema.parse(input.recordingId);
    meetingRecordingIdSchema.parse(input.runId);
    meetingRecordingIdSchema.parse(input.sourceRunId);

    const transaction = this.sql.transaction(() => {
      const current = this.sql
        .prepare(`
        SELECT r.note_id, r.current_run_id, p.kind, p.source_run_id, p.summary_path,
          p.llm_source_snapshot_json, n.title, n.content, n.transcript, n.enhanced_content
        FROM meeting_recordings r
        JOIN meeting_processing_runs p ON p.recording_id = r.id
        JOIN notes n ON n.id = r.note_id
        WHERE r.id = ? AND p.id = ? AND p.status = 'complete'
          AND NOT EXISTS (SELECT 1 FROM meeting_deletion_intents d WHERE d.note_id = r.note_id AND d.kind = 'note')
      `)
        .get<{
          note_id: number;
          current_run_id: string | null;
          kind: "initial" | "reprocess" | "summary";
          source_run_id: string | null;
          summary_path: string | null;
          llm_source_snapshot_json: string | null;
          title: string;
          content: string;
          transcript: string | null;
          enhanced_content: string | null;
        }>(input.recordingId, input.runId);

      if (
        !current ||
        current.current_run_id !== input.runId ||
        !current.summary_path ||
        (current.kind === "summary" ? current.source_run_id : input.runId) !== input.sourceRunId ||
        current.llm_source_snapshot_json !== input.expectedSnapshotJson ||
        current.title !== input.expectedTitle ||
        current.content !== input.expectedManualNotes ||
        current.transcript !== input.expectedTranscript ||
        current.enhanced_content !== input.expectedProjection
      )
        return false;

      const revision = this.sql
        .prepare(
          "SELECT COALESCE(SUM(revision), 0) AS revision FROM meeting_run_speaker_corrections WHERE run_id = ?"
        )
        .get<{ revision: number }>(input.sourceRunId);

      if ((revision?.revision ?? 0) !== input.expectedSpeakerCorrectionRevision) return false;

      this.sql
        .prepare(
          "UPDATE notes SET enhanced_content = ?, enhanced_at_content_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(
          input.summary,
          noteContentHash(`${current.content}\n${current.transcript ?? ""}`),
          current.note_id
        );

      return true;
    });

    return transaction();
  }

  setMeetingSpeakerNamingError(runId: string, errorCode: string | null): boolean {
    meetingRecordingIdSchema.parse(runId);

    const result = this.sql
      .prepare(
        "UPDATE meeting_processing_runs SET speaker_naming_error_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running' AND stage IN ('normalize', 'summary')"
      )
      .run(errorCode, runId);

    return result.changes === 1;
  }

  selectMeetingProcessingRun(
    recordingId: string,
    runId: string,
    projection: { transcript: string; summary: string | null; summaryPrompt: string | null } | null
  ): SuccessResult & { noteId?: number } {
    meetingRecordingIdSchema.parse(recordingId);
    meetingRecordingIdSchema.parse(runId);

    const transaction = this.sql.transaction(() => {
      const row = this.sql
        .prepare(
          "SELECT r.note_id FROM meeting_recordings r JOIN meeting_processing_runs p ON p.recording_id = r.id WHERE r.id = ? AND p.id = ? AND NOT EXISTS (SELECT 1 FROM meeting_deletion_intents d WHERE d.note_id = r.note_id AND d.kind = 'note')"
        )
        .get<{ note_id: number }>(recordingId, runId);

      if (!row) return { success: false as const };

      if (projection) {
        const note = this.sql
          .prepare("SELECT content FROM notes WHERE id = ?")
          .get<{ content: string }>(row.note_id);

        if (!note) throw new Error("Meeting note not found");
        this.sql
          .prepare(
            "UPDATE notes SET transcript = ?, enhanced_content = ?, enhancement_prompt = ?, enhanced_at_content_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
          )
          .run(
            projection.transcript,
            projection.summary,
            projection.summaryPrompt,
            projection.summary === null
              ? null
              : noteContentHash(`${note.content}\n${projection.transcript}`),
            row.note_id
          );
      }

      this.sql
        .prepare(
          "UPDATE meeting_recordings SET current_run_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(runId, recordingId);

      return { success: true as const, noteId: row.note_id };
    });

    return transaction();
  }

  isMeetingNoteDeletionPending(noteId: number): boolean {
    return (
      this.sql
        .prepare("SELECT 1 FROM meeting_deletion_intents WHERE note_id = ? AND kind = 'note'")
        .get(noteId) != null
    );
  }

  beginMeetingAudioDeletion(recordingId: string): MeetingDeletionIntentDto | null {
    meetingRecordingIdSchema.parse(recordingId);

    const transaction = this.sql.transaction(() => {
      const recording = this.getMeetingRecording(recordingId);

      if (
        !recording ||
        recording.audioState === "deleted" ||
        this.isMeetingNoteDeletionPending(recording.noteId)
      ) {
        return null;
      }

      if (recording.captureState === "recording" || recording.captureState === "finalizing") {
        throw new Error("Active meeting recording must be stopped before deletion");
      }

      this.sql
        .prepare(
          "UPDATE meeting_recordings SET audio_state = 'deleting', audio_error_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(recordingId);
      this.sql
        .prepare(
          "UPDATE meeting_processing_runs SET status = 'cancelled', error_code = 'audio-deletion-requested', retry_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE (recording_id = ? OR source_recording_ids_json LIKE ?) AND status IN ('pending', 'running') AND stage IN ('prepare', 'asr') AND raw_response_path IS NULL"
        )
        .run(recordingId, `%"${recordingId}"%`);

      const existing = this.sql
        .prepare("SELECT * FROM meeting_deletion_intents WHERE recording_id = ? AND kind = 'audio'")
        .get<MeetingDeletionIntentDbRow>(recordingId);

      const id = existing?.id ?? randomUUID();

      if (existing) {
        this.sql
          .prepare(
            "UPDATE meeting_deletion_intents SET status = 'pending', error_code = NULL WHERE id = ?"
          )
          .run(id);
      } else {
        this.sql
          .prepare(
            "INSERT INTO meeting_deletion_intents (id, kind, note_id, recording_id) VALUES (?, 'audio', ?, ?)"
          )
          .run(id, recording.noteId, recordingId);
      }

      const intent = this.sql
        .prepare("SELECT * FROM meeting_deletion_intents WHERE id = ?")
        .get<MeetingDeletionIntentDbRow>(id);

      if (!intent) throw new Error("Deletion intent vanished inside its own transaction");

      return toMeetingDeletionIntentDto(intent);
    });

    return transaction();
  }

  beginMeetingNoteDeletion(noteId: number): MeetingDeletionIntentDto | null {
    if (!Number.isSafeInteger(noteId) || noteId < 1 || !this.getNote(noteId)) return null;

    const transaction = this.sql.transaction(() => {
      const active = this.sql
        .prepare(
          "SELECT 1 FROM meeting_recordings WHERE note_id = ? AND capture_state IN ('recording', 'finalizing') LIMIT 1"
        )
        .get(noteId);

      if (active) throw new Error("Active meeting recording must be stopped before deletion");

      const existing = this.sql
        .prepare("SELECT * FROM meeting_deletion_intents WHERE note_id = ? AND kind = 'note'")
        .get<MeetingDeletionIntentDbRow>(noteId);

      const id = existing?.id ?? randomUUID();

      if (existing) {
        this.sql
          .prepare(
            "UPDATE meeting_deletion_intents SET status = 'pending', error_code = NULL WHERE id = ?"
          )
          .run(id);
      } else {
        this.sql
          .prepare("INSERT INTO meeting_deletion_intents (id, kind, note_id) VALUES (?, 'note', ?)")
          .run(id, noteId);
      }

      this.sql
        .prepare(
          "UPDATE meeting_recordings SET audio_state = 'deleting', audio_error_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE note_id = ?"
        )
        .run(noteId);

      const intent = this.sql
        .prepare("SELECT * FROM meeting_deletion_intents WHERE id = ?")
        .get<MeetingDeletionIntentDbRow>(id);

      if (!intent) throw new Error("Deletion intent vanished inside its own transaction");

      return toMeetingDeletionIntentDto(intent);
    });

    return transaction();
  }

  listMeetingDeletionIntents(): MeetingDeletionIntentDto[] {
    return this.sql
      .prepare("SELECT * FROM meeting_deletion_intents ORDER BY requested_at, id")
      .all<MeetingDeletionIntentDbRow>()
      .map(toMeetingDeletionIntentDto);
  }

  getMeetingNoteStorageIds(noteId: number): StorageIdsResult {
    return {
      recordingIds: this.sql
        .prepare("SELECT id FROM meeting_recordings WHERE note_id = ? ORDER BY id")
        .all<{ id: string }>(noteId)
        .map((row) => row.id),
      runIds: this.sql
        .prepare(
          "SELECT id FROM meeting_processing_runs WHERE recording_id IN (SELECT id FROM meeting_recordings WHERE note_id = ?) ORDER BY id"
        )
        .all<{ id: string }>(noteId)
        .map((row) => row.id),
    };
  }

  failMeetingDeletion(id: string, errorCode: string): SuccessResult {
    meetingRecordingIdSchema.parse(id);
    meetingProcessingConfigErrorSchema.parse({ code: errorCode });

    const transaction = this.sql.transaction(() => {
      const intent = this.sql
        .prepare("SELECT * FROM meeting_deletion_intents WHERE id = ?")
        .get<MeetingDeletionIntentDbRow>(id);

      if (!intent) return false;
      this.sql
        .prepare(
          "UPDATE meeting_deletion_intents SET status = 'failed', error_code = ? WHERE id = ?"
        )
        .run(errorCode, id);

      if (intent.kind === "audio" && intent.recording_id) {
        this.sql
          .prepare(
            "UPDATE meeting_recordings SET audio_error_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
          )
          .run(errorCode, intent.recording_id);
      }

      return true;
    });

    return { success: transaction() };
  }

  completeMeetingAudioDeletion(id: string): SuccessResult {
    meetingRecordingIdSchema.parse(id);

    const transaction = this.sql.transaction(() => {
      const intent = this.sql
        .prepare("SELECT * FROM meeting_deletion_intents WHERE id = ? AND kind = 'audio'")
        .get<MeetingDeletionIntentDbRow>(id);

      if (!intent?.recording_id) return false;
      this.sql
        .prepare(
          "UPDATE meeting_recordings SET audio_state = 'deleted', audio_error_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(intent.recording_id);
      this.sql.prepare("DELETE FROM meeting_deletion_intents WHERE id = ?").run(id);

      return true;
    });

    return { success: transaction() };
  }

  completeMeetingNoteDeletion(id: string): SuccessResult {
    meetingRecordingIdSchema.parse(id);

    const transaction = this.sql.transaction(() => {
      const intent = this.sql
        .prepare("SELECT * FROM meeting_deletion_intents WHERE id = ? AND kind = 'note'")
        .get<MeetingDeletionIntentDbRow>(id);

      if (!intent) return false;
      this.sql.prepare("DELETE FROM meeting_recordings WHERE note_id = ?").run(intent.note_id);
      this.sql.prepare("DELETE FROM meeting_deletion_intents WHERE id = ?").run(id);

      return this.sql.prepare("DELETE FROM notes WHERE id = ?").run(intent.note_id).changes > 0;
    });

    return { success: transaction() };
  }

  getFolders(): FolderRow[] {
    return this.sql
      .prepare("SELECT * FROM folders ORDER BY sort_order, created_at")
      .all<FolderRow>();
  }

  createFolder(name: string | null | undefined): FolderMutationDbResult {
    const trimmed = String(name || "").trim();

    if (!trimmed) return { success: false, error: "Folder name is required" };

    const max = (
      this.sql
        .prepare("SELECT COALESCE(MAX(sort_order), -1) AS value FROM folders")
        .get<{ value: number }>() ?? { value: -1 }
    ).value;

    try {
      const result = this.sql
        .prepare("INSERT INTO folders (name, sort_order) VALUES (?, ?)")
        .run(trimmed, max + 1);

      return {
        success: true,
        folder: this.sql
          .prepare("SELECT * FROM folders WHERE id = ?")
          .get<FolderRow>(result.lastInsertRowid),
      };
    } catch (error) {
      if (isSqliteUniqueConstraint(error))
        return { success: false, error: "A folder with that name already exists" };
      throw error;
    }
  }

  renameFolder(id: number, name: string | null | undefined): FolderMutationDbResult {
    const trimmed = String(name || "").trim();

    if (!trimmed) return { success: false, error: "Folder name is required" };

    try {
      const result = this.sql
        .prepare("UPDATE folders SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(trimmed, id);

      return {
        success: result.changes > 0,
        folder: this.sql.prepare("SELECT * FROM folders WHERE id = ?").get<FolderRow>(id),
      };
    } catch (error) {
      if (isSqliteUniqueConstraint(error))
        return { success: false, error: "A folder with that name already exists" };
      throw error;
    }
  }

  updateFolderStyle(
    id: number,
    style: { icon?: string | null; color?: string | null } = {}
  ): FolderStyleMutationDbResult {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (style.icon !== undefined) {
      fields.push("icon = ?");
      values.push(typeof style.icon === "string" && style.icon.trim() ? style.icon.trim() : null);
    }

    if (style.color !== undefined) {
      fields.push("color = ?");
      values.push(
        typeof style.color === "string" && FOLDER_COLORS.includes(style.color) ? style.color : null
      );
    }

    if (!fields.length) return { success: false };

    const result = this.sql
      .prepare(
        `UPDATE folders SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      )
      .run(...values, id);

    return {
      success: result.changes > 0,
      folder: this.sql.prepare("SELECT * FROM folders WHERE id = ?").get<FolderRow>(id),
    };
  }

  /** The list position becomes sort_order. */
  reorderFolders(folderIds: number[]): SuccessResult {
    const update = this.sql.prepare("UPDATE folders SET sort_order = ? WHERE id = ?");

    this.sql.transaction(() => {
      folderIds.forEach((folderId, index) => update.run(index, folderId));
    })();

    return { success: true };
  }

  deleteFolder(id: number): FolderDeleteDbResult {
    // Captured per call and returned to the caller: the mirror rewrite needs
    // the affected notes, and instance state would be overwritten by a second
    // delete before the deferred callback reads it.
    const relocatedNoteIds: number[] = [];

    const result = this.sql.transaction(() => {
      relocatedNoteIds.push(
        ...this.sql
          .prepare("SELECT id FROM notes WHERE folder_id = ?")
          .all<{ id: number }>(id)
          .map((row) => row.id)
      );
      // A note whose primary folder goes away keeps living in its next folder.
      this.sql
        .prepare(`
        UPDATE notes SET folder_id = (
          SELECT MIN(nf.folder_id) FROM note_folders nf WHERE nf.note_id = notes.id AND nf.folder_id != ?
        )
        WHERE folder_id = ? AND EXISTS (
          SELECT 1 FROM note_folders nf WHERE nf.note_id = notes.id AND nf.folder_id != ?
        )
      `)
        .run(id, id, id);
      this.pruneNoteFolderLinks();

      return this.sql.prepare("DELETE FROM folders WHERE id = ?").run(id);
    })();

    return { success: result.changes > 0, relocatedNoteIds };
  }

  // Notes whose primary folder was the last deleted folder, captured before
  // the relocation ran — the note-files mirror re-writes them at their new
  // location. Only valid immediately after deleteFolder().
  get lastDeletedFolderNoteIds(): number[] {
    return this._lastDeletedFolderNoteIds;
  }

  private _lastDeletedFolderNoteIds: number[] = [];

  /** Extra folders must never repeat the primary folder. */
  private pruneNoteFolderLinks(): void {
    this.sql
      .prepare(`
      DELETE FROM note_folders WHERE EXISTS (
        SELECT 1 FROM notes n JOIN folders f ON f.id = note_folders.folder_id
        WHERE n.id = note_folders.note_id AND n.folder_id = note_folders.folder_id
      )
    `)
      .run();
  }

  getFolderNoteCounts(): FolderNoteCountRow[] {
    return this.sql
      .prepare(`
      SELECT folder_id, COUNT(*) AS count FROM (
        SELECT folder_id FROM notes
        UNION ALL
        SELECT nf.folder_id FROM note_folders nf JOIN notes n ON n.id = nf.note_id
      ) GROUP BY folder_id
    `)
      .all<FolderNoteCountRow>();
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
  ): TranscriptionSaveResult {
    const {
      status = "completed",
      errorMessage = null,
      errorCode = null,
      routeKind = null,
    } = options;

    const timestamp = toDbTimestamp(options.occurredAt) || null;

    const result = this.sql
      .prepare(`
      INSERT INTO transcriptions (text, raw_text, status, error_message, error_code, route_kind, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
    `)
      .run(text, rawText, status, errorMessage, errorCode, routeKind, timestamp);

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
      .all<TranscriptionRow>(limit);
  }

  clearTranscriptions(): ClearedResult {
    const result = this.sql.prepare("DELETE FROM transcriptions").run();

    return { success: true, cleared: result.changes } satisfies {
      success: boolean;
      cleared: number;
    };
  }

  deleteTranscriptionsExpiredBefore(retentionDays: number): IdsResult {
    // datetime() always returns a value; the row is present for a scalar query.
    const cutoff =
      this.sql
        .prepare("SELECT datetime('now', ?) AS cutoff")
        .get<{ cutoff: string }>(`-${retentionDays} days`)?.cutoff ?? "";

    const ids = this.sql
      .prepare("SELECT id FROM transcriptions WHERE created_at < ?")
      .all<{ id: number }>(cutoff)
      .map((row) => row.id);

    this.sql.prepare("DELETE FROM transcriptions WHERE created_at < ?").run(cutoff);

    return { ids };
  }

  deleteTranscription(id: number): DeletedIdResult {
    const result = this.sql.prepare("DELETE FROM transcriptions WHERE id = ?").run(id);

    return { success: result.changes > 0, id } satisfies { success: boolean; id: number };
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
  ): SuccessResult {
    this.sql
      .prepare(
        "UPDATE transcriptions SET has_audio = ?, audio_duration_ms = ?, provider = ?, model = ? WHERE id = ?"
      )
      .run(hasAudio ? 1 : 0, audioDurationMs, provider, model, id);

    return { success: true };
  }

  updateTranscriptionText(id: number, text: string, rawText: string | null): SuccessResult {
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
  ): SuccessResult {
    this.sql
      .prepare(
        "UPDATE transcriptions SET status = ?, error_message = ?, error_code = ? WHERE id = ?"
      )
      .run(status, errorMessage, errorCode, id);

    return { success: true };
  }

  getTranscriptionById(id: number | bigint): TranscriptionRow | null {
    return (
      this.sql.prepare("SELECT * FROM transcriptions WHERE id = ?").get<TranscriptionRow>(id) ||
      null
    );
  }

  getAudioFlaggedIds(): Array<{ id: number }> {
    return this.sql
      .prepare("SELECT id FROM transcriptions WHERE has_audio = 1")
      .all<{ id: number }>();
  }

  // IDs arrive both numeric (DB rows) and string-typed (audio filenames);
  // SQLite INTEGER affinity coerces either form, as it always has.
  clearAudioFlags(ids: Array<number | string>): SuccessResult {
    if (!ids?.length) return { success: true };
    const update = this.sql.prepare("UPDATE transcriptions SET has_audio = 0 WHERE id = ?");
    this.sql.transaction(() => ids.forEach((id) => update.run(id)))();

    return { success: true };
  }

  getDictionary(): string[] {
    return this.sql
      .prepare("SELECT word FROM custom_dictionary ORDER BY id")
      .all<{ word: string }>()
      .map((row) => row.word);
  }

  setDictionary(words: unknown): SuccessResult {
    const incoming = normalizeWords(words);

    const current = this.sql
      .prepare("SELECT id, word FROM custom_dictionary")
      .all<{ id: number; word: string }>();

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
  }: DictionaryApplyDelta = {}): DictionaryChangeDbResult {
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

  hardDeleteDictionaryEntry(id: number): SuccessResult {
    return {
      success: this.sql.prepare("DELETE FROM custom_dictionary WHERE id = ?").run(id).changes > 0,
    };
  }

  getSnippets(): Array<{ trigger: string; replacement: string }> {
    return this.sql
      .prepare("SELECT trigger, replacement FROM snippets ORDER BY id")
      .all<{ trigger: string; replacement: string }>();
  }

  setSnippets(snippets: unknown): SuccessResult {
    const incoming = new Map<string, { trigger: string; replacement: string }>();

    // SAFETY: the IPC boundary passes raw snippet objects; each field is
    // validated per-item inside the loop.
    const items = (Array.isArray(snippets) ? snippets : []) as Array<Record<string, unknown>>;

    for (const item of items) {
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

  hardDeleteSnippet(id: number): SuccessResult {
    return { success: this.sql.prepare("DELETE FROM snippets WHERE id = ?").run(id).changes > 0 };
  }

  saveNote(
    title: string,
    content: string,
    noteType = "personal",
    sourceFile: string | null = null,
    audioDuration: number | null = null,
    folderId: number | null = null
  ): NoteSaveDbResult {
    const result = this.sql
      .prepare(
        "INSERT INTO notes (title, content, note_type, source_file, audio_duration_seconds, folder_id) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(title, content, noteType, sourceFile, audioDuration, folderId);

    return { success: true, note: this.getNote(result.lastInsertRowid) } satisfies {
      success: boolean;
      note?: NoteRow | null;
    };
  }

  importNotes(
    rows: unknown,
    { noteType = "meeting", folderName = "Imported" } = {}
  ): ImportNotesResult {
    let folderId: number | null =
      this.sql.prepare("SELECT id FROM folders WHERE name = ?").get<{ id: number }>(folderName)
        ?.id ?? null;

    if (!folderId) folderId = this.createFolder(folderName).folder?.id ?? null;
    let imported = 0;
    const noteIds: number[] = [];
    const errors: Array<{ error: string }> = [];

    const insert = this.sql.prepare(
      "INSERT INTO notes (title, content, note_type, source_file, folder_id, transcript, participants, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))"
    );

    this.sql.transaction(() => {
      // SAFETY: import rows are raw CLI payloads; field reads are tolerated
      // per-row and failures land in the errors list.
      const importRows = (Array.isArray(rows) ? rows : []) as Array<Record<string, unknown>>;

      for (const row of importRows) {
        try {
          const result = insert.run(
            row.title,
            row.content,
            noteType,
            row.sourceFile,
            folderId,
            row.transcript,
            row.participants,
            row.createdAt,
            row.createdAt
          );

          imported += 1;
          noteIds.push(Number(result.lastInsertRowid));
        } catch (error) {
          errors.push({
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return { success: true, imported, skipped: 0, folderId, noteIds, errors };
  }

  getNote(id: number | bigint): NoteRow | null {
    const raw = this.sql
      .prepare(`SELECT ${noteColumns("notes")} FROM notes WHERE id = ?`)
      .get<RawNoteRow>(id);

    return raw ? hydrateNote(raw) : null;
  }

  getNotes(noteType: string | null = null, limit = 100, folderId: number | null = null): NoteRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (noteType) {
      conditions.push("note_type = ?");
      params.push(noteType);
    }

    if (folderId != null) {
      conditions.push(
        "(folder_id = ? OR id IN (SELECT note_id FROM note_folders WHERE folder_id = ?))"
      );
      params.push(folderId, folderId);
    }

    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";

    return this.sql
      .prepare(`SELECT ${noteColumns("notes")} FROM notes${where} ORDER BY updated_at DESC LIMIT ?`)
      .all<RawNoteRow>(...params, limit)
      .map(hydrateNote);
  }

  listAllNotes(): NoteRow[] {
    return this.sql
      .prepare(`SELECT ${noteColumns("notes")} FROM notes ORDER BY created_at DESC, id DESC`)
      .all<RawNoteRow>()
      .map(hydrateNote);
  }

  getContactNames(email: string): {
    display_name: string | null;
    people_name: string | null;
    learned_name: string | null;
  } | null {
    return (
      this.sql
        .prepare("SELECT display_name, people_name, learned_name FROM contacts WHERE email = ?")
        .get<{
          display_name: string | null;
          people_name: string | null;
          learned_name: string | null;
        }>(email.toLowerCase()) ?? null
    );
  }

  getRootNotes(limit = 50): NoteRow[] {
    return this.sql
      .prepare(
        `SELECT ${noteColumns("notes")} FROM notes WHERE folder_id IS NULL ORDER BY updated_at DESC LIMIT ?`
      )
      .all<RawNoteRow>(limit)
      .map(hydrateNote);
  }

  getNoteIdsInFolder(folderId: number): number[] {
    return this.sql
      .prepare(
        "SELECT id FROM notes WHERE (folder_id = ? OR id IN (SELECT note_id FROM note_folders WHERE folder_id = ?))"
      )
      .all<{ id: number }>(folderId, folderId)
      .map((row) => row.id);
  }

  getNoteIdsInScope(
    folderId: number | null = null,
    candidateIds: number[] | null = null
  ): number[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (folderId != null) {
      conditions.push(
        "(folder_id = ? OR id IN (SELECT note_id FROM note_folders WHERE folder_id = ?))"
      );
      params.push(folderId, folderId);
    }

    if (candidateIds) {
      if (!candidateIds.length) return [];
      conditions.push(`id IN (${candidateIds.map(() => "?").join(",")})`);
      params.push(...candidateIds);
    }

    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";

    return this.sql
      .prepare(`SELECT id FROM notes${where}`)
      .all<{ id: number }>(...params)
      .map((row) => row.id);
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
      transcript: string | null;
      calendar_event_id: string | null;
      participants: string | null;
      diarization_enabled: number | null;
      expected_speaker_count: number | null;
      source_file: string | null;
      audio_duration_seconds: number | null;
      note_type: string;
      icon: string | null;
    }>
  ): NoteUpdateDbResult {
    const current = this.getNote(id);

    if (!current) return { success: false, error: "Note not found" };
    let extraFolderIds: number[] | null = null;

    if (updates.folder_ids !== undefined) {
      if (updates.folder_id !== undefined) {
        return { success: false, error: "Pass folder_id or folder_ids, not both" } satisfies {
          success: boolean;
          error?: string;
        };
      }

      const ids = [...new Set(updates.folder_ids)];

      const known = ids.length
        ? (this.sql
            .prepare(
              `SELECT COUNT(*) AS count FROM folders WHERE id IN (${ids.map(() => "?").join(",")})`
            )
            .get<{ count: number }>(...ids)?.count ?? 0)
        : 0;

      if (known !== ids.length) return { success: false, error: "Folder not found" };

      const primary =
        ids.length === 0
          ? null
          : current.folder_id != null && ids.includes(current.folder_id)
            ? current.folder_id
            : ids[0];

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
      "transcript",
      "calendar_event_id",
      "participants",
      "diarization_enabled",
      "expected_speaker_count",
      "source_file",
      "audio_duration_seconds",
      "note_type",
      "icon",
    ] as const;

    const fields: string[] = [];
    const values: unknown[] = [];

    for (const key of allowed)
      if (updates[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(updates[key]);
      }

    if (
      updates.folder_id != null &&
      !this.sql.prepare("SELECT 1 FROM folders WHERE id = ?").get(updates.folder_id)
    )
      return { success: false, error: "Folder not found" };

    if (!fields.length) return { success: false };
    values.push(id);

    const result = this.sql.transaction(() => {
      const updated = this.sql
        .prepare(
          `UPDATE notes SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        )
        .run(...values);

      if (extraFolderIds) {
        this.sql.prepare("DELETE FROM note_folders WHERE note_id = ?").run(id);

        const link = this.sql.prepare(
          "INSERT INTO note_folders (note_id, folder_id) VALUES (?, ?)"
        );

        for (const folderId of extraFolderIds) link.run(id, folderId);
      }

      if (extraFolderIds || updates.folder_id !== undefined) {
        this.pruneNoteFolderLinks();
      }

      return updated;
    })();

    return { success: result.changes > 0, note: this.getNote(id) } satisfies {
      success: boolean;
      note?: NoteRow | null;
    };
  }

  deleteNote(id: number): SuccessResult {
    if (
      this.sql.prepare("SELECT 1 FROM meeting_recordings WHERE note_id = ? LIMIT 1").get(id) !=
        null ||
      this.isMeetingNoteDeletionPending(id)
    ) {
      return { success: false };
    }

    const result = this.sql.prepare("DELETE FROM notes WHERE id = ?").run(id);

    return { success: result.changes > 0 };
  }

  getActions(): ActionRow[] {
    return this.sql.prepare("SELECT * FROM actions ORDER BY sort_order, id").all<ActionRow>();
  }
  getAction(id: number): ActionRow | null {
    return this.sql.prepare("SELECT * FROM actions WHERE id = ?").get<ActionRow>(id) || null;
  }
  createAction(
    name: string,
    description: string,
    prompt: string,
    icon = "wand-sparkles"
  ): ActionCreateResult & { action: ActionRow | null } {
    const result = this.sql
      .prepare("INSERT INTO actions (name, description, prompt, icon) VALUES (?, ?, ?, ?)")
      .run(name, description, prompt, icon);

    return { success: true, action: this.getAction(Number(result.lastInsertRowid)) };
  }
  updateAction(
    id: number,
    updates: Partial<{
      name: string;
      description: string;
      prompt: string;
      icon: string;
      sort_order: number;
    }>
  ): ActionMutationDbResult {
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
      .prepare(
        `UPDATE actions SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      )
      .run(...values);

    return { success: result.changes > 0, action: this.getAction(id) } satisfies {
      success: boolean;
      action?: ActionRow | null;
    };
  }
  deleteAction(id: number): SuccessResult {
    return {
      success:
        this.sql.prepare("DELETE FROM actions WHERE id = ? AND is_builtin = 0").run(id).changes > 0,
    };
  }

  createAgentConversation(
    title = "Untitled",
    noteId: number | null = null,
    folderId: number | null = null
  ): AgentConversationRow | null {
    const result = this.sql
      .prepare("INSERT INTO agent_conversations (title, note_id, folder_id) VALUES (?, ?, ?)")
      .run(title, noteId, folderId);

    return this.getAgentConversation(result.lastInsertRowid);
  }
  getAgentConversation(
    id: number | bigint
  ): (AgentConversationRow & { messages: AgentMessageRow[] }) | null {
    const conversation = this.sql
      .prepare("SELECT * FROM agent_conversations WHERE id = ?")
      .get<AgentConversationRow>(id);

    return conversation ? { ...conversation, messages: this.getAgentMessages(Number(id)) } : null;
  }
  getAgentBbThread(conversationId: number): { thread_id: string; provider: string } | null {
    return (
      this.sql
        .prepare("SELECT thread_id, provider FROM agent_bb_threads WHERE conversation_id = ?")
        .get<{ thread_id: string; provider: string }>(conversationId) ?? null
    );
  }
  saveAgentBbThread(conversationId: number, threadId: string, provider: string): void {
    this.sql
      .prepare(
        "INSERT INTO agent_bb_threads (conversation_id, thread_id, provider) VALUES (?, ?, ?)"
      )
      .run(conversationId, threadId, provider);
  }
  getAgentConversations(limit = 50): AgentConversationRow[] {
    return this.sql
      .prepare(
        "SELECT * FROM agent_conversations WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT ?"
      )
      .all<AgentConversationRow>(limit);
  }
  getConversationsForNote(noteId: number, limit = 20): AgentConversationRow[] {
    return this.sql
      .prepare(
        "SELECT * FROM agent_conversations WHERE note_id = ? ORDER BY updated_at DESC LIMIT ?"
      )
      .all<AgentConversationRow>(noteId, limit);
  }
  getConversationsForContainer(
    folderId: number | null = null,
    limit = 20
  ): ContainerConversationRow[] {
    const fields =
      "c.*, (SELECT COUNT(*) FROM agent_messages m WHERE m.conversation_id = c.id) AS message_count";

    const sql =
      folderId == null
        ? `SELECT ${fields} FROM agent_conversations c WHERE c.note_id IS NULL AND c.folder_id IS NULL ORDER BY c.updated_at DESC LIMIT ?`
        : `SELECT ${fields} FROM agent_conversations c WHERE c.note_id IS NULL AND c.folder_id = ? ORDER BY c.updated_at DESC LIMIT ?`;

    return folderId == null
      ? this.sql.prepare(sql).all<ContainerConversationRow>(limit)
      : this.sql.prepare(sql).all<ContainerConversationRow>(folderId, limit);
  }
  addAgentMessage(
    conversationId: number,
    role: AgentMessageRow["role"],
    content: string,
    metadata:
      | {
          toolCalls?: Array<{
            id?: string;
            name?: string;
            arguments?: unknown;
            status?: string;
          }>;
        }
      | null
      | undefined
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
      this.sql
        .prepare("SELECT * FROM agent_messages WHERE id = ?")
        .get<AgentMessageRow>(result.lastInsertRowid) ?? null
    );
  }
  getAgentMessages(conversationId: number): AgentMessageRow[] {
    return this.sql
      .prepare("SELECT * FROM agent_messages WHERE conversation_id = ? ORDER BY created_at")
      .all<AgentMessageRow>(conversationId);
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
      .all<ConversationPreviewRow>(limit, offset);
  }
  searchAgentConversations(query: string, limit = 20): AgentConversationRow[] {
    const pattern = `%${query || ""}%`;

    return this.sql
      .prepare(
        "SELECT * FROM agent_conversations WHERE title LIKE ? ORDER BY updated_at DESC LIMIT ?"
      )
      .all<AgentConversationRow>(pattern, limit);
  }
  updateAgentConversationTitle(id: number, title: string): SuccessResult {
    const result = this.sql
      .prepare(
        "UPDATE agent_conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      )
      .run(title, id);

    return { success: result.changes > 0 };
  }
  archiveAgentConversation(id: number): SuccessResult {
    const result = this.sql
      .prepare("UPDATE agent_conversations SET archived_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(id);

    return { success: result.changes > 0 };
  }
  unarchiveAgentConversation(id: number): SuccessResult {
    const result = this.sql
      .prepare("UPDATE agent_conversations SET archived_at = NULL WHERE id = ?")
      .run(id);

    return { success: result.changes > 0 };
  }
  deleteAgentConversation(id: number): SuccessResult {
    const result = this.sql.prepare("DELETE FROM agent_conversations WHERE id = ?").run(id);

    return { success: result.changes > 0 };
  }

  private _discardPlaintextCalendarTokens(): void {
    const google = this.sql
      .prepare(
        "SELECT google_email AS email FROM google_calendar_tokens WHERE access_token NOT GLOB ? OR refresh_token NOT GLOB ?"
      )
      .all<{ email: string }>(`${CALENDAR_TOKEN_PREFIX}*`, `${CALENDAR_TOKEN_PREFIX}*`);

    const microsoft = this.sql
      .prepare(
        "SELECT microsoft_email AS email FROM microsoft_calendar_tokens WHERE access_token NOT GLOB ? OR refresh_token NOT GLOB ?"
      )
      .all<{ email: string }>(`${CALENDAR_TOKEN_PREFIX}*`, `${CALENDAR_TOKEN_PREFIX}*`);

    if (!google.length && !microsoft.length) return;

    const discard = this.sql.transaction(() => {
      for (const account of google) this.removeGoogleAccount(account.email);

      for (const account of microsoft) this.removeMicrosoftAccount(account.email);
    });

    discard();

    const checkpoint = this.sql.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get<{ busy?: number }>();

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
      debugLogger.warn(
        "Unreadable Google Calendar credentials removed; reconnect required",
        {},
        "database"
      );

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
      debugLogger.warn(
        "Unreadable Microsoft Calendar credentials removed; reconnect required",
        {},
        "database"
      );

      return null;
    }
  }

  saveGoogleTokens(tokens: {
    google_email: string;
    access_token: string;
    refresh_token: string;
    expires_at: number;
    scope: string;
  }): SuccessResult {
    const accessToken = encryptCalendarToken(tokens.access_token);
    const refreshToken = encryptCalendarToken(tokens.refresh_token);
    this.sql.transaction(() => {
      this.sql
        .prepare("DELETE FROM google_calendar_tokens WHERE google_email = ?")
        .run(tokens.google_email);
      this.sql
        .prepare(
          "INSERT INTO google_calendar_tokens (google_email, access_token, refresh_token, expires_at, scope) VALUES (?, ?, ?, ?, ?)"
        )
        .run(tokens.google_email, accessToken, refreshToken, tokens.expires_at, tokens.scope);
    })();

    return { success: true };
  }
  refreshGoogleTokens(
    accountId: number,
    tokens: Pick<GoogleTokenRow, "access_token" | "refresh_token" | "expires_at" | "scope">
  ): SuccessResult {
    const result = this.sql
      .prepare(
        "UPDATE google_calendar_tokens SET access_token = ?, refresh_token = ?, expires_at = ?, scope = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      )
      .run(
        encryptCalendarToken(tokens.access_token),
        encryptCalendarToken(tokens.refresh_token),
        tokens.expires_at,
        tokens.scope,
        accountId
      );

    return { success: result.changes === 1 };
  }
  getGoogleTokens(): GoogleTokenRow | null {
    return this.getAllGoogleTokens()[0] ?? null;
  }
  getGoogleTokensByEmail(email: string): GoogleTokenRow | null {
    const row = this.sql
      .prepare("SELECT * FROM google_calendar_tokens WHERE google_email = ?")
      .get<GoogleTokenRow>(email);

    return this._decodeGoogleTokenRow(row);
  }
  getAllGoogleTokens(): GoogleTokenRow[] {
    const rows = this.sql
      .prepare("SELECT * FROM google_calendar_tokens ORDER BY created_at")
      .all<GoogleTokenRow>();

    return rows.flatMap((row) => {
      const decoded = this._decodeGoogleTokenRow(row);

      return decoded ? [decoded] : [];
    });
  }
  getGoogleAccounts(): CalendarAccountRow[] {
    return this.getAllGoogleTokens().map((tokens) => ({ email: tokens.google_email }));
  }
  deleteGoogleTokens(): SuccessResult {
    this.sql.prepare("DELETE FROM google_calendar_tokens").run();

    return { success: true };
  }
  removeGoogleAccount(email: string): SuccessResult {
    this.sql.prepare("DELETE FROM google_calendar_tokens WHERE google_email = ?").run(email);
    this.sql.prepare("DELETE FROM google_calendars WHERE account_email = ?").run(email);

    return { success: true };
  }
  saveGoogleCalendars(calendars: GoogleCalendarInput[], accountEmail: string): SuccessResult {
    const stmt = this.sql.prepare(
      "INSERT INTO google_calendars (id, summary, description, background_color, account_email, is_primary) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id, account_email) DO UPDATE SET summary = excluded.summary, description = excluded.description, background_color = excluded.background_color, is_primary = excluded.is_primary"
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
    return accountEmail
      ? this.sql
          .prepare("SELECT * FROM google_calendars WHERE account_email = ?")
          .all<GoogleCalendarRow>(accountEmail)
      : this.sql
          .prepare(`SELECT * FROM google_calendars WHERE rowid IN (
          SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (
            PARTITION BY id ORDER BY is_selected DESC, is_primary DESC, account_email
          ) AS rank FROM google_calendars WHERE account_email != '') WHERE rank = 1
      )`)
          .all<GoogleCalendarRow>();
  }
  getSelectedCalendars(accountEmail: string | null = null): GoogleCalendarRow[] {
    return accountEmail
      ? this.sql
          .prepare(
            "SELECT * FROM google_calendars WHERE is_selected = 1 AND account_email = ? AND account_email IN (SELECT google_email FROM google_calendar_tokens)"
          )
          .all<GoogleCalendarRow>(accountEmail)
      : this.sql
          .prepare(`SELECT * FROM google_calendars WHERE rowid IN (
          SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (
            PARTITION BY id ORDER BY is_primary DESC, account_email
          ) AS rank FROM google_calendars WHERE is_selected = 1
            AND account_email IN (SELECT google_email FROM google_calendar_tokens)) WHERE rank = 1
      )`)
          .all<GoogleCalendarRow>();
  }
  applyPrimaryOnlyToSelection(primaryOnly: boolean): SuccessResult {
    this.sql
      .prepare(
        "UPDATE google_calendars SET is_selected = CASE WHEN ? = 1 THEN is_primary ELSE 1 END"
      )
      .run(primaryOnly ? 1 : 0);

    return { success: true };
  }
  updateCalendarSelection(id: string, selected: boolean): SuccessResult {
    this.sql
      .prepare("UPDATE google_calendars SET is_selected = ? WHERE id = ?")
      .run(selected ? 1 : 0, id);

    return { success: true };
  }

  saveMicrosoftTokens(tokens: {
    microsoft_email: string;
    access_token: string;
    refresh_token: string;
    expires_at: number;
    scope: string;
  }): SuccessResult {
    const accessToken = encryptCalendarToken(tokens.access_token);
    const refreshToken = encryptCalendarToken(tokens.refresh_token);
    this.sql.transaction(() => {
      this.sql
        .prepare("DELETE FROM microsoft_calendar_tokens WHERE microsoft_email = ?")
        .run(tokens.microsoft_email);
      this.sql
        .prepare(
          "INSERT INTO microsoft_calendar_tokens (microsoft_email, access_token, refresh_token, expires_at, scope) VALUES (?, ?, ?, ?, ?)"
        )
        .run(tokens.microsoft_email, accessToken, refreshToken, tokens.expires_at, tokens.scope);
    })();

    return { success: true };
  }
  refreshMicrosoftTokens(
    accountId: number,
    tokens: Pick<MicrosoftTokenRow, "access_token" | "refresh_token" | "expires_at" | "scope">
  ): SuccessResult {
    const result = this.sql
      .prepare(
        "UPDATE microsoft_calendar_tokens SET access_token = ?, refresh_token = ?, expires_at = ?, scope = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      )
      .run(
        encryptCalendarToken(tokens.access_token),
        encryptCalendarToken(tokens.refresh_token),
        tokens.expires_at,
        tokens.scope,
        accountId
      );

    return { success: result.changes === 1 };
  }
  getMicrosoftTokensByEmail(email: string): MicrosoftTokenRow | null {
    const row = this.sql
      .prepare("SELECT * FROM microsoft_calendar_tokens WHERE microsoft_email = ?")
      .get<MicrosoftTokenRow>(email);

    return this._decodeMicrosoftTokenRow(row);
  }
  getMicrosoftAccounts(): CalendarAccountRow[] {
    const rows = this.sql
      .prepare("SELECT * FROM microsoft_calendar_tokens ORDER BY created_at")
      .all<MicrosoftTokenRow>();

    return rows.flatMap((row) => {
      const decoded = this._decodeMicrosoftTokenRow(row);

      return decoded ? [{ email: decoded.microsoft_email }] : [];
    });
  }
  removeMicrosoftAccount(email: string): SuccessResult {
    this.sql.prepare("DELETE FROM microsoft_calendar_tokens WHERE microsoft_email = ?").run(email);
    this.sql.prepare("DELETE FROM microsoft_calendars WHERE account_email = ?").run(email);

    return { success: true };
  }
  saveMicrosoftCalendars(calendars: MicrosoftCalendarInput[], accountEmail: string): SuccessResult {
    const stmt = this.sql.prepare(
      "INSERT INTO microsoft_calendars (id, summary, background_color, account_email, is_primary) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, background_color = excluded.background_color, account_email = excluded.account_email, is_primary = excluded.is_primary"
    );

    calendars.forEach((cal) =>
      stmt.run(
        cal.id,
        cal.summary,
        cal.background_color || null,
        accountEmail,
        cal.is_primary ? 1 : 0
      )
    );

    return { success: true };
  }
  applyMicrosoftPrimaryOnlyToSelection(primaryOnly: boolean): SuccessResult {
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
      .all<MicrosoftCalendarRow>();
  }

  saveAppleCalendars(calendars: AppleCalendarInput[]): SuccessResult {
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
    return this.sql.prepare("SELECT * FROM apple_calendars").all<AppleCalendarRow>();
  }
  upsertCalendarEvents(events: CalendarEventInput[]): SuccessResult {
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
    return this.sql
      .prepare(
        dedupedEventsQuery(
          // Live queries (tray, reminders) see only events from calendars that
          // still exist and are selected: a disconnected account's rows lose
          // their calendar entries and must not surface anymore (#164).
          `datetime(start_time) <= datetime('now') AND datetime(end_time) > datetime('now') AND is_all_day = 0 AND status IN ('confirmed', 'tentative') AND ${selectedCalendarFilter()}`
        )
      )
      .all<CalendarEventRow & { has_synced: number }>()
      .map(stripDedupeColumn);
  }
  getUpcomingEvents(windowMinutes = 1440): CalendarEventRow[] {
    const rows = this.sql
      .prepare(
        dedupedEventsQuery(
          // Same live-selection rule as getActiveEvents: orphaned events of a
          // disconnected account never reach tray or reminders (#164).
          "((datetime(start_time) > datetime('now') AND datetime(start_time) <= datetime('now', '+' || ? || ' minutes')) OR (datetime(start_time) <= datetime('now') AND datetime(end_time) > datetime('now'))) AND is_all_day = 0 AND status IN ('confirmed', 'tentative') AND " +
            selectedCalendarFilter()
        )
      )
      .all<CalendarEventRow & { has_synced: number }>(windowMinutes);

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

    const events = this.sql
      .prepare(
        dedupedEventsQuery(
          `provider IN (${placeholders}) AND status IN ('confirmed', 'tentative') AND ${selectedCalendarFilter()}`
        )
      )
      .all<CalendarEventRow & { has_synced: number }>(...selected)
      .map(stripDedupeColumn);

    return events.filter((event) => {
      const eventStart = parseEventTime(event.start_time, event.is_all_day === 1);
      const eventEnd = parseEventTime(event.end_time, event.is_all_day === 1);

      return eventStart !== null && eventEnd !== null && eventStart < to && eventEnd > from;
    });
  }
  getCalendarEventById(id: string): CalendarEventRow | null {
    return (
      this.sql.prepare("SELECT * FROM calendar_events WHERE id = ?").get<CalendarEventRow>(id) ||
      null
    );
  }
  getNoteByCalendarEventId(eventId: string, excludeNoteId: number | null = null): NoteRow | null {
    const raw =
      excludeNoteId == null
        ? this.sql
            .prepare(
              `SELECT ${noteColumns("notes")} FROM notes WHERE calendar_event_id = ? LIMIT 1`
            )
            .get<RawNoteRow>(eventId)
        : this.sql
            .prepare(
              `SELECT ${noteColumns("notes")} FROM notes WHERE calendar_event_id = ? AND id != ? LIMIT 1`
            )
            .get<RawNoteRow>(eventId, excludeNoteId);

    return raw ? hydrateNote(raw) : null;
  }
  updateCalendarSyncToken(
    id: string,
    token: string,
    expiresAt: number,
    accountEmail: string
  ): SuccessResult {
    this.sql
      .prepare(
        "UPDATE google_calendars SET sync_token = ?, sync_token_expires_at = ? WHERE id = ? AND account_email = ?"
      )
      .run(token, expiresAt, id, accountEmail);

    return { success: true };
  }
  updateMicrosoftCalendarSyncToken(id: string, token: string, expiresAt: number): SuccessResult {
    this.sql
      .prepare(
        "UPDATE microsoft_calendars SET sync_token = ?, sync_token_expires_at = ? WHERE id = ?"
      )
      .run(token, expiresAt, id);

    return { success: true };
  }
  removeCalendarEvents(ids: string[]): SuccessResult {
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
  ): SuccessResult {
    const filter = freshIds?.length ? `AND id NOT IN (${freshIds.map(() => "?").join(",")})` : "";
    this.sql
      .prepare(
        `DELETE FROM calendar_events WHERE provider = ? AND calendar_id = ? ${filter} AND id NOT IN (SELECT calendar_event_id FROM notes WHERE calendar_event_id IS NOT NULL)`
      )
      .run(provider, calendarId, ...(freshIds || []));

    return { success: true };
  }
  removeEventsFromDeselectedCalendars(provider: string): SuccessResult {
    const table = calendarsTableFor(provider);

    if (!table) throw new Error(`Unknown calendar provider: ${provider}`);
    this.sql
      .prepare(
        `DELETE FROM calendar_events WHERE provider = ? AND calendar_id NOT IN (SELECT id FROM ${table} WHERE is_selected = 1)`
      )
      .run(provider);

    return { success: true };
  }
  replaceAppleCalendarEvents(events: CalendarEventInput[]): SuccessResult {
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
  clearGoogleCalendarData(): SuccessResult {
    this.sql.prepare("DELETE FROM calendar_events WHERE provider = 'google'").run();
    this.sql.prepare("DELETE FROM google_calendars").run();
    this.sql.prepare("DELETE FROM google_calendar_tokens").run();

    return { success: true };
  }
  clearMicrosoftCalendarData(): SuccessResult {
    this.sql.prepare("DELETE FROM calendar_events WHERE provider = 'microsoft'").run();
    this.sql.prepare("DELETE FROM microsoft_calendars").run();
    this.sql.prepare("DELETE FROM microsoft_calendar_tokens").run();

    return { success: true };
  }
  clearAppleCalendarData(): SuccessResult {
    this.sql.prepare("DELETE FROM calendar_events WHERE provider = 'apple'").run();
    this.sql.prepare("DELETE FROM apple_calendars").run();

    return { success: true };
  }

  searchNotes(
    query: unknown,
    limit = 50,
    folderId: number | null = null,
    rootOnly = false
  ): NoteRow[] {
    const ftsQuery = buildNoteSearchQuery(query);

    if (!ftsQuery) return [];
    const conditions = ["notes_fts MATCH ?"];
    const params: unknown[] = [ftsQuery];

    if (folderId != null) {
      conditions.push(
        "(n.folder_id = ? OR n.id IN (SELECT note_id FROM note_folders WHERE folder_id = ?))"
      );
      params.push(folderId, folderId);
    } else if (rootOnly) {
      conditions.push("n.folder_id IS NULL");
    }

    params.push(limit);

    return this.sql
      .prepare(
        `SELECT ${noteColumns("n")} FROM notes n JOIN notes_fts ON notes_fts.rowid = n.id WHERE ${conditions.join(" AND ")} ORDER BY notes_fts.rank LIMIT ?`
      )
      .all<RawNoteRow>(...params)
      .map(hydrateNote);
  }

  upsertContacts(contacts: Array<{ email?: string; displayName?: string | null }>): SuccessResult {
    const stmt = this.sql.prepare(
      "INSERT INTO contacts (email, display_name) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET display_name = COALESCE(excluded.display_name, contacts.display_name), updated_at = CURRENT_TIMESTAMP"
    );

    this.sql.transaction((list: Array<{ email?: string; displayName?: string | null }>) =>
      list.forEach((contact) => {
        if (contact.email)
          stmt.run(contact.email.toLowerCase().trim(), contact.displayName || null);
      })
    )(contacts);

    return { success: true };
  }
  /** Names and photos from Google People; a profile without either leaves the row as it was. */
  upsertGooglePeople(
    profiles: Array<{ email: string; displayName: string | null; photoUrl: string | null }>
  ): SuccessResult {
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
  /** The user's own name for a contact, ahead of Google and invite names; blank clears it. */
  setContactName(email: string, name: string | null): void {
    const trimmed = name?.trim() || null;

    if (trimmed) {
      this.rememberContactName(email, trimmed);

      return;
    }

    this.sql
      .prepare(
        "UPDATE contacts SET learned_name = NULL, updated_at = CURRENT_TIMESTAMP WHERE email = ?"
      )
      .run(email.trim().toLowerCase());
  }
  rememberContactName(email: string, name: string): void {
    this.sql
      .prepare(
        "INSERT INTO contacts (email, learned_name) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET learned_name = excluded.learned_name, updated_at = CURRENT_TIMESTAMP"
      )
      .run(email.trim().toLowerCase(), name.trim());
  }
  getContactProfiles(emails: string[]): ContactProfileRow[] {
    const normalized = [
      ...new Set(emails.map((email) => email.toLowerCase().trim()).filter(Boolean)),
    ];

    if (normalized.length === 0) return [];

    return this.sql
      .prepare(
        `SELECT email, COALESCE(learned_name, people_name, display_name) AS display_name, photo_url FROM contacts WHERE email IN (${normalized.map(() => "?").join(", ")})`
      )
      .all<ContactProfileRow>(...normalized);
  }
  searchContacts(query: string): ContactRow[] {
    const pattern = `%${query || ""}%`;

    return this.sql
      .prepare(
        "SELECT email, COALESCE(learned_name, people_name, display_name) AS display_name, photo_url, created_at, updated_at FROM contacts WHERE email LIKE ? OR display_name LIKE ? OR people_name LIKE ? OR learned_name LIKE ? ORDER BY COALESCE(learned_name, people_name, display_name), email LIMIT 20"
      )
      .all<ContactRow>(pattern, pattern, pattern, pattern);
  }
  upsertSpeakerProfile(
    name: string,
    email: string | null | undefined,
    embeddingBuffer: Buffer,
    profileId: number | null = null
  ): SpeakerProfileWithEmbedding | null {
    if (profileId != null) {
      this.sql
        .prepare(
          "UPDATE speaker_profiles SET display_name = ?, email = ?, embedding = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        )
        .run(name, email || null, embeddingBuffer, profileId);

      return (
        this.sql
          .prepare("SELECT * FROM speaker_profiles WHERE id = ?")
          .get<SpeakerProfileWithEmbedding>(profileId) ?? null
      );
    }

    const result = this.sql
      .prepare("INSERT INTO speaker_profiles (display_name, email, embedding) VALUES (?, ?, ?)")
      .run(name, email || null, embeddingBuffer);

    return (
      this.sql
        .prepare("SELECT * FROM speaker_profiles WHERE id = ?")
        .get<SpeakerProfileWithEmbedding>(result.lastInsertRowid) ?? null
    );
  }
  getSpeakerProfiles(includeEmbedding = false): SpeakerProfileRow[] {
    return this.sql
      .prepare(
        `SELECT ${includeEmbedding ? "*" : "id, display_name, email, sample_count, created_at, updated_at"} FROM speaker_profiles ORDER BY display_name`
      )
      .all<SpeakerProfileRow>();
  }
  attachEmailToProfile(
    profileId: number,
    email: string | null
  ): SpeakerProfileWithEmbedding | null {
    const result = this.sql
      .prepare("UPDATE speaker_profiles SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(email, profileId);

    if (result.changes === 0) return null;

    return (
      this.sql
        .prepare("SELECT * FROM speaker_profiles WHERE id = ?")
        .get<SpeakerProfileWithEmbedding>(profileId) ?? null
    );
  }
  mergeSpeakerProfiles(a: number, b: number): SuccessResult {
    this.sql.prepare("UPDATE speaker_mappings SET profile_id = ? WHERE profile_id = ?").run(a, b);
    this.sql.prepare("DELETE FROM speaker_profiles WHERE id = ?").run(b);

    return { success: true };
  }
  setSpeakerMapping(
    noteId: number,
    speakerId: string,
    profileId: number | null,
    displayName: string
  ): SuccessResult {
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
      .all<SpeakerMappingRow>(noteId);
  }
  removeSpeakerMapping(noteId: number, speakerId: string): SuccessResult {
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
  ): SuccessResult {
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
      .all<NoteSpeakerEmbeddingRow>(noteId);
  }
  getNotesWithUnmappedSpeakers(): NoteRow[] {
    return this.sql
      .prepare(
        `SELECT ${noteColumns("n")} FROM notes n WHERE EXISTS (SELECT 1 FROM speaker_mappings m WHERE m.note_id = n.id AND m.profile_id IS NULL) ORDER BY n.updated_at DESC`
      )
      .all<RawNoteRow>()
      .map(hydrateNote);
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

// The named export mirrors the default for destructuring require sites; the
// values are identical, so the member access cannot be unsafe.
Object.assign(module.exports, { DatabaseManager });
