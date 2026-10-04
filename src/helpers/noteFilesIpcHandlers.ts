// The note-files (markdown mirror), reveal and Granola import IPC handlers,
// moved out of ipcHandlers.js. The mirror and SQLite stay the owners of note
// content; this module only validates arguments, drives the current
// operations through narrow dependencies and keeps the preview→run state
// main-side (the renderer never sends a file path across the bridge).
import path from "path";
import {
  granolaPreviewResultSchema,
  granolaRunResultSchema,
  noteFilesChannels,
  noteFilesSetEnabledArgsSchema,
  noteFilesSetPathArgsSchema,
  pickFolderResultSchema,
  showFolderInExplorerArgsSchema,
  showNoteFileArgsSchema,
  type GranolaParsedNote,
  type GranolaPreviewResult,
  type GranolaRunResult,
  type NoteFilesCommandResult,
  type PickFolderResult,
} from "../contracts/noteFiles.js";

type IpcEventListener = (event: unknown, ...args: unknown[]) => unknown;

export interface MarkdownMirrorLike {
  init(basePath: string): void;
  getNotePath(noteId: number): string | null;
  getFolderPath(folderName: string): string | null;
}

export interface GranolaImportState {
  notes: GranolaParsedNote[];
}

export interface NoteFilesHandlerDeps {
  mirror: MarkdownMirrorLike;
  getDefaultNotesPath(): string;
  setNoteFilesEnabled(enabled: boolean): void;
  isNoteFilesEnabled(): boolean;
  rebuildMirror(basePath?: string): void;
  showItemInFolder(filePath: string): void;
  openPath(targetPath: string): Promise<string>;
  pickFolder(): Promise<PickFolderResult>;
  // Granola chunks large exports into numbered files (…-000.csv, -001, …),
  // so the pick is multi-select and returns the whole sorted set. The dialog
  // is parented to the sender's window so it opens as a sheet on settings.
  pickGranolaCsvFiles(event: unknown): Promise<{ canceled: boolean; filePaths: string[] }>;
  readFileUtf8(filePath: string): string;
  fileSize(filePath: string): number;
  importNotes(notes: GranolaParsedNote[]): {
    imported: number;
    skipped: number;
    errors: Array<{ error: string }>;
  };
  granolaState: { pending: GranolaImportState | null };
  logError(message: string, data?: unknown, tag?: string): void;
}

const MAX_IMPORT_BYTES = 200 * 1024 * 1024;

interface GranolaParser {
  parseGranolaCsv(
    text: unknown,
    options?: { allocateNoteKey?: () => string }
  ): {
    ok: boolean;
    error?: { code: string };
    notes: GranolaParsedNote[];
    warnings: Array<{ row?: number }>;
  };
  createGranolaNoteKeyAllocator(): () => string;
}

export function registerNoteFilesHandlers(
  ipcMain: { handle(channel: string, listener: IpcEventListener): void },
  deps: NoteFilesHandlerDeps
): void {
  ipcMain.handle(
    noteFilesChannels.noteFilesSetEnabled,
    async (_event, ...args: unknown[]): Promise<NoteFilesCommandResult> => {
      const parsed = noteFilesSetEnabledArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { success: false, error: "Invalid note-files request" };
      }
      const [enabled, customPath, options] = parsed.data;
      try {
        deps.setNoteFilesEnabled(false);
        if (!enabled) return { success: true };
        const basePath = customPath || deps.getDefaultNotesPath();
        if (options?.skipRebuild) {
          deps.mirror.init(basePath);
        } else {
          deps.rebuildMirror(basePath);
        }
        deps.setNoteFilesEnabled(true);
        return { success: true };
      } catch (error) {
        deps.setNoteFilesEnabled(false);
        deps.logError("Failed to set note-files enabled", { error: (error as Error).message }, "note-files");
        return { success: false, error: (error as Error).message };
      }
    }
  );

  ipcMain.handle(
    noteFilesChannels.noteFilesSetPath,
    async (_event, ...args: unknown[]): Promise<NoteFilesCommandResult> => {
      const parsed = noteFilesSetPathArgsSchema.safeParse(args);
      if (!parsed.success) {
        return { success: false, error: "Invalid note-files path" };
      }
      try {
        if (!deps.isNoteFilesEnabled()) return { success: false, error: "Note files not enabled" };
        deps.rebuildMirror(parsed.data[0]);
        return { success: true };
      } catch (error) {
        deps.setNoteFilesEnabled(false);
        deps.logError("Failed to set note-files path", { error: (error as Error).message }, "note-files");
        return { success: false, error: (error as Error).message };
      }
    }
  );

  ipcMain.handle(noteFilesChannels.noteFilesRebuild, async (): Promise<NoteFilesCommandResult> => {
    try {
      if (!deps.isNoteFilesEnabled()) return { success: false, error: "Note files not enabled" };
      deps.rebuildMirror();
      return { success: true };
    } catch (error) {
      deps.setNoteFilesEnabled(false);
      deps.logError("Failed to rebuild note files", { error: (error as Error).message }, "note-files");
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(noteFilesChannels.noteFilesGetDefaultPath, async (): Promise<string> =>
    deps.getDefaultNotesPath()
  );

  ipcMain.handle(noteFilesChannels.showNoteFile, async (_event, ...args: unknown[]): Promise<{ success: boolean }> => {
    const parsed = showNoteFileArgsSchema.safeParse(args);
    if (!parsed.success) return { success: false };
    try {
      const filePath = deps.mirror.getNotePath(parsed.data[0]);
      if (!filePath) return { success: false };
      deps.showItemInFolder(filePath);
      return { success: true };
    } catch (error) {
      deps.logError(
        "Failed to show note file",
        { noteId: (args as number[])[0], error: (error as Error).message },
        "note-files"
      );
      return { success: false };
    }
  });

  ipcMain.handle(noteFilesChannels.showFolderInExplorer, async (_event, ...args: unknown[]): Promise<{ success: boolean }> => {
    const parsed = showFolderInExplorerArgsSchema.safeParse(args);
    if (!parsed.success) return { success: false };
    try {
      const dirPath = deps.mirror.getFolderPath(parsed.data[0]);
      if (!dirPath) return { success: false };
      await deps.openPath(dirPath);
      return { success: true };
    } catch (error) {
      deps.logError(
        "Failed to show folder",
        { folderName: (args as string[])[0], error: (error as Error).message },
        "note-files"
      );
      return { success: false };
    }
  });

  ipcMain.handle(noteFilesChannels.noteFilesPickFolder, async (): Promise<PickFolderResult> => {
    try {
      return await deps.pickFolder();
    } catch (error) {
      deps.logError("Failed to pick folder", { error: (error as Error).message }, "note-files");
      return { canceled: true };
    }
  });

  ipcMain.handle(
    noteFilesChannels.granolaImportPickAndPreview,
    async (event): Promise<GranolaPreviewResult> => {
      try {
        const result = await deps.pickGranolaCsvFiles(event);
        if (result.canceled || !result.filePaths.length) {
          return { canceled: true };
        }
        const filePaths = [...result.filePaths].sort();
        // The parser module is loaded lazily like the JS handler did.
        const parser = (await import("./granolaImport.js")) as unknown as GranolaParser;
        const allocateNoteKey = parser.createGranolaNoteKeyAllocator();
        const notes: GranolaParsedNote[] = [];
        const seenSourceFiles = new Set<string>();
        let rowIssueCount = 0;
        for (const filePath of filePaths) {
          if (deps.fileSize(filePath) > MAX_IMPORT_BYTES) {
            return { canceled: false, success: false, error: "FILE_TOO_LARGE" };
          }
          const parsed = parser.parseGranolaCsv(deps.readFileUtf8(filePath), {
            allocateNoteKey,
          });
          if (!parsed.ok) {
            return { canceled: false, success: false, error: parsed.error?.code ?? "READ_FAILED" };
          }
          // File-level warnings (e.g. ignored columns) are expected on every
          // real export; only row-scoped problems belong in the issue count.
          rowIssueCount += parsed.warnings.filter((warning) => warning.row != null).length;
          for (const note of parsed.notes) {
            // Granola's source key is deterministic and local. It is enough
            // to avoid showing the same row twice when a chunked export is
            // selected twice, without consulting a server identity column.
            const sourceFile = typeof note.sourceFile === "string" ? note.sourceFile : null;
            if (!sourceFile || !seenSourceFiles.has(sourceFile)) {
              if (sourceFile) seenSourceFiles.add(sourceFile);
              notes.push(note);
            }
          }
        }
        // The run handler only ever imports what this preview parsed — the
        // renderer never sends a file path across the bridge.
        deps.granolaState.pending = { notes };
        const preview: GranolaPreviewResult = {
          canceled: false,
          success: true,
          fileName: filePaths.map((p) => path.basename(p)).join(", "),
          total: notes.length,
          newCount: notes.length,
          duplicateCount: 0,
          sampleTitles: notes.slice(0, 5).map((n) => n.title),
          rowIssueCount,
        };
        granolaPreviewResultSchema.parse(preview);
        return preview;
      } catch (error) {
        deps.logError("Granola import preview failed", { error: (error as Error).message }, "granola-import");
        return { canceled: false, success: false, error: "READ_FAILED" };
      }
    }
  );

  ipcMain.handle(noteFilesChannels.granolaImportRun, async (): Promise<GranolaRunResult> => {
    const pending = deps.granolaState.pending;
    deps.granolaState.pending = null;
    if (!pending) return { success: false, error: "NO_PENDING_IMPORT" };
    try {
      const result = deps.importNotes(pending.notes);
      if (result.imported > 0 && deps.isNoteFilesEnabled()) {
        try {
          deps.rebuildMirror();
        } catch (error) {
          // SQLite already committed the import. Report the projection failure
          // alongside its counts instead of reporting that the import failed.
          const message = (error as Error).message;
          deps.logError("Note mirror failed after Granola import", { error: message }, "note-files");
          result.errors.push({ error: `Note files mirror: ${message}` });
        }
      }
      const run: GranolaRunResult = {
        success: true,
        imported: result.imported,
        skipped: result.skipped,
        errors: result.errors,
      };
      granolaRunResultSchema.parse(run);
      return run;
    } catch (error) {
      deps.logError("Granola import failed", { error: (error as Error).message }, "granola-import");
      return { success: false, error: "IMPORT_FAILED" };
    }
  });

  void pickFolderResultSchema;
}
