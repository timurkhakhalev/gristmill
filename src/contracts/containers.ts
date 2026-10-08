// Single source of truth for the folder contract and its DB IPC channels.
// Everything is derived from Zod schemas so main, preload and renderer share
// one description.
//
// The schemas mirror the local SQLite `folders` table and the
// DatabaseManager return shapes (src/helpers/database.js) — not the retired
// cloud-era types in src/types/electron.ts. Rows come back as `unknown`
// across the JS boundary; validate there instead of asserting.
import { z } from "zod";

const nonNegativeInt = z.number().int();

const idArg = nonNegativeInt;

export const folderSchema = z.object({
  id: nonNegativeInt,
  name: z.string(),
  is_default: z.number(),
  sort_order: z.number(),
  icon: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type FolderItem = z.infer<typeof folderSchema>;

export const folderNoteCountSchema = z.object({
  folder_id: nonNegativeInt.nullable(),
  count: nonNegativeInt,
});

export type FolderNoteCount = z.infer<typeof folderNoteCountSchema>;

// Positional arguments are frozen API: renderer preload and main handlers
// both bind to them. Names and update payloads stay tolerant (the DB layer
// owns trimming, whitelisting and the "Folder name is required" /
// "{success:false}" outcomes); only ids are strict.
export const getFoldersArgsSchema = z.tuple([]);

export const createFolderArgsSchema = z.tuple([z.unknown().optional()]);

export const deleteFolderArgsSchema = z.tuple([idArg]);

export const renameFolderArgsSchema = z.tuple([idArg, z.unknown().optional()]);

export const folderStyleSchema = z.object({
  icon: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
});

export type FolderStyle = z.infer<typeof folderStyleSchema>;

export const updateFolderStyleArgsSchema = z.tuple([idArg, folderStyleSchema]);

export const reorderFoldersArgsSchema = z.tuple([z.array(idArg)]);

export const getFolderNoteCountsArgsSchema = z.tuple([]);

// renameFolder misses omit `folder` entirely (the SELECT after a 0-change
// UPDATE returns undefined); the schema keeps the field optional so the
// shape stays documented without inventing a null the DB never sends.
export const folderMutationResultSchema = z.object({
  success: z.boolean(),
  folder: folderSchema.nullish(),
  error: z.string().optional(),
});

export type FolderMutationResult = z.infer<typeof folderMutationResultSchema>;

// deleteFolder never carries the row back; the DB layer reports plain success.
export const folderDeleteResultSchema = z.object({
  success: z.boolean(),
  // Notes whose primary folder was the deleted one, for the mirror rewrite.
  relocatedNoteIds: z.array(z.number().int()).optional(),
});

export const folderListResultSchema = z.array(folderSchema);

export const folderNoteCountsResultSchema = z.array(folderNoteCountSchema);

// Event payloads: folder rows carry the full local row; deletion only
// carries the id the handler was called with.
export const folderDeletedPayloadSchema = z.object({ id: idArg });

export type FolderDeletedPayload = z.infer<typeof folderDeletedPayloadSchema>;

export const folderCreatedRenamedSyncedPayloadSchema = folderSchema;

// The renderer-facing surface: folder operations and one subscription.
export interface ContainersApi {
  getFolders(): Promise<FolderItem[]>;
  createFolder(name: string): Promise<FolderMutationResult>;
  deleteFolder(id: number): Promise<{ success: boolean }>;
  renameFolder(id: number, name: string): Promise<FolderMutationResult>;
  updateFolderStyle(id: number, style: FolderStyle): Promise<FolderMutationResult>;
  reorderFolders(folderIds: number[]): Promise<{ success: boolean }>;
  getFolderNoteCounts(): Promise<FolderNoteCount[]>;
  onFolderDeleted(callback: (payload: FolderDeletedPayload) => void): () => void;
}

export const containerChannels = {
  getFolders: "db-get-folders",
  createFolder: "db-create-folder",
  deleteFolder: "db-delete-folder",
  renameFolder: "db-rename-folder",
  updateFolderStyle: "db-update-folder-style",
  reorderFolders: "db-reorder-folders",
  getFolderNoteCounts: "db-get-folder-note-counts",
} as const;

export const containerEventChannels = {
  folderCreated: "folder-created",
  folderDeleted: "folder-deleted",
  folderRenamed: "folder-renamed",
  folderSynced: "folder-synced",
} as const;
