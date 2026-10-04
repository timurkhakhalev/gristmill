const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const vm: typeof import("node:vm") = require("node:vm");
const { execFileSync }: typeof import("node:child_process") = require("node:child_process");
const ts: typeof import("typescript") = require("typescript");

const root = path.resolve(__dirname, "../..");
const output = path.join(root, "dist-main");
const pkg = require("../../package.json");
const builder = require("../../electron-builder.json");

test("emitted Electron graph contains every relative import and no TypeScript runtime import", () => {
  assert.ok(fs.existsSync(path.join(root, pkg.main)), "Run pnpm run build:main first");
  const files = fs
    .readdirSync(output, { recursive: true })
    .filter((name: string) => /\.(?:js|mjs)$/.test(name));
  assert.ok(files.length > 0);
  for (const name of files) {
    const file = path.join(output, name);
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    function visit(node: import("typescript").Node): void {
      let specifier: import("typescript").Expression | undefined;
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
  type PreloadApi = { getNote(id: number): Promise<unknown>; onMeetingTranscriptionSegment(callback: () => void): () => void };
  let api: PreloadApi | undefined;
  const calls: unknown[][] = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const preloadModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(output, "preload.js"), "utf8"), {
    module: preloadModule,
    exports: preloadModule.exports,
    require(name: string) {
      assert.equal(name, "electron");
      return {
        contextBridge: {
          exposeInMainWorld: (_name: string, value: PreloadApi) => {
            api = value;
          },
        },
        ipcRenderer: {
          invoke: async (...args: unknown[]) => {
            calls.push(args);
            // Notes contract: getNote resolves to a row or null.
            return args[0] === "db-get-note" ? null : { success: true };
          },
          send() {},
          on: (channel: string, listener: (...args: unknown[]) => void) => listeners.set(channel, listener),
          removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
            assert.equal(listeners.get(channel), listener);
            listeners.delete(channel);
          },
        },
        webUtils: { getPathForFile: () => "" },
      };
    },
    process: { platform: "darwin", versions: {} },
  });
  assert.ok(api);
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

test("compiled native audio and PCM modules keep their CommonJS consumer shapes", () => {
  const result = execFileSync(
    process.execPath,
    [
      "-e",
      `
    const Module = require('node:module');
    const originalLoad = Module._load;
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    Module._load = function(request, parent, isMain) {
      if (request === './debugLogger' || request === './debugLogger.js') return logger;
      if (request === 'electron') return { app: { getAppPath: () => process.cwd() } };
      return originalLoad.call(this, request, parent, isMain);
    };
    const AudioActivity = require('./dist-main/src/helpers/audioActivityDetector.js');
    const AudioTap = require('./dist-main/src/helpers/audioTapManager.js');
    const Watchdog = require('./dist-main/src/helpers/meetingSystemAudioWatchdog.js');
    const Timeline = require('./dist-main/src/helpers/meetingAudioTimeline.js');
    const SystemDefault = require('./dist-main/src/helpers/systemDefaultMicrophone.js');
    const Pcm = require('./dist-main/src/utils/audioUtils.js');
    console.log(JSON.stringify({
      direct: {
        activity: AudioActivity === AudioActivity.AudioActivityDetector,
        tap: AudioTap === AudioTap.AudioTapManager,
        watchdog: Watchdog === Watchdog.createMeetingSystemAudioWatchdog,
        timeline: Timeline === Timeline.createMeetingAudioTimeline,
      },
      named: {
        systemDefault: typeof SystemDefault.resolveSystemDefaultMicrophone === 'function',
        pcm: typeof Pcm.downsample24kTo16k === 'function' && typeof Pcm.default === 'object',
      },
    }));
  `,
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } }
  );

  assert.deepEqual(JSON.parse(result), {
    direct: {
      activity: true,
      tap: true,
      watchdog: true,
      timeline: true,
    },
    named: { systemDefault: true, pcm: true },
  });
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
    // tsc's CJS emit references the `exports` identifier directly (e.g. the
    // __esModule marker), so the sandbox needs the same binding Node provides.
    exports: module.exports,
    __dirname: path.join(output, "src/helpers"),
    process: { resourcesPath: undefined },
    require(name: string) {
      if (name === "electron") return { app: { getAppPath: () => appRoot } };
      if (name === "path") return path;
      if (name === "./debugLogger") return { info() {} };
      if (name === "fs")
        return {
          existsSync: (candidate: string) => candidate === expected,
          accessSync: (candidate: string) => assert.equal(candidate, expected),
          constants: { X_OK: 1 },
        };
      throw new Error(`Unexpected module: ${name}`);
    },
  });
  const { resolveBundledBinary } = module.exports as { resolveBundledBinary: (name: string, scope: string) => string };
  assert.equal(resolveBundledBinary("probe", "test"), expected);
});
