// Single source of truth for the containers vertical: local folder/space row
// shapes, the eight DB IPC channels and the five folder/space events.
// Everything is derived from Zod schemas so main, preload and renderer share
// one description.
//
// The schemas mirror the local SQLite `folders`/`spaces` tables and the
// DatabaseManager return shapes (src/helpers/database.js) — not the retired
// cloud-era types in src/types/electron.ts. Rows come back as `unknown`
// across the JS boundary; validate there instead of asserting.
import { z } from "zod";
import { noteItemSchema } from "./notes.js";

const nonNegativeInt = z.number().int();
const idArg = nonNegativeInt;
const optionalId = nonNegativeInt.nullable().optional();

export const folderSchema = z.object({
  id: nonNegativeInt,
  name: z.string(),
  is_default: z.number(),
  sort_order: z.number(),
  space_id: nonNegativeInt,
  icon: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type FolderItem = z.infer<typeof folderSchema>;

export const spaceSchema = z.object({
  id: nonNegativeInt,
  name: z.string(),
  emoji: z.string().nullable(),
  kind: z.literal("private"),
  sort_order: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type SpaceItem = z.infer<typeof spaceSchema>;

export const folderNoteCountSchema = z.object({
  folder_id: nonNegativeInt.nullable(),
  space_id: nonNegativeInt,
  count: nonNegativeInt,
});
export type FolderNoteCount = z.infer<typeof folderNoteCountSchema>;

// Positional arguments are frozen API: renderer preload and main handlers
// both bind to them. Names and update payloads stay tolerant (the DB layer
// owns trimming, whitelisting and the "Folder name is required" /
// "{success:false}" outcomes); only ids are strict.
export const getFoldersArgsSchema = z.tuple([optionalId]);
export const createFolderArgsSchema = z.tuple([z.unknown().optional(), optionalId]);
export const deleteFolderArgsSchema = z.tuple([idArg]);
export const renameFolderArgsSchema = z.tuple([idArg, z.unknown().optional()]);
export const folderStyleSchema = z.object({
  icon: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
});
export type FolderStyle = z.infer<typeof folderStyleSchema>;
export const updateFolderStyleArgsSchema = z.tuple([idArg, folderStyleSchema]);
export const reorderFoldersArgsSchema = z.tuple([idArg, z.array(idArg)]);
export const moveFolderToSpaceArgsSchema = z.tuple([idArg, idArg]);
export const getFolderNoteCountsArgsSchema = z.tuple([]);
export const getSpacesArgsSchema = z.tuple([]);
export const updateSpaceArgsSchema = z.tuple([idArg, z.unknown().optional()]);

// renameFolder misses omit `folder` entirely (the SELECT after a 0-change
// UPDATE returns undefined); the schema keeps the field optional so the
// shape stays documented without inventing a null the DB never sends.
export const folderMutationResultSchema = z.object({
  success: z.boolean(),
  folder: folderSchema.nullish(),
  error: z.string().optional(),
});
export type FolderMutationResult = z.infer<typeof folderMutationResultSchema>;

// The moved notes are re-read after the move (new space_id already applied).
export const folderMoveResultSchema = z.object({
  success: z.boolean(),
  folder: folderSchema.nullable().optional(),
  notes: z.array(noteItemSchema).optional(),
  error: z.string().optional(),
});
export type FolderMoveResult = z.infer<typeof folderMoveResultSchema>;

export const spaceMutationResultSchema = z.object({
  success: z.boolean(),
  space: spaceSchema.nullable().optional(),
  error: z.string().optional(),
});
export type SpaceMutationResult = z.infer<typeof spaceMutationResultSchema>;

// deleteFolder never carries the row back; the DB layer reports plain success.
export const folderDeleteResultSchema = z.object({ success: z.boolean() });

export const folderListResultSchema = z.array(folderSchema);
export const spaceListResultSchema = z.array(spaceSchema);
export const folderNoteCountsResultSchema = z.array(folderNoteCountSchema);

// Event payloads: folder/space rows carry the full local row; deletion only
// carries the id the handler was called with.
export const folderDeletedPayloadSchema = z.object({ id: idArg });
export type FolderDeletedPayload = z.infer<typeof folderDeletedPayloadSchema>;
export const folderCreatedRenamedSyncedPayloadSchema = folderSchema;
export const spaceSyncedPayloadSchema = spaceSchema;

// The renderer-facing surface: eight operations, one subscription. Main-only
// events without a renderer listener (folder-created/renamed/synced,
// space-synced) stay unexposed in the bridge.
export interface ContainersApi {
  getFolders(spaceId?: number | null): Promise<FolderItem[]>;
  createFolder(name: string, spaceId?: number | null): Promise<FolderMutationResult>;
  deleteFolder(id: number): Promise<{ success: boolean }>;
  renameFolder(id: number, name: string): Promise<FolderMutationResult>;
  updateFolderStyle(id: number, style: FolderStyle): Promise<FolderMutationResult>;
  reorderFolders(spaceId: number, folderIds: number[]): Promise<{ success: boolean }>;
  moveFolderToSpace(id: number, spaceId: number): Promise<FolderMoveResult>;
  getFolderNoteCounts(): Promise<FolderNoteCount[]>;
  getSpaces(): Promise<SpaceItem[]>;
  updateSpace(
    id: number,
    updates: { name?: string; emoji?: string | null }
  ): Promise<SpaceMutationResult>;
  onFolderDeleted(callback: (payload: FolderDeletedPayload) => void): () => void;
}

export const containerChannels = {
  getFolders: "db-get-folders",
  createFolder: "db-create-folder",
  deleteFolder: "db-delete-folder",
  renameFolder: "db-rename-folder",
  updateFolderStyle: "db-update-folder-style",
  reorderFolders: "db-reorder-folders",
  moveFolderToSpace: "db-move-folder-to-space",
  getFolderNoteCounts: "db-get-folder-note-counts",
  getSpaces: "db-get-spaces",
  updateSpace: "db-update-space",
} as const;

export const containerEventChannels = {
  folderCreated: "folder-created",
  folderDeleted: "folder-deleted",
  folderRenamed: "folder-renamed",
  folderSynced: "folder-synced",
  spaceSynced: "space-synced",
} as const;
