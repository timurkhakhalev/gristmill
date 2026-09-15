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
  const preloadModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(output, "preload.js"), "utf8"), {
    module: preloadModule,
    exports: preloadModule.exports,
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
            // Notes contract: getNote resolves to a row or null.
            return args[0] === "db-get-note" ? null : { success: true };
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

test("compiled realtime modules keep their CommonJS consumer shapes", () => {
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
      if (request === '../utils/audioUtils' || request === '../utils/audioUtils.js') {
        return { computePcm16Rms: () => 0 };
      }
      if (request === './tinfoilSecureClient' || request === './tinfoilSecureClient.js') {
        return { createTinfoilRealtimeSocket: async () => ({}) };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    const OpenAI = require('./dist-main/src/helpers/openaiRealtimeStreaming.js');
    const AssemblyAI = require('./dist-main/src/helpers/assemblyAiStreaming.js');
    const Deepgram = require('./dist-main/src/helpers/deepgramStreaming.js');
    const Corti = require('./dist-main/src/helpers/cortiStreaming.js');
    const Gemini = require('./dist-main/src/helpers/geminiLiveStreaming.js');
    const Tinfoil = require('./dist-main/src/helpers/tinfoilRealtimeStreaming.js');
    const tokens = require('./dist-main/src/helpers/realtimeTokenProviders.js');
    const registry = require('./dist-main/src/helpers/meetingStreamingProviders.js');

    console.log(JSON.stringify({
      direct: {
        openai: OpenAI === OpenAI.OpenAIRealtimeStreaming,
        assemblyai: AssemblyAI === AssemblyAI.AssemblyAiStreaming,
        deepgram: Deepgram === Deepgram.DeepgramStreaming,
        corti: Corti === Corti.CortiStreaming,
        deepgramStatic: typeof Deepgram.authorizationHeader === 'function',
      },
      named: {
        gemini: typeof Gemini.GeminiLiveStreaming === 'function',
        tinfoil: typeof Tinfoil.TinfoilRealtimeStreaming === 'function',
        tokenRouter: typeof tokens.fetchRealtimeTokenForProvider === 'function',
        clientRouter: typeof registry.getMeetingStreamingClient === 'function',
      },
      providers: Object.keys(registry.STREAMING_CLIENT_BY_PROVIDER),
    }));
  `,
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } }
  );

  assert.deepEqual(JSON.parse(result), {
    direct: {
      openai: true,
      assemblyai: true,
      deepgram: true,
      corti: true,
      deepgramStatic: true,
    },
    named: {
      gemini: true,
      tinfoil: true,
      tokenRouter: true,
      clientRouter: true,
    },
    providers: [
      "openai-realtime",
      "assemblyai-realtime",
      "deepgram-realtime",
      "corti-realtime",
      "tinfoil-realtime",
    ],
  });
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
    const Aec = require('./dist-main/src/helpers/meetingAecManager.js');
    const Echo = require('./dist-main/src/helpers/meetingEchoLeakDetector.js');
    const Watchdog = require('./dist-main/src/helpers/meetingSystemAudioWatchdog.js');
    const Timeline = require('./dist-main/src/helpers/meetingAudioTimeline.js');
    const SystemDefault = require('./dist-main/src/helpers/systemDefaultMicrophone.js');
    const Pcm = require('./dist-main/src/utils/audioUtils.js');
    console.log(JSON.stringify({
      direct: {
        activity: AudioActivity === AudioActivity.AudioActivityDetector,
        tap: AudioTap === AudioTap.AudioTapManager,
        aec: Aec === Aec.MeetingAecManager,
        echo: Echo === Echo.MeetingEchoLeakDetector,
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
      aec: true,
      echo: true,
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
