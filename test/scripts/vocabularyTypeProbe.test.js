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
  const probe = path.join(root, "vocabulary-type-probe.ts");
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
import { registerVocabularyHandlers } from "./src/helpers/vocabularyIpcHandlers.js";

declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };

// A database missing applyDictionaryChanges would let undo report success
// while removing nothing; the compiler must reject the registration.
registerVocabularyHandlers(ipcMain, {
  database: {
    getDictionary: () => ["unchanged"],
    setDictionary: () => ({ success: true }),
    hardDeleteDictionaryEntry: () => ({ success: true }),
    getSnippets: () => [],
    setSnippets: () => ({ success: true }),
    hardDeleteSnippet: () => ({ success: true }),
  },
  debugLogger: { debug() {} },
});
`);
  try {
    // 2741: property "database" is missing required members — the literal
    // lacks applyDictionaryChanges, so the registration must not compile.
    assert.deepEqual(codes, [2741]);
  } finally {
    cleanup();
  }
});

test("a database with the full contract compiles under strict settings", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { registerVocabularyHandlers } from "./src/helpers/vocabularyIpcHandlers.js";

declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };

registerVocabularyHandlers(ipcMain, {
  database: {
    getDictionary: () => ["Alpha"],
    setDictionary: (words) => {
      console.log(words);
      return { success: true };
    },
    applyDictionaryChanges: (changes) => {
      console.log(changes);
      return { success: true, added: 1, removed: 0 };
    },
    hardDeleteDictionaryEntry: (id) => {
      console.log(id);
      return { success: true };
    },
    getSnippets: () => [{ trigger: ";em", replacement: "ama" }],
    setSnippets: (snippets) => {
      console.log(snippets);
      return { success: true };
    },
    hardDeleteSnippet: (id) => {
      console.log(id);
      return { success: false };
    },
  },
  debugLogger: { debug() {} },
});
`);
  try {
    assert.deepEqual(codes, []);
  } finally {
    cleanup();
  }
});
