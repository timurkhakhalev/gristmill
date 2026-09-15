// Renderer-facing note-files bridge: markdown mirror controls, reveal
// operations and the Granola import preview/run. The import result never
// carries file paths. The sandboxed preload can't require local modules, so
// build-main.js bundles the final preload with esbuild before packaging.
import {
  noteFilesChannels,
  commandResultSchema,
  pickFolderResultSchema,
  granolaPreviewResultSchema,
  granolaRunResultSchema,
  type NoteFilesApi,
  type NoteFilesCommandResult,
  type NoteFilesSetEnabledOptions,
  type PickFolderResult,
  type GranolaPreviewResult,
  type GranolaRunResult,
} from "../contracts/noteFiles.js";
import { z, type ZodType } from "zod";

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

function parseResult<T>(schema: ZodType<T>, raw: unknown, channel: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Unexpected response shape from ${channel}`);
  }
  return result.data;
}

const showResultSchema = z.object({ success: z.boolean() });

// The return type is the shared NoteFilesApi, so any drift between this
// implementation and the contract fails compilation.
export function createNoteFilesBridge(ipcRenderer: IpcRendererLike): NoteFilesApi {
  return {
    noteFilesSetEnabled: (
      enabled: boolean,
      customPath?: string,
      options?: NoteFilesSetEnabledOptions
    ): Promise<NoteFilesCommandResult> =>
      ipcRenderer
        .invoke(noteFilesChannels.noteFilesSetEnabled, enabled, customPath, options)
        .then((raw) => parseResult(commandResultSchema, raw, noteFilesChannels.noteFilesSetEnabled)),

    noteFilesSetPath: (path: string): Promise<NoteFilesCommandResult> =>
      ipcRenderer
        .invoke(noteFilesChannels.noteFilesSetPath, path)
        .then((raw) => parseResult(commandResultSchema, raw, noteFilesChannels.noteFilesSetPath)),

    noteFilesRebuild: (): Promise<NoteFilesCommandResult> =>
      ipcRenderer
        .invoke(noteFilesChannels.noteFilesRebuild)
        .then((raw) => parseResult(commandResultSchema, raw, noteFilesChannels.noteFilesRebuild)),

    noteFilesGetDefaultPath: (): Promise<string> =>
      ipcRenderer.invoke(noteFilesChannels.noteFilesGetDefaultPath).then((raw) => {
        if (typeof raw !== "string") {
          throw new Error(
            `Unexpected response shape from ${noteFilesChannels.noteFilesGetDefaultPath}`
          );
        }
        return raw;
      }),

    noteFilesPickFolder: (): Promise<PickFolderResult> =>
      ipcRenderer
        .invoke(noteFilesChannels.noteFilesPickFolder)
        .then((raw) => parseResult(pickFolderResultSchema, raw, noteFilesChannels.noteFilesPickFolder)),

    showNoteFile: (noteId: number): Promise<{ success: boolean }> =>
      ipcRenderer
        .invoke(noteFilesChannels.showNoteFile, noteId)
        .then((raw) => parseResult(showResultSchema, raw, noteFilesChannels.showNoteFile)),

    showFolderInExplorer: (folderName: string): Promise<{ success: boolean }> =>
      ipcRenderer
        .invoke(noteFilesChannels.showFolderInExplorer, folderName)
        .then((raw) =>
          parseResult(showResultSchema, raw, noteFilesChannels.showFolderInExplorer)
        ),

    granolaImportPickAndPreview: (): Promise<GranolaPreviewResult> =>
      ipcRenderer.invoke(noteFilesChannels.granolaImportPickAndPreview).then((raw) =>
        parseResult(
          granolaPreviewResultSchema,
          raw,
          noteFilesChannels.granolaImportPickAndPreview
        )
      ),

    granolaImportRun: (): Promise<GranolaRunResult> =>
      ipcRenderer
        .invoke(noteFilesChannels.granolaImportRun)
        .then((raw) => parseResult(granolaRunResultSchema, raw, noteFilesChannels.granolaImportRun)),
  };
}

