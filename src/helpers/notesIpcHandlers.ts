// The seven Notes DB channels, moved out of ipcHandlers.js. Registration order,
// positional arguments, return shapes and side effects match the previous JS
// implementations; SQL stays in DatabaseManager. Arguments are accepted as
// unknown, validated with the shared tuple schemas, and only the typed
// result reaches the DB deps; DB rows come back as unknown and are validated
// before use.
import type { ZodType } from "zod";
import {
  deleteNoteArgsSchema,
  getNoteArgsSchema,
  getNotesArgsSchema,
  getSpaceNotesArgsSchema,
  noteMutationResultSchema,
  noteDeleteResultSchema,
  noteOrNullResultSchema,
  noteListResultSchema,
  saveNoteArgsSchema,
  searchNotesArgsSchema,
  updateNoteArgsSchema,
  type NoteItem,
  type NoteMutationResult,
  type NoteUpdate,
} from "../contracts/notes.js";
import { sendNoteAdded, sendNoteUpdated } from "./notesEvents.js";

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
  updateNote: (id: number, updates: NoteUpdate) => unknown;
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

function parseNoteOrNull(raw: unknown): NoteItem | null {
  const result = noteOrNullResultSchema.safeParse(raw);
  if (!result.success) {
    throw new Error("DatabaseManager returned an unexpected note shape");
  }
  return result.data;
}

type IpcEventListener = (event: unknown, ...args: unknown[]) => unknown;

export function registerNotesHandlers(
  ipcMain: { handle(channel: string, listener: IpcEventListener): void },
  deps: NotesHandlerDeps
): void {
  ipcMain.handle(
    "db-save-note",
    async (_event, ...args: unknown[]) => {
      const [title, content, noteType, sourceFile, audioDuration, folderId, spaceId] = parseArgs(
        saveNoteArgsSchema,
        args
      );
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

  ipcMain.handle("db-get-note", async (_event, ...args: unknown[]) => {
    const [id] = parseArgs(getNoteArgsSchema, args);
    return parseNoteOrNull(deps.getNote(id));
  });

  ipcMain.handle("db-get-notes", async (_event, ...args: unknown[]) => {
    const [noteType, limit, folderId, spaceId] = parseArgs(getNotesArgsSchema, args);
    return parseNoteList(deps.getNotes(noteType, limit, folderId ?? null, spaceId ?? null));
  });

  ipcMain.handle("db-get-space-notes", async (_event, ...args: unknown[]) => {
    const [spaceId, limit] = parseArgs(getSpaceNotesArgsSchema, args);
    return parseNoteList(deps.getNotesForSpace(spaceId, limit));
  });

  ipcMain.handle("db-update-note", async (_event, ...args: unknown[]) => {
    const [id, whitelistedUpdates] = parseArgs(updateNoteArgsSchema, args);
    const updates: NoteUpdate = whitelistedUpdates;
    const result = parseNoteResult(deps.updateNote(id, updates));
    if (result.success) {
      setImmediate(() => sendNoteUpdated(result.note));
      deps.asyncMirrorWrite(result.note);
      // "[]" is truthy in JS-land and used to trigger the speaker callbacks;
      // keep that exact condition.
      if (updates.participants) {
        deps.tryAutoLabelOneOnOne(id);
        deps.refreshMeetingSpeakerConfigFromNote(id, result.note);
      }
    }
    return result;
  });

  ipcMain.handle("db-delete-note", async (_event, ...args: unknown[]) => {
    const [id] = parseArgs(deleteNoteArgsSchema, args);
    // deleteNoteInternal owns the delete event and mirror cleanup; validate
    // only its result shape here.
    const raw = await deps.deleteNoteInternal(id);
    const result = noteDeleteResultSchema.safeParse(raw);
    if (!result.success) {
      throw new Error("DatabaseManager returned an unexpected delete result");
    }
    return result.data;
  });

  ipcMain.handle("db-search-notes", async (_event, ...args: unknown[]) => {
    const [query, limit, spaceId, folderId] = parseArgs(searchNotesArgsSchema, args);
    return parseNoteList(deps.searchNotes(query, limit, spaceId ?? null, folderId ?? null));
  });
}
