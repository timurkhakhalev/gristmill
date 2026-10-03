// Issue #184: the dictionary exporter wrote newline-joined entries with no
// escaping, and the importer split on every comma and newline, so exporting an
// entry like "Acme, Inc." and importing it back produced two entries. This test
// drives the real exportDictionary IPC handler (stubbing only the save dialog),
// reads the file it writes, and feeds it through the real import parser.
const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-dictionary-round-trip-"));
let savePath = path.join(userDataDir, "dictionary.txt");
const originalLoad = Module._load;

Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
      dialog: {
        showSaveDialog: async () => ({ canceled: false, filePath: savePath }),
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const { registerTranscriptionDataHandlers }: typeof import("../../../../src/helpers/transcriptionDataIpcHandlers.ts") = require("../../../../src/helpers/transcriptionDataIpcHandlers.ts");
const { parseDictionaryImportText }: typeof import("../../../../src/helpers/dictionaryImport.ts") = require("../../../../src/helpers/dictionaryImport.ts");

function setup() {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-dictionary-round-trip-"));
  savePath = path.join(userDataDir, "dictionary.txt");
  const handlers = new Map();
  registerTranscriptionDataHandlers(
    { handle: (channel: string, fn: unknown) => handlers.set(channel, fn), on: () => {} },
    {
      database: {
        getNote: () => null,
      },
      audioStorage: {},
      deleteAllAudio: async () => ({ deleted: 0, failed: 0 }),
      deleteTranscriptionInternal: () => {},
      buildSpeakerMappings: () => ({}),
      queueNoteNavigation: async () => {},
      consumePendingNoteNavigation: () => null,
      retention: {
        getCurrentSettings: () => ({
          audioRetentionDays: 0,
          transcriptRetentionDays: 0,
          dataRetentionEnabled: false,
          localHistoryPolicyResolved: true,
        }),
        getOwner: () => null,
        hasSynced: () => true,
        onSettingsChanged: () => {},
      },
      broadcast: () => {},
      logger: { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    } as never
  );
  return { handlers };
}

test("export then import preserves entries with commas and quotes", async () => {
  const { handlers } = setup();
  const exportHandler = handlers.get("export-dictionary");
  assert.ok(exportHandler, "export-dictionary must be registered");

  const dictionary = ["Acme, Inc.", 'He said "hi"', "Alice", "Buy, sell, hold"];
  const result = await exportHandler({}, dictionary);
  assert.deepEqual(result, { success: true });

  // The real export wrote the file; the real importer must read it back whole.
  const exported = fs.readFileSync(savePath, "utf-8");
  assert.deepEqual(parseDictionaryImportText(exported), dictionary);
});

test("export of ordinary words stays a plain newline list that pastes the same", async () => {
  const { handlers } = setup();
  const exportHandler = handlers.get("export-dictionary");
  const dictionary = ["Alice", "Bob", "Carol"];
  await exportHandler({}, dictionary);
  const exported = fs.readFileSync(savePath, "utf-8");
  assert.equal(exported, "Alice\nBob\nCarol", "plain words are not quoted");
  assert.deepEqual(parseDictionaryImportText(exported), dictionary);
});

test("import dedupes and trims an exported list with duplicates", async () => {
  const { handlers } = setup();
  const exportHandler = handlers.get("export-dictionary");
  await exportHandler({}, ["Acme, Inc.", "  Acme, Inc.  ", "Alice"]);
  const exported = fs.readFileSync(savePath, "utf-8");
  // The importer trims each parsed field; the caller's addWords dedupes.
  assert.deepEqual(parseDictionaryImportText(exported), ["Acme, Inc.", "Acme, Inc.", "Alice"]);
});
