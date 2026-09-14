// The seven Notes DB channels, moved out of ipcHandlers.js. Registration order,
// positional arguments, return shapes and side effects match the previous JS
// implementations; SQL stays in DatabaseManager. The JS side of the boundary
// is treated as `unknown` and validated with the shared contract before use.
import { ipcMain } from "electron";
import type { ZodType } from "zod";
import {
  deleteNoteArgsSchema,
  getNoteArgsSchema,
  getNotesArgsSchema,
  getSpaceNotesArgsSchema,
  noteItemSchema,
  noteMutationResultSchema,
  noteOrNullResultSchema,
  noteListResultSchema,
  saveNoteArgsSchema,
  searchNotesArgsSchema,
  updateNoteArgsSchema,
  type NoteItem,
  type NoteMutationResult,
} from "../contracts/notes.js";
import { sendNoteAdded, sendNoteDeleted, sendNoteUpdated } from "./notesEvents.js";

export interface NotesHandlerDeps {
  saveNote: (
    title: string,
    content: string,
    noteType: string | undefined,
    sourceFile: string | null,
    audioDuration: number | null,
    folderId: number | null,
    spaceId: number | null
  ) => unknown;
  getNote: (id: number) => unknown;
  getNotes: (
    noteType: string | null | undefined,
    limit: number | undefined,
    folderId: number | null,
    spaceId: number | null
  ) => unknown;
  getNotesForSpace: (spaceId: number, limit: number | undefined) => unknown;
  updateNote: (id: number, updates: Record<string, unknown>) => unknown;
  deleteNoteInternal: (id: number) => unknown;
  searchNotes: (
    query: string,
    limit: number | undefined,
    spaceId: number | null,
    folderId: number | null
  ) => unknown;
  asyncMirrorWrite: (note: NoteItem) => void;
  tryAutoLabelOneOnOne: (noteId: number) => void;
  refreshMeetingSpeakerConfigFromNote: (noteId: number, note: NoteItem) => void;
}

// Throw before the DB is touched when the renderer sent a wrong-shaped call.
function parseArgs<T>(schema: ZodType<T>, args: unknown): T {
  const result = schema.safeParse(args);
  if (!result.success) {
    throw new Error("Invalid arguments for a Notes IPC call");
  }
  return result.data;
}

// DB rows and mutation results come from untyped JS. Validate before use so a
// shape drift surfaces as a validation error, not a silently-typed lie.
function parseNoteResult(raw: unknown): NoteMutationResult {
  const result = noteMutationResultSchema.safeParse(raw);
  if (!result.success) {
    throw new Error("DatabaseManager returned an unexpected note mutation result");
  }
  return result.data;
}

function parseNoteList(raw: unknown): NoteItem[] {
  const result = noteListResultSchema.safeParse(raw);
  if (!result.success) {
    throw new Error("DatabaseManager returned an unexpected note list shape");
  }
  return result.data;
}

export function registerNotesHandlers(
  ipcMain: { handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void },
  deps: NotesHandlerDeps
): void {
  ipcMain.handle(
    "db-save-note",
    async (event, title, content, noteType, sourceFile, audioDuration, folderId, spaceId) => {
      parseArgs(saveNoteArgsSchema, [
        title,
        content,
        noteType,
        sourceFile,
        audioDuration,
        folderId,
        spaceId,
      ]);
      const result = parseNoteResult(
        deps.saveNote(
          title,
          content,
          noteType,
          sourceFile ?? null,
          audioDuration ?? null,
          folderId ?? null,
          spaceId ?? null
        )
      );
      if (result.success) {
        setImmediate(() => sendNoteAdded(result.note));
        deps.asyncMirrorWrite(result.note);
      }
      return result;
    }
  );

  ipcMain.handle("db-get-note", async (event, id) => {
    parseArgs(getNoteArgsSchema, [id]);
    const raw = deps.getNote(id);
    const result = noteOrNullResultSchema.safeParse(raw);
    if (!result.success) {
      throw new Error("DatabaseManager returned an unexpected note shape");
    }
    return result.data;
  });

  ipcMain.handle("db-get-notes", async (event, noteType, limit, folderId, spaceId) => {
    parseArgs(getNotesArgsSchema, [noteType, limit, folderId, spaceId]);
    return parseNoteList(deps.getNotes(noteType, limit, folderId ?? null, spaceId ?? null));
  });

  ipcMain.handle("db-get-space-notes", async (event, spaceId, limit) => {
    parseArgs(getSpaceNotesArgsSchema, [spaceId, limit]);
    return parseNoteList(deps.getNotesForSpace(spaceId, limit));
  });

  ipcMain.handle("db-update-note", async (event, id, updates) => {
    const [, whitelisted] = parseArgs(updateNoteArgsSchema, [id, updates]);
    const result = parseNoteResult(deps.updateNote(id, whitelisted));
    if (result.success) {
      setImmediate(() => sendNoteUpdated(result.note));
      deps.asyncMirrorWrite(result.note);
      // "[]" is truthy in JS-land and used to trigger the speaker callbacks;
      // keep that exact condition.
      if (whitelisted.participants) {
        deps.tryAutoLabelOneOnOne(id);
        deps.refreshMeetingSpeakerConfigFromNote(id, result.note);
      }
    }
    return result;
  });

  ipcMain.handle("db-delete-note", async (event, id) => {
    parseArgs(deleteNoteArgsSchema, [id]);
    return deps.deleteNoteInternal(id);
  });

  ipcMain.handle("db-search-notes", async (event, query, limit, spaceId, folderId) => {
    parseArgs(searchNotesArgsSchema, [query, limit, spaceId, folderId]);
    return parseNoteList(deps.searchNotes(query, limit, spaceId ?? null, folderId ?? null));
  });
}
