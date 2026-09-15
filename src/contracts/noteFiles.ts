// Shared wire contract for the note-files (markdown mirror), Granola import
// and file/folder reveal channels. The mirror stays a projection of the
// SQLite-owned note content; the import preview/result never carries file
// paths or handles across the bridge — the run only ever imports what the
// main-side preview parsed.
import { z } from "zod";

export const noteFilesChannels = {
  noteFilesSetEnabled: "note-files-set-enabled",
  noteFilesSetPath: "note-files-set-path",
  noteFilesRebuild: "note-files-rebuild",
  noteFilesGetDefaultPath: "note-files-get-default-path",
  noteFilesPickFolder: "note-files-pick-folder",
  showNoteFile: "show-note-file",
  showFolderInExplorer: "show-folder-in-explorer",
  granolaImportPickAndPreview: "granola-import-pick-and-preview",
  granolaImportRun: "granola-import-run",
} as const;

export const commandResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});
export type NoteFilesCommandResult = z.infer<typeof commandResultSchema>;

export const noteFilesSetEnabledArgsSchema = z.tuple([
  z.boolean(),
  z.string().optional(),
  z.object({ skipRebuild: z.boolean().optional() }).optional(),
]);
export type NoteFilesSetEnabledOptions = { skipRebuild?: boolean };

export const noteFilesSetPathArgsSchema = z.tuple([z.string().min(1)]);

export const pickFolderResultSchema = z.object({
  canceled: z.boolean(),
  path: z.string().optional(),
});
export type PickFolderResult = z.infer<typeof pickFolderResultSchema>;

export const showNoteFileArgsSchema = z.tuple([z.number().int().positive()]);
export const showFolderInExplorerArgsSchema = z.tuple([z.string().min(1)]);

// Granola import: the preview parses in main from picked files; the renderer
// receives only counts/titles and never a path.
export const granolaPreviewResultSchema = z.union([
  z.object({ canceled: z.literal(true) }),
  z.object({
    canceled: z.literal(false),
    success: z.literal(false),
    error: z.string(),
  }),
  z.object({
    canceled: z.literal(false),
    success: z.literal(true),
    fileName: z.string(),
    total: z.number().int(),
    newCount: z.number().int(),
    duplicateCount: z.number().int(),
    sampleTitles: z.array(z.string()),
    rowIssueCount: z.number().int(),
  }),
]);
// The insert-ready note the main-side parser produced; crossing only into
// the import handler dependency, never the renderer API.
export interface GranolaParsedNote {
  clientNoteId: string;
  sourceFile: string;
  title: string;
  content: string;
  transcript: string | null;
  participants: string | null;
  createdAt: string | null;
}

export type GranolaPreviewResult = z.infer<typeof granolaPreviewResultSchema>;

export const granolaRunResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  imported: z.number().int().optional(),
  skipped: z.number().int().optional(),
  errors: z.array(z.object({ error: z.string() })).optional(),
});
export type GranolaRunResult = z.infer<typeof granolaRunResultSchema>;

export interface NoteFilesApi {
  noteFilesSetEnabled(
    enabled: boolean,
    customPath?: string,
    options?: NoteFilesSetEnabledOptions
  ): Promise<NoteFilesCommandResult>;
  noteFilesSetPath(path: string): Promise<NoteFilesCommandResult>;
  noteFilesRebuild(): Promise<NoteFilesCommandResult>;
  noteFilesGetDefaultPath(): Promise<string>;
  noteFilesPickFolder(): Promise<PickFolderResult>;
  showNoteFile(noteId: number): Promise<{ success: boolean }>;
  showFolderInExplorer(folderName: string): Promise<{ success: boolean }>;
  granolaImportPickAndPreview(): Promise<GranolaPreviewResult>;
  granolaImportRun(): Promise<GranolaRunResult>;
}
