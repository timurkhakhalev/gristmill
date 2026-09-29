// Renderer-facing Notes bridge. Moved out of preload.js so the seven
// operations and three subscriptions have one typed implementation backed by
// the shared contract. The sandboxed preload can't require local modules, so
// build-main.js bundles the final preload with esbuild before packaging.
import {
  noteChannels,
  noteDeletedPayloadSchema,
  noteDeleteResultSchema,
  noteEventChannels,
  noteItemSchema,
  noteListResultSchema,
  noteSearchHitSchema,
  transcriptSearchHitSchema,
  noteMutationResultSchema,
  noteOrNullResultSchema,
  type NotesApi,
  type NoteDeletedPayload,
  type NoteItem,
  type NoteUpdate,
} from "../contracts/notes.js";
import { z, type ZodType } from "zod";
import { noteTranscriptSchema } from "../contracts/noteRead.js";

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => void
  ): unknown;
}

function parseResult<T>(schema: ZodType<T>, raw: unknown, channel: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Unexpected response shape from ${channel}`);
  }
  return result.data;
}

function invokeParseArray<T>(schema: ZodType<T>, ipcRenderer: IpcRendererLike, channel: string, ...args: unknown[]): Promise<T[]> {
  return ipcRenderer.invoke(channel, ...args).then((raw) => parseResult(z.array(schema), raw, channel));
}

// The return type is the shared NotesApi, so any drift between this
// implementation and the contract fails compilation instead of review.
export function createNotesBridge(ipcRenderer: IpcRendererLike): NotesApi {
  return {
    saveNote: (
      title: string,
      content: string,
      noteType?: string,
      sourceFile?: string | null,
      audioDuration?: number | null,
      folderId?: number | null,
      spaceId?: number | null
    ) =>
      ipcRenderer
        .invoke(
          noteChannels.saveNote,
          title,
          content,
          noteType,
          sourceFile,
          audioDuration,
          folderId,
          spaceId
        )
        .then((raw) =>
          parseResult(noteMutationResultSchema, raw, noteChannels.saveNote)
        ),
    getNote: (id: number) =>
      ipcRenderer
        .invoke(noteChannels.getNote, id)
        .then((raw) =>
          parseResult(noteOrNullResultSchema, raw, noteChannels.getNote)
        ),
    getNotes: (noteType?: string | null, limit?: number, folderId?: number | null, spaceId?: number | null) =>
      ipcRenderer
        .invoke(noteChannels.getNotes, noteType, limit, folderId, spaceId)
        .then((raw) =>
          parseResult(noteListResultSchema, raw, noteChannels.getNotes)
        ),
    getSpaceNotes: (spaceId: number, limit?: number) =>
      ipcRenderer
        .invoke(noteChannels.getSpaceNotes, spaceId, limit)
        .then((raw) =>
          parseResult(noteListResultSchema, raw, noteChannels.getSpaceNotes)
        ),
    updateNote: (id: number, updates: NoteUpdate) =>
      ipcRenderer
        .invoke(noteChannels.updateNote, id, updates)
        .then((raw) =>
          parseResult(noteMutationResultSchema, raw, noteChannels.updateNote)
        ),
    deleteNote: (id: number) =>
      ipcRenderer
        .invoke(noteChannels.deleteNote, id)
        .then((raw) =>
          parseResult(noteDeleteResultSchema, raw, noteChannels.deleteNote)
        ),
    searchNotes: (query: string, limit?: number, spaceId?: number | null, folderId?: number | null) =>
      ipcRenderer
        .invoke(noteChannels.searchNotes, query, limit, spaceId, folderId)
        .then((raw) =>
          parseResult(noteListResultSchema, raw, noteChannels.searchNotes)
        ),
    searchNoteContent: (query, spaceId) =>
      invokeParseArray(noteSearchHitSchema, ipcRenderer, noteChannels.searchNoteContent, query, spaceId),
    searchNoteTranscripts: (query, spaceId) =>
      invokeParseArray(transcriptSearchHitSchema, ipcRenderer, noteChannels.searchNoteTranscripts, query, spaceId),
    getNoteTranscript: (noteId) =>
      ipcRenderer.invoke(noteChannels.getNoteTranscript, noteId).then((raw) => parseResult(noteTranscriptSchema, raw, noteChannels.getNoteTranscript)),

    onNoteAdded: (callback: (note: NoteItem) => void) =>
      subscribeValidated(
        ipcRenderer,
        noteEventChannels.added,
        noteItemSchema,
        callback
      ),
    onNoteUpdated: (callback: (note: NoteItem) => void) =>
      subscribeValidated(
        ipcRenderer,
        noteEventChannels.updated,
        noteItemSchema,
        callback
      ),
    onNoteDeleted: (callback: (payload: NoteDeletedPayload) => void) =>
      subscribeValidated(
        ipcRenderer,
        noteEventChannels.deleted,
        noteDeletedPayloadSchema,
        callback
      ),
  };
}

// Events arrive from main as fire-and-forget payloads; a malformed one is
// dropped (diagnosed without note content) instead of handed to the renderer,
// and the next valid event still gets through. The Electron event object is
// never forwarded.
function subscribeValidated<T>(
  ipcRenderer: IpcRendererLike,
  channel: string,
  schema: ZodType<T>,
  callback: (payload: T) => void
): () => void {
  if (typeof callback !== "function") {
    return () => {};
  }
  const listener = (_event: unknown, data: unknown) => {
    const result = schema.safeParse(data);
    if (!result.success) {
      console.error(`[notesBridge] dropped malformed ${channel} event`);
      return;
    }
    callback(result.data);
  };
  ipcRenderer.on(channel, listener as (event: unknown, ...args: unknown[]) => void);
  return () => {
    ipcRenderer.removeListener(channel, listener as (event: unknown, ...args: unknown[]) => void);
  };
}
