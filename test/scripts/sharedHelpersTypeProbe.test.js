// Strict probes for the migrated shared text/config helpers: the same TS
// source must compile under the Node CJS target (main graph settings, no DOM
// globals) and the renderer ESM target (bundler resolution + DOM lib). The
// files are pure policy — any Electron/DOM/import.meta.env dependency fails
// the Node arm. A negative probe confirms the checker actually rejects a
// strict violation inside a migrated file.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");

const SHARED_FILES = [
  "src/helpers/agentNameDictionary.ts",
  "src/helpers/builtinActions.ts",
  "src/helpers/chatRouting.ts",
  "src/helpers/dictionaryImport.ts",
  "src/helpers/dictionaryStartup.ts",
  "src/helpers/noteFormattingOverrides.ts",
  "src/helpers/regenerableNoteTitle.ts",
  "src/helpers/retentionSettings.ts",
  "src/helpers/stripThinking.ts",
  "src/helpers/transcriptFormatter.ts",
  "src/helpers/transcriptText.ts",
  "src/helpers/uploadTimestamps.ts",
  "src/config/retiredPrompts.ts",
  "src/utils/chineseScript.ts",
  "src/utils/dictionaryPromptCap.ts",
].map((file) => path.join(root, file));

function programDiagnostics(rootNames, options, { patch } = {}) {
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...args) => {
    if (patch && patch.file === file) {
      return ts.createSourceFile(file, patch.source, languageVersion, true);
    }
    return readSource(file, languageVersion, ...args);
  };
  const program = ts.createProgram(rootNames, { ...options, noEmit: true }, host);
  return ts.getPreEmitDiagnostics(program);
}

const NODE_OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2022.d.ts"],
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  esModuleInterop: true,
  skipLibCheck: true,
  resolveJsonModule: true,
  allowJs: true,
  checkJs: false,
  types: ["node"],
};

const RENDERER_OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  esModuleInterop: true,
  skipLibCheck: true,
  resolveJsonModule: true,
  allowJs: true,
  checkJs: false,
  allowImportingTsExtensions: true,
  isolatedModules: true,
};

test("shared helpers compile strict under the Node CJS target without DOM globals", () => {
  const diagnostics = programDiagnostics(SHARED_FILES, NODE_OPTIONS);
  assert.deepEqual(
    diagnostics.map((d) => `${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`).slice(0, 5),
    [],
    "Node-target strict compile must be clean (also proves no Electron/DOM imports)"
  );
});

test("shared helpers compile strict under the renderer ESM target", () => {
  const diagnostics = programDiagnostics(SHARED_FILES, RENDERER_OPTIONS);
  assert.deepEqual(
    diagnostics.map((d) => `${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`).slice(0, 5),
    [],
    "renderer-target strict compile must be clean"
  );
});

test("a strict violation inside a migrated shared file is rejected", () => {
  const victim = path.join(root, "src/helpers/stripThinking.ts");
  const patch = {
    file: victim,
    source: `${fs.readFileSync(victim, "utf8")}\nconst broken: number = "not a number";\n`,
  };
  const diagnostics = programDiagnostics([victim], NODE_OPTIONS, { patch });
  const codes = diagnostics.map((d) => d.code);
  assert.ok(codes.includes(2322), `expected TS2322, got ${codes.join(",")}`);
});
