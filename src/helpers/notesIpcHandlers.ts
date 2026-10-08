import {
  noteOutputRequestSchema,
  noteOutputSchema,
  type NoteOutputRequest,
} from "../contracts/noteOutput.js";
// Notes IPC validates transport arguments. NoteWriteService owns committed
// edits and their effects; NoteReadService owns output assembly, and
// DatabaseManager owns SQL.
import { z, type ZodType } from "zod";
import {
  noteChannels,
  deleteNoteArgsSchema,
  getNoteArgsSchema,
  getNotesArgsSchema,
  getRootNotesArgsSchema,
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
    folderId: number | null
  ) => unknown;
  getRootNotes: (limit: number | undefined) => unknown;
  deleteNoteInternal: (id: number) => unknown;
  searchNotes: (
    query: string,
    limit: number | undefined,
    folderId: number | null,
    rootOnly: boolean | undefined
  ) => unknown;
  searchNoteContent: (query: string) => unknown;
  searchNoteTranscripts: (query: string) => unknown;
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

const searchScopeArgsSchema = z.tuple([z.string()]);

const noteTranscriptArgsSchema = z.tuple([z.number().int().positive()]);

export function registerNotesHandlers(
  ipcMain: { handle(channel: string, listener: IpcEventListener): void },
  deps: NotesHandlerDeps
): void {
  ipcMain.handle("db-save-note", async (_event, ...args: unknown[]) => {
    const [title, content, noteType, sourceFile, audioDuration, folderId] = parseArgs(
      saveNoteArgsSchema,
      args
    );

    return deps.noteWrites.saveNote(
      title,
      content,
      noteType,
      sourceFile ?? null,
      audioDuration ?? null,
      folderId ?? null
    );
  });

  ipcMain.handle(noteChannels.getNoteOutput, (_event, ...args) => {
    const [request] = parseArgs(noteOutputRequestSchema.array().length(1), args);

    return noteOutputSchema.parse(deps.getNoteOutput(request));
  });

  ipcMain.handle("db-get-note", async (_event, ...args: unknown[]) => {
    const [id] = parseArgs(getNoteArgsSchema, args);

    return parseNoteOrNull(deps.getNote(id));
  });

  ipcMain.handle("db-get-notes", async (_event, ...args: unknown[]) => {
    const [noteType, limit, folderId] = parseArgs(getNotesArgsSchema, args);

    return parseNoteList(deps.getNotes(noteType, limit, folderId ?? null));
  });

  ipcMain.handle(noteChannels.getRootNotes, async (_event, ...args: unknown[]) => {
    const [limit] = parseArgs(getRootNotesArgsSchema, args);

    return parseNoteList(deps.getRootNotes(limit));
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
    const [query, limit, folderId, rootOnly] = parseArgs(searchNotesArgsSchema, args);

    return parseNoteList(deps.searchNotes(query, limit, folderId ?? null, rootOnly));
  });

  ipcMain.handle("notes-search-content", async (_event, ...args: unknown[]) => {
    const [query] = parseArgs(searchScopeArgsSchema, args);

    return noteSearchHitSchema.array().parse(deps.searchNoteContent(query));
  });

  ipcMain.handle("notes-search-transcripts", async (_event, ...args: unknown[]) => {
    const [query] = parseArgs(searchScopeArgsSchema, args);

    return transcriptSearchHitSchema.array().parse(deps.searchNoteTranscripts(query));
  });

  ipcMain.handle("notes-get-transcript", async (_event, ...args: unknown[]) => {
    const [noteId] = parseArgs(noteTranscriptArgsSchema, args);

    return noteTranscriptSchema.parse(deps.getNoteTranscript(noteId));
  });
}
