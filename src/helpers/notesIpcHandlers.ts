import { noteOutputRequestSchema, noteOutputSchema, type NoteOutputRequest } from "../contracts/noteOutput.js";
// Notes IPC validates transport arguments. NoteWriteService owns committed
// edits and their effects; NoteReadService owns output assembly, and
// DatabaseManager owns SQL.
import type { ZodType } from "zod";
import {
  noteChannels,
  deleteNoteArgsSchema,
  getNoteArgsSchema,
  getNotesArgsSchema,
  getSpaceNotesArgsSchema,
  noteDeleteResultSchema,
  noteOrNullResultSchema,
  noteListResultSchema,
  saveNoteArgsSchema,
  searchNotesArgsSchema,
  noteSearchHitSchema,
  transcriptSearchHitSchema,
  updateNoteArgsSchema,
  type NoteItem,
} from "../contracts/notes.js";
import type { NoteWriteService } from "./noteWriteService.js";
import { noteTranscriptSchema } from "../contracts/noteRead.js";

export interface NotesHandlerDeps {
  noteWrites: Pick<NoteWriteService, "saveNote" | "updateNote">;
  getNote: (id: number) => unknown;
  getNotes: (
    noteType: string | null | undefined,
    limit: number | undefined,
    folderId: number | null,
    spaceId: number | null
  ) => unknown;
  getNotesForSpace: (spaceId: number, limit: number | undefined) => unknown;
  deleteNoteInternal: (id: number) => unknown;
  searchNotes: (
    query: string,
    limit: number | undefined,
    spaceId: number | null,
    folderId: number | null
  ) => unknown;
  searchNoteContent: (query: string, spaceId: number | null) => unknown;
  searchNoteTranscripts: (query: string, spaceId: number | null) => unknown;
  getNoteTranscript: (noteId: number) => unknown;
  getNoteOutput: (request: NoteOutputRequest) => unknown;
}

// Throw before the DB is touched when the renderer sent a wrong-shaped call.
function parseArgs<T>(schema: ZodType<T>, args: unknown): T {
  const result = schema.safeParse(args);
  if (!result.success) {
    throw new Error("Invalid arguments for a Notes IPC call");
  }
  return result.data;
}

// Validate untyped read results before returning them to the renderer.
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
      return deps.noteWrites.saveNote(
        title, content, noteType, sourceFile ?? null, audioDuration ?? null,
        folderId ?? null, spaceId ?? null
      );
    }
  );

  ipcMain.handle(noteChannels.getNoteOutput, (_event, ...args) => {
    const [request] = parseArgs(noteOutputRequestSchema.array().length(1), args);
    return noteOutputSchema.parse(deps.getNoteOutput(request));
  });

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
    return deps.noteWrites.updateNote(id, whitelistedUpdates);
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
  ipcMain.handle("notes-search-content", async (_event, query: unknown, spaceId: unknown) => {
    if (typeof query !== "string" || (spaceId != null && (!Number.isSafeInteger(spaceId) || (spaceId as number) < 1))) throw new Error("Invalid search arguments");
    return noteSearchHitSchema.array().parse(deps.searchNoteContent(query, spaceId as number | null));
  });
  ipcMain.handle("notes-search-transcripts", async (_event, query: unknown, spaceId: unknown) => {
    if (typeof query !== "string" || (spaceId != null && (!Number.isSafeInteger(spaceId) || (spaceId as number) < 1))) throw new Error("Invalid search arguments");
    return transcriptSearchHitSchema.array().parse(deps.searchNoteTranscripts(query, spaceId as number | null));
  });
  ipcMain.handle("notes-get-transcript", async (_event, noteId: unknown) => {
    if (!Number.isSafeInteger(noteId) || (noteId as number) < 1) throw new Error("Invalid Note ID");
    return noteTranscriptSchema.parse(deps.getNoteTranscript(noteId as number));
  });
}
