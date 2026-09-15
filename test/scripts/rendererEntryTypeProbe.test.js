// Scoped strict enforcement for the renderer entrypoints. The global renderer
// tsconfig stays non-strict until the legacy TSX catches up, so this probe
// compiles the entrypoint program under strict (tsconfig.renderer-entrypoints)
// and requires the two entrypoint FILES themselves to be diagnostics-free.
// Strict errors inside legacy imported modules are explicitly out of scope
// here; they are neither hidden nor fixed by this boundary.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");
const configPath = path.join(root, "tsconfig.renderer-entrypoints.json");
const ENTRYPOINTS = [path.join(root, "src/main.tsx"), path.join(root, "src/AppRouter.tsx")];

function parseConfig() {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsed.options.strict, true, "the entrypoint scope must stay strict");
  return parsed;
}

function entrypointDiagnostics({ patch } = {}) {
  const parsed = parseConfig();
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...args) => {
    if (patch && patch.file === file) {
      return ts.createSourceFile(file, patch.source, languageVersion, true);
    }
    return readSource(file, languageVersion, ...args);
  };
  const program = ts.createProgram(ENTRYPOINTS, { ...parsed.options, noEmit: true }, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => {
      const file = diagnostic.file?.fileName;
      return file && ENTRYPOINTS.includes(path.resolve(file));
    })
    .map((diagnostic) => ({
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    }));
}

test("the renderer entrypoints are strict-clean themselves", () => {
  assert.deepEqual(entrypointDiagnostics(), []);
});

test("a strict violation inside an entrypoint is reported", () => {
  const victim = path.join(root, "src/AppRouter.tsx");
  const diagnostics = entrypointDiagnostics({
    patch: {
      file: victim,
      source: `${fs.readFileSync(victim, "utf8")}\nconst broken: number = "not a number";\n`,
    },
  });
  assert.ok(
    diagnostics.some((diagnostic) => diagnostic.code === 2322),
    `expected TS2322, got ${JSON.stringify(diagnostics.map((d) => d.code))}`
  );
});
