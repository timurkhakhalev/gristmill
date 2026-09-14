// Single source of truth for the Notes vertical: row shape, update whitelist,
// the seven DB IPC channels and the three note events. Everything is derived
// from Zod schemas so main, preload and renderer share one description.
//
// The schemas mirror the local SQLite `notes` table and the DatabaseManager
// whitelist (src/helpers/database.js) — not the retired cloud-era types in
// src/types/electron.ts. Note: sqlite rows come back as `unknown` across the
// JS boundary; validate there instead of asserting.
import { z } from "zod";

const nonNegativeInt = z.number().int();

export const noteItemSchema = z.object({
  id: nonNegativeInt,
  title: z.string(),
  content: z.string(),
  note_type: z.string(),
  source_file: z.string().nullable(),
  audio_duration_seconds: z.number().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  enhanced_content: z.string().nullable(),
  enhancement_prompt: z.string().nullable(),
  enhanced_at_content_hash: z.string().nullable(),
  folder_id: nonNegativeInt.nullable(),
  space_id: nonNegativeInt,
  transcript: z.string().nullable(),
  calendar_event_id: z.string().nullable(),
  participants: z.string().nullable(),
  diarization_enabled: z.number().nullable(),
  expected_speaker_count: z.number().nullable(),
});

export type NoteItem = z.infer<typeof noteItemSchema>;

// Every NoteItem field the SQL whitelist accepts, minus id/created_at/
// updated_at which are managed by the table. `undefined` = leave unchanged;
// null is only meaningful for nullable columns.
export const noteUpdateSchema = z
  .object({
    title: z.string().optional(),
    content: z.string().optional(),
    note_type: z.string().optional(),
    source_file: z.string().nullable().optional(),
    audio_duration_seconds: z.number().nullable().optional(),
    enhanced_content: z.string().nullable().optional(),
    enhancement_prompt: z.string().nullable().optional(),
    enhanced_at_content_hash: z.string().nullable().optional(),
    folder_id: nonNegativeInt.nullable().optional(),
    space_id: nonNegativeInt.optional(),
    transcript: z.string().nullable().optional(),
    calendar_event_id: z.string().nullable().optional(),
    participants: z.string().nullable().optional(),
    diarization_enabled: z.number().nullable().optional(),
    expected_speaker_count: z.number().nullable().optional(),
  })
  .strip();

export type NoteUpdate = z.infer<typeof noteUpdateSchema>;

const idArg = z.number().int().nonnegative();
const optionalId = nonNegativeInt.nullable().optional();
const optionalLimit = z.number().optional();

// Positional arguments and channel names are frozen API: renderer preload and
// main handlers both bind to them.
export const saveNoteArgsSchema = z.tuple([
  z.string(),
  z.string(),
  z.string().optional(),
  z.string().nullable().optional(),
  z.number().nullable().optional(),
  optionalId,
  optionalId,
]);

export const getNoteArgsSchema = z.tuple([idArg]);
export const getNotesArgsSchema = z.tuple([
  z.string().nullable().optional(),
  optionalLimit,
  optionalId,
  optionalId,
]);
export const getSpaceNotesArgsSchema = z.tuple([idArg, optionalLimit]);
export const updateNoteArgsSchema = z.tuple([idArg, noteUpdateSchema]);
export const deleteNoteArgsSchema = z.tuple([idArg]);
export const searchNotesArgsSchema = z.tuple([
  z.string(),
  optionalLimit,
  optionalId,
  optionalId,
]);

export const saveNoteResultSchema = z.object({
  success: z.literal(true),
  note: noteItemSchema,
});
export const noteMutationFailureSchema = z.object({
  success: z.literal(false),
  error: z.string().optional(),
});
export const noteMutationResultSchema = z.union([
  saveNoteResultSchema,
  noteMutationFailureSchema,
]);

export const noteListResultSchema = z.array(noteItemSchema);
export const noteOrNullResultSchema = noteItemSchema.nullable();
export type NoteMutationResult = z.infer<typeof noteMutationResultSchema>;

export const noteDeletedPayloadSchema = z.object({ id: idArg });
export type NoteDeletedPayload = z.infer<typeof noteDeletedPayloadSchema>;

export const noteAddedUpdatedPayloadSchema = noteItemSchema;
export type NoteAddedUpdatedPayload = z.infer<typeof noteAddedUpdatedPayloadSchema>;

// The renderer-facing surface: seven operations, three subscriptions.
// Unsubscribe functions are returned by every subscription.
export interface NotesApi {
  saveNote(
    title: string,
    content: string,
    noteType?: string,
    sourceFile?: string | null,
    audioDuration?: number | null,
    folderId?: number | null,
    spaceId?: number | null
  ): Promise<{ success: boolean; note?: NoteItem }>;
  getNote(id: number): Promise<NoteItem | null>;
  getNotes(
    noteType?: string | null,
    limit?: number,
    folderId?: number | null,
    spaceId?: number | null
  ): Promise<NoteItem[]>;
  getSpaceNotes(spaceId: number, limit?: number): Promise<NoteItem[]>;
  updateNote(
    id: number,
    updates: NoteUpdate
  ): Promise<{ success: boolean; note?: NoteItem }>;
  deleteNote(id: number): Promise<{ success: boolean }>;
  searchNotes(
    query: string,
    limit?: number,
    spaceId?: number | null,
    folderId?: number | null
  ): Promise<NoteItem[]>;
  onNoteAdded(callback: (note: NoteItem) => void): () => void;
  onNoteUpdated(callback: (note: NoteItem) => void): () => void;
  onNoteDeleted(callback: (payload: NoteDeletedPayload) => void): () => void;
}

export const noteChannels = {
  saveNote: "db-save-note",
  getNote: "db-get-note",
  getNotes: "db-get-notes",
  getSpaceNotes: "db-get-space-notes",
  updateNote: "db-update-note",
  deleteNote: "db-delete-note",
  searchNotes: "db-search-notes",
} as const;

export const noteEventChannels = {
  added: "note-added",
  updated: "note-updated",
  deleted: "note-deleted",
} as const;
