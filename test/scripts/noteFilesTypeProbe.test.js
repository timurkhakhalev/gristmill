// Strict compiler probes for the note-files/CLI vertical: the contract
// schemas and narrow dependency surfaces must reject wrong usage. Diagnostic
// codes below were verified against an actual strict tsc run.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");
const configPath = path.join(root, "tsconfig.main.json");

function probeDiagnostics(source) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsed.options.strict, true);
  const probe = path.join(root, "note-files-type-probe.ts");
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...args) =>
    file === probe
      ? ts.createSourceFile(file, source, languageVersion, true)
      : readSource(file, languageVersion, ...args);
  const program = ts.createProgram([probe], { ...parsed.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  return {
    codes: diagnostics.map((d) => d.code).sort((a, b) => a - b),
    cleanup: () => {
      if (fs.existsSync(probe)) fs.rmSync(probe, { force: true });
    },
  };
}

test("wrong note-files and CLI usage fails compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { createNoteFilesBridge } from "./src/preload/noteFilesBridge.ts";
import { registerNoteFilesHandlers } from "./src/helpers/noteFilesIpcHandlers.ts";
import { CliBridge } from "./src/helpers/cliBridge.ts";
import { granolaPreviewResultSchema } from "./src/contracts/noteFiles.ts";

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
};
const bridge = createNoteFilesBridge(ipcRendererLike);

// setEnabled takes a boolean, not a string.
bridge.noteFilesSetEnabled("yes");

// Reveal takes a numeric note id.
bridge.showNoteFile("12");

// The CLI bridge takes the narrow operations object, not the whole
// IPCHandlers instance.
new CliBridge({ arbitrary: true });

// Import preview result is a discriminated union: error text is absent on
// the canceled arm.
declare const preview: ReturnType<typeof bridge.granolaImportPickAndPreview>;
async function readCanceled(): Promise<string> {
  const result = await preview;
  if (result.canceled) return result.error;
  return result.fileName;
}
void readCanceled;

// The operations surface requires databaseManager; a mirror-only wiring
// must not compile.
registerNoteFilesHandlers(
  { handle: () => {} },
  { mirror: { init: () => {}, getNotePath: () => null, getFolderPath: () => null } }
);
void granolaPreviewResultSchema;
`);
  try {
    assert.ok(codes.length > 0, "wrong usage must not compile");
    // Verified against an actual strict run: TS2345 ×3 (args/ops object),
    // TS2339 ×2 (discriminated-union arm), TS2353 (unknown ops property).
    assert.equal(codes.filter((code) => code === 2345).length, 3);
    assert.equal(codes.filter((code) => code === 2339).length, 2);
    assert.ok(codes.includes(2353), `unknown ops property must fail, got ${codes.join(",")}`);
  } finally {
    cleanup();
  }
});

test("the full note-files/CLI graph compiles under strict settings", () => {
  const { codes, cleanup } = probeDiagnostics(`
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
const cli = new CliBridge(ops);
void cli.start().then(() => cli.stop());
void getBridgeFilePath();
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
  const parsed = parseGranolaCsv("title,summary\\nT,S");
  void parsed.notes[0]?.clientNoteId;
  void parseCsv("a,b").rows[0];
  void mapHeaders(["Title"]).mapping.title;
  void normalizeDate("2026-09-15T10:00:00Z");
  void deterministicUuid("k");
  return [defaultPath, String(preview.canceled), String(run.success)].join();
}
void useAll;
`);
  try {
    assert.deepEqual(codes, []);
  } finally {
    cleanup();
  }
});
