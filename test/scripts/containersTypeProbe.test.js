const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");
const configPath = path.join(root, "tsconfig.main.json");

// Compiles a probe source under the strict main settings and returns the TS
// diagnostic codes. Negative probes expect specific codes; positive probes
// expect none.
function probeDiagnostics(source) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsed.options.strict, true);
  const probe = path.join(root, "containers-type-probe.ts");
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

test("an incomplete database dependency fails compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { registerContainerHandlers } from "./src/helpers/containerIpcHandlers.js";

declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };

// A database missing updateSpace would leave the space channel dead while
// every folder channel keeps working; the compiler must reject the
// registration instead.
registerContainerHandlers(ipcMain, {
  database: {
    getFolders: () => [],
    createFolder: () => ({ success: true, folder: null }),
    deleteFolder: () => ({ success: true }),
    renameFolder: () => ({ success: true, folder: null }),
    moveFolderToSpace: () => ({ success: true, folder: null, notes: [] }),
    getFolderNoteCounts: () => [],
    getSpaces: () => [],
  },
  noteFilesEnabled: () => false,
  getFolderName: () => null,
  mirrorWriteNote: () => {},
  mirrorEnsureFolder: () => {},
  mirrorRenameFolder: () => {},
  mirrorDeleteFolderIfUnshared: () => {},
});
`);
  try {
    // 2741: property "database" is missing required members — the literal
    // lacks updateSpace, so the registration must not compile.
    assert.deepEqual(codes, [2741]);
  } finally {
    cleanup();
  }
});

test("wrong-shaped mirror callbacks fail compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { registerContainerHandlers } from "./src/helpers/containerIpcHandlers.js";

declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };

registerContainerHandlers(ipcMain, {
  database: {
    getFolders: () => [],
    createFolder: () => ({ success: true, folder: null }),
    deleteFolder: () => ({ success: true }),
    renameFolder: () => ({ success: true, folder: null }),
    moveFolderToSpace: () => ({ success: true, folder: null, notes: [] }),
    getFolderNoteCounts: () => [],
    getSpaces: () => [],
    updateSpace: () => ({ success: true, space: null }),
  },
  noteFilesEnabled: () => false,
  getFolderName: (id: number) => null,
  mirrorWriteNote: (note: { id: string }) => {
    console.log(note.id);
  },
  mirrorEnsureFolder: (name: string) => void name,
  mirrorRenameFolder: (oldName: string, newName: string) => void [oldName, newName],
  mirrorDeleteFolderIfUnshared: (name: string) => void name,
});
`);
  try {
    // 2322: mirrorWriteNote must accept the contract's NoteItem, not a
    // narrower local shape.
    assert.deepEqual(codes, [2322]);
  } finally {
    cleanup();
  }
});

test("a database with the full contract compiles under strict settings", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { registerContainerHandlers } from "./src/helpers/containerIpcHandlers.js";

declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };

registerContainerHandlers(ipcMain, {
  database: {
    getFolders: (spaceId) => {
      console.log(spaceId);
      return [{ id: 1, name: "F", is_default: 0, sort_order: 0, space_id: 1, created_at: "t", updated_at: "t" }];
    },
    createFolder: (name, spaceId) => {
      console.log(name, spaceId);
      return { success: true, folder: null };
    },
    deleteFolder: (id) => {
      console.log(id);
      return { success: true };
    },
    renameFolder: (id, name) => {
      console.log(id, name);
      return { success: true, folder: null };
    },
    moveFolderToSpace: (id, spaceId) => {
      console.log(id, spaceId);
      return { success: true, folder: null, notes: [] };
    },
    getFolderNoteCounts: () => [],
    getSpaces: () => [],
    updateSpace: (id, updates) => {
      console.log(id, updates);
      return { success: true, space: null };
    },
  },
  noteFilesEnabled: () => false,
  getFolderName: (folderId) => (folderId > 0 ? "F" : null),
  mirrorWriteNote: (note) => {
    console.log(note.id);
  },
  mirrorEnsureFolder: (name) => void name,
  mirrorRenameFolder: (oldName, newName) => void [oldName, newName],
  mirrorDeleteFolderIfUnshared: (name) => void name,
});
`);
  try {
    assert.deepEqual(codes, []);
  } finally {
    cleanup();
  }
});
