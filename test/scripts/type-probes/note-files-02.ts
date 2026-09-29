// @probe-name "the full note-files/CLI graph compiles under strict settings"
// @probe-codes []
// @probe-origin test/scripts/noteFilesTypeProbe.test.js
import { createNoteFilesBridge } from "./src/preload/noteFilesBridge.ts";
import { registerNoteFilesHandlers } from "./src/helpers/noteFilesIpcHandlers.ts";
import { CliBridge, getBridgeFilePath } from "./src/helpers/cliBridge.ts";
import type { CliBridgeOperations } from "./src/helpers/cliBridge.ts";
import { parseGranolaCsv, parseCsv, mapHeaders, normalizeDate, deterministicUuid } from "./src/helpers/granolaImport.ts";
import { AudioStorageManager } from "./src/helpers/audioStorage.ts";
import { MarkdownMirror } from "./src/helpers/markdownMirror.ts";
import { noteFilesChannels, type NoteFilesApi } from "./src/contracts/noteFiles.ts";

declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };
declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
};

const mirror = new MarkdownMirror();
registerNoteFilesHandlers(ipcMain, {
  mirror,
  getDefaultNotesPath: () => "/tmp/notes",
  setNoteFilesEnabled: (enabled: boolean) => void enabled,
  isNoteFilesEnabled: () => false,
  rebuildMirror: (basePath?: string) => void basePath,
  showItemInFolder: (filePath: string) => void filePath,
  openPath: async (dirPath: string) => dirPath,
  pickFolder: async () => ({ canceled: true }),
  pickGranolaCsvFiles: async () => ({ canceled: false, filePaths: [] }),
  readFileUtf8: () => "",
  fileSize: () => 0,
  importNotes: () => ({ imported: 0, skipped: 0, errors: [] }),
  granolaState: { pending: null },
  logError: () => {},
});

const ops: CliBridgeOperations = {
  databaseManager: {
    getNotes: () => [],
    searchNotes: () => [],
    getNote: () => null,
    saveNote: () => ({ success: false, note: null }),
    updateNote: () => ({ success: false }),
    getFolders: () => [],
    createFolder: () => ({ success: false }),
    getDictionary: () => [],
    applyDictionaryChanges: () => ({ success: true, added: 0, removed: 0 }),
    getSnippets: () => [],
    setSnippets: () => ({ success: true }),
    getTranscriptions: () => [],
    getTranscriptionById: () => null,
    updateTranscriptionAudio: () => ({ success: true }),
  },
  deleteNoteInternal: async () => ({ success: true }),
  deleteTranscriptionInternal: () => ({ success: true }),
  mirrorWriteNote: () => undefined,
  approveAudioPath: () => undefined,
  transcribeLocalFile: async () => ({ success: true, text: "t" }),
  listLocalTranscriptionModels: () => [{ model: "base", provider: "whisper", downloaded: true, default: true }],
  audioStorageManager: { deleteAudio: () => ({ success: true }) },
};
const cli = new CliBridge(ops, "/tmp");
void cli.start().then(() => cli.stop());
void getBridgeFilePath("/tmp");
void noteFilesChannels.noteFilesRebuild;

const bridge: NoteFilesApi = createNoteFilesBridge(ipcRendererLike);
async function useAll(): Promise<string> {
  await bridge.noteFilesSetEnabled(true, "/tmp/notes", { skipRebuild: true });
  await bridge.noteFilesSetPath("/tmp/notes");
  await bridge.noteFilesRebuild();
  const defaultPath: string = await bridge.noteFilesGetDefaultPath();
  await bridge.noteFilesPickFolder();
  await bridge.showNoteFile(1);
  await bridge.showFolderInExplorer("Personal");
  const preview = await bridge.granolaImportPickAndPreview();
  const run = await bridge.granolaImportRun();
  const storage = new AudioStorageManager();
  void storage.getStorageUsage();
  mirror.init("/tmp/notes");
  const parsed = parseGranolaCsv("title,summary\nT,S");
  void parsed.notes[0]?.clientNoteId;
  void parseCsv("a,b").rows[0];
  void mapHeaders(["Title"]).mapping.title;
  void normalizeDate("2026-09-15T10:00:00Z");
  void deterministicUuid("k");
  return [defaultPath, String(preview.canceled), String(run.success)].join();
}
void useAll;
