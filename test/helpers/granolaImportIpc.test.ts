const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const os: typeof import("node:os") = require("node:os");

const path: typeof import("node:path") = require("node:path");

const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");

const originalLoad = Module._load;

const handlers = new Map();

const importDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-granola-ipc-"));

const csvPaths = ["granola-000.csv", "granola-001.csv", "granola-002.csv"].map((name, index) => {
  const filePath = path.join(importDir, name);
  fs.writeFileSync(
    filePath,
    `title,summary,created_at\nSync,"Summary ${index + 1}",2026-07-15T14:30:00Z`
  );

  return filePath;
});

let selectedCsvPaths = csvPaths;

const electronStub = {
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => importDir,
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel: string, handler: unknown) => handlers.set(channel, handler),
    on: () => {},
    removeHandler: () => {},
  },
  net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }

    static fromWebContents() {
      return null;
    }
  },
  shell: {},
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: selectedCsvPaths }),
  },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

Module._load = function loadWithElectronStub(
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean
) {
  if (request === "electron") return electronStub;

  if (parent?.filename === handlersModulePath && request === "./debugLogger") {
    return new Proxy({}, { get: () => () => {} });
  }

  return originalLoad.call(this, request, parent, isMain);
};

function anything(): (...args: unknown[]) => unknown {
  return new Proxy(function () {}, {
    get: (_target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";

      if (property === "then") return undefined;

      return anything();
    },
    apply: () => anything(),
  });
}

let target: any;

test.before(() => {
  delete require.cache[handlersModulePath];

  const Ctor: typeof import("../../src/helpers/ipcHandlers.ts").IPCHandlers = require(
    handlersModulePath
  );

  target = {};
  Ctor.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );
  assert.ok(
    handlers.get("granola-import-pick-and-preview"),
    "granola preview handler must be registered"
  );
});

test.after(() => {
  Module._load = originalLoad;
  fs.rmSync(importDir, { recursive: true, force: true });
});

test("multi-file Granola preview keeps distinct local source keys across files", async () => {
  selectedCsvPaths = csvPaths;
  const result = await handlers.get("granola-import-pick-and-preview")({ sender: {} });

  assert.equal(result.success, true);
  assert.equal(result.total, 3);
  assert.equal(target._granolaImportPending.notes.length, 3);
  assert.equal(
    new Set(target._granolaImportPending.notes.map((note: any) => note.sourceFile)).size,
    3
  );
});

test("multi-file Granola preview is stable when file picker order changes", async () => {
  selectedCsvPaths = csvPaths;
  await handlers.get("granola-import-pick-and-preview")({ sender: {} });

  const firstIdsByContent = Object.fromEntries(
    target._granolaImportPending.notes
      .map((note: any) => [note.content, note.sourceFile])
      .sort(([leftContent]: [string, string], [rightContent]: [string, string]) =>
        leftContent.localeCompare(rightContent)
      )
  );

  selectedCsvPaths = [...csvPaths].reverse();
  await handlers.get("granola-import-pick-and-preview")({ sender: {} });

  const reversedIdsByContent = Object.fromEntries(
    target._granolaImportPending.notes
      .map((note: any) => [note.content, note.sourceFile])
      .sort(([leftContent]: [string, string], [rightContent]: [string, string]) =>
        leftContent.localeCompare(rightContent)
      )
  );

  assert.deepEqual(reversedIdsByContent, firstIdsByContent);
});
