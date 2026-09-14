const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");
const output = path.join(root, "dist-main");
const pkg = require("../../package.json");
const builder = require("../../electron-builder.json");

test("emitted Electron graph contains every relative import and no TypeScript runtime import", () => {
  assert.ok(fs.existsSync(path.join(root, pkg.main)), "Run pnpm run build:main first");
  const files = fs
    .readdirSync(output, { recursive: true })
    .filter((name) => /\.(?:js|mjs)$/.test(name));
  assert.ok(files.length > 0);
  for (const name of files) {
    const file = path.join(output, name);
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    function visit(node) {
      let specifier;
      if (
        ts.isCallExpression(node) &&
        ((ts.isIdentifier(node.expression) && node.expression.text === "require") ||
          node.expression.kind === ts.SyntaxKind.ImportKeyword)
      )
        specifier = node.arguments[0];
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith(".")) {
        assert.doesNotMatch(specifier.text, /\.(?:ts|mts|tsx)$/, `${name}: ${specifier.text}`);
        const target = path.resolve(path.dirname(file), specifier.text);
        assert.ok(target.startsWith(output + path.sep), `${name} escapes the emitted graph`);
        assert.ok(
          [target, `${target}.js`, `${target}.json`].some((p) => fs.existsSync(p)),
          `${name}: missing ${specifier.text}`
        );
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.ok(builder.files.includes("dist-main/**/*"));
  assert.ok(!builder.files.includes("main.js"));
  assert.ok(!builder.files.includes("src/helpers/**/*"));
  assert.ok(builder.asarUnpack.includes("dist-main/src/workers/**/*"));
  assert.ok(fs.existsSync(path.join(output, "src/workers/onnxWorker.js")));
});

test("emitted preload loads with the sandbox Electron API and forwards arguments", async () => {
  let api;
  const calls = [];
  const listeners = new Map();
  vm.runInNewContext(fs.readFileSync(path.join(output, "preload.js"), "utf8"), {
    require(name) {
      assert.equal(name, "electron");
      return {
        contextBridge: {
          exposeInMainWorld: (_name, value) => {
            api = value;
          },
        },
        ipcRenderer: {
          invoke: async (...args) => {
            calls.push(args);
            return { success: true };
          },
          send() {},
          on: (channel, listener) => listeners.set(channel, listener),
          removeListener: (channel, listener) => {
            assert.equal(listeners.get(channel), listener);
            listeners.delete(channel);
          },
        },
        webUtils: { getPathForFile: () => "" },
      };
    },
    process: { platform: "darwin", versions: {} },
  });
  await api.getNote(17);
  assert.deepEqual(calls, [["db-get-note", 17]]);
  const unsubscribe = api.onMeetingTranscriptionSegment(() => {});
  const before = listeners.size;
  unsubscribe();
  assert.equal(listeners.size, before - 1);
});

test("compiled route and ESM constants load in plain Node without a TS loader", () => {
  const result = execFileSync(
    process.execPath,
    [
      "-e",
      `
    const { resolveTranscriptionRoute } = require('./dist-main/src/helpers/transcriptionRoute.js');
    console.log(JSON.stringify(resolveTranscriptionRoute({ settings: { transcriptionMode: 'local', useLocalWhisper: true } })));
  `,
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } }
  );
  assert.deepEqual(JSON.parse(result), { transport: "local" });
});

test("main compiler rejects a wrong typed argument and renderer-only globals", () => {
  const configPath = path.join(root, "tsconfig.main.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsed.options.strict, true);
  const probe = path.join(root, "main-type-probe.ts");
  const source =
    'import { byokFileSizeLimit } from "./src/helpers/transcriptionRoute.js";\nbyokFileSizeLimit(123);\ndocument.title = "not a renderer";';
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...args) =>
    file === probe
      ? ts.createSourceFile(file, source, languageVersion, true)
      : readSource(file, languageVersion, ...args);
  const program = ts.createProgram([probe], { ...parsed.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map((d) => d.code).sort(), [2345, 2584]);
});

test("emitted modules resolve preload beside code and native resources from the app root", () => {
  const config = require("../../dist-main/src/helpers/windowConfig.js");
  for (const name of ["MAIN_WINDOW_CONFIG", "CONTROL_PANEL_CONFIG", "NOTIFICATION_WINDOW_CONFIG"]) {
    assert.equal(config[name].webPreferences.preload, path.join(output, "preload.js"));
  }
  const appRoot = path.join(root, "test-app-root");
  const expected = path.join(appRoot, "resources/bin/probe");
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(output, "src/helpers/binaryResolver.js"), "utf8"), {
    module,
    __dirname: path.join(output, "src/helpers"),
    process: { resourcesPath: undefined },
    require(name) {
      if (name === "electron") return { app: { getAppPath: () => appRoot } };
      if (name === "path") return path;
      if (name === "./debugLogger") return { info() {} };
      if (name === "fs")
        return {
          existsSync: (candidate) => candidate === expected,
          accessSync: (candidate) => assert.equal(candidate, expected),
          constants: { X_OK: 1 },
        };
      throw new Error(`Unexpected module: ${name}`);
    },
  });
  assert.equal(module.exports.resolveBundledBinary("probe", "test"), expected);
});
