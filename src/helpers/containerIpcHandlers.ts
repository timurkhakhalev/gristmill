// The eight container (folders/spaces) DB channels, moved out of
// ipcHandlers.js. Registration order, positional arguments, return shapes and
// side effects match the previous JS implementations; SQL stays in
// DatabaseManager. Arguments are accepted as unknown, validated with the
// shared tuple schemas, and only validated results/events reach the wire.
import type { ZodType } from "zod";
import {
  createFolderArgsSchema,
  deleteFolderArgsSchema,
  folderDeleteResultSchema,
  folderListResultSchema,
  folderMoveResultSchema,
  folderMutationResultSchema,
  getFolderNoteCountsArgsSchema,
  folderNoteCountsResultSchema,
  getFoldersArgsSchema,
  getSpacesArgsSchema,
  moveFolderToSpaceArgsSchema,
  renameFolderArgsSchema,
  spaceListResultSchema,
  spaceMutationResultSchema,
  updateSpaceArgsSchema,
  type FolderDeletedPayload,
  type FolderItem,
} from "../contracts/containers.js";
import { noteItemSchema, type NoteItem } from "../contracts/notes.js";
import {
  sendFolderCreated,
  sendFolderDeleted,
  sendFolderRenamed,
  sendFolderSynced,
  sendSpaceSynced,
} from "./containerEvents.js";

export interface ContainerHandlerDeps {
  database: {
    getFolders: (spaceId: unknown) => unknown;
    createFolder: (name: unknown, spaceId: unknown) => unknown;
    deleteFolder: (id: unknown) => unknown;
    renameFolder: (id: unknown, name: unknown) => unknown;
    moveFolderToSpace: (id: unknown, spaceId: unknown) => unknown;
    getFolderNoteCounts: () => unknown;
    getSpaces: () => unknown;
    updateSpace: (id: unknown, updates: unknown) => unknown;
  };
  noteFilesEnabled: () => boolean;
  // Mirrors: folder names are resolved before the delete/rename (the row is
  // gone afterwards), effects stay deferred exactly like the JS handlers had.
  getFolderName: (folderId: number) => string | null;
  mirrorWriteNote: (note: NoteItem) => void;
  mirrorEnsureFolder: (name: string) => void;
  mirrorRenameFolder: (oldName: string, newName: string) => void;
  mirrorDeleteFolderIfUnshared: (name: string) => void;
}

type IpcEventListener = (event: unknown, ...args: unknown[]) => unknown;

// Throw before the DB is touched when the renderer sent a wrong-shaped call.
function parseArgs<T>(schema: ZodType<T>, args: unknown): T {
  const result = schema.safeParse(args);
  if (!result.success) {
    throw new Error("Invalid arguments for a container IPC call");
  }
  return result.data;
}

function parseResult<T>(schema: ZodType<T>, raw: unknown, what: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`DatabaseManager returned an unexpected ${what}`);
  }
  return result.data;
}

export function registerContainerHandlers(
  ipcMain: { handle(channel: string, listener: IpcEventListener): void },
  deps: ContainerHandlerDeps
): void {
  const { database } = deps;

  ipcMain.handle("db-get-folders", async (_event, ...args: unknown[]) => {
    const [spaceId] = parseArgs(getFoldersArgsSchema, args);
    return parseResult(
      folderListResultSchema,
      database.getFolders(spaceId ?? null),
      "folder list shape"
    );
  });

  ipcMain.handle("db-create-folder", async (_event, ...args: unknown[]) => {
    const [name, spaceId] = parseArgs(createFolderArgsSchema, args);
    const result = parseResult(
      folderMutationResultSchema,
      database.createFolder(name, spaceId ?? null),
      "folder mutation result"
    );
    if (result.success && result.folder) {
      setImmediate(() => {
        sendFolderCreated(result.folder as FolderItem);
        if (deps.noteFilesEnabled()) {
          deps.mirrorEnsureFolder(result.folder!.name);
        }
      });
    }
    return result;
  });

  ipcMain.handle("db-delete-folder", async (_event, ...args: unknown[]) => {
    const [id] = parseArgs(deleteFolderArgsSchema, args);
    // database.deleteFolder returns only {success}; notes survive via
    // ON DELETE SET NULL, so there is no relocated-note list to mirror here.
    const folderName = deps.noteFilesEnabled() ? deps.getFolderName(id) : null;
    const result = parseResult(
      folderDeleteResultSchema,
      database.deleteFolder(id),
      "folder delete result"
    );
    if (result.success) {
      setImmediate(() => {
        const payload: FolderDeletedPayload = { id };
        sendFolderDeleted(payload);
        if (folderName) deps.mirrorDeleteFolderIfUnshared(folderName);
      });
    }
    return result;
  });

  ipcMain.handle("db-rename-folder", async (_event, ...args: unknown[]) => {
    const [id, name] = parseArgs(renameFolderArgsSchema, args);
    const oldName = deps.noteFilesEnabled() ? deps.getFolderName(id) : null;
    const result = parseResult(
      folderMutationResultSchema,
      database.renameFolder(id, name),
      "folder mutation result"
    );
    if (result.success && result.folder) {
      setImmediate(() => {
        sendFolderRenamed(result.folder as FolderItem);
        if (deps.noteFilesEnabled() && oldName) {
          deps.mirrorRenameFolder(oldName, result.folder!.name);
        }
      });
    }
    return result;
  });

  ipcMain.handle("db-move-folder-to-space", async (_event, ...args: unknown[]) => {
    const [id, spaceId] = parseArgs(moveFolderToSpaceArgsSchema, args);
    const result = parseResult(
      folderMoveResultSchema,
      database.moveFolderToSpace(id, spaceId),
      "folder move result"
    );
    if (result.success && result.folder) {
      setImmediate(() => sendFolderSynced(result.folder as FolderItem));
    }
    return result;
  });

  ipcMain.handle("db-get-folder-note-counts", async (_event, ...args: unknown[]) => {
    parseArgs(getFolderNoteCountsArgsSchema, args);
    return parseResult(
      folderNoteCountsResultSchema,
      database.getFolderNoteCounts(),
      "folder note counts shape"
    );
  });

  ipcMain.handle("db-get-spaces", async (_event, ...args: unknown[]) => {
    parseArgs(getSpacesArgsSchema, args);
    return parseResult(spaceListResultSchema, database.getSpaces(), "space list shape");
  });

  ipcMain.handle("db-update-space", async (_event, ...args: unknown[]) => {
    const [id, updates] = parseArgs(updateSpaceArgsSchema, args);
    const result = parseResult(
      spaceMutationResultSchema,
      database.updateSpace(id, updates),
      "space mutation result"
    );
    if (result.success && result.space) {
      setImmediate(() => sendSpaceSynced(result.space));
    }
    return result;
  });
}
