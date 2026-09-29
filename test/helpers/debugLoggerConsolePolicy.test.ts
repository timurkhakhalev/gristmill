const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const Module = require("node:module");

const loggerPath = require.resolve("../../src/helpers/debugLogger.ts");
const dragManagerPath = require.resolve("../../src/helpers/dragManager.ts");
const originalLoad = Module._load;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

interface RuntimeOverrides { platform: string; argv?: string[]; env?: Record<string, string>; electron: unknown }
function withRuntime({ platform, argv = [], env = {}, electron }: RuntimeOverrides, loadModule: () => unknown) {
  const previousArgv = process.argv;
  const previousEnvironment = {
    LOG_LEVEL: process.env.LOG_LEVEL,
    NODE_ENV: process.env.NODE_ENV,
    OPENHERCULES_LOG_LEVEL: process.env.OPENHERCULES_LOG_LEVEL,
  };

  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  process.argv = ["node", "main.js", ...argv];
  delete process.env.LOG_LEVEL;
  delete process.env.NODE_ENV;
  delete process.env.OPENHERCULES_LOG_LEVEL;
  Object.assign(process.env, env);

  Module._load = function loadWithElectronMock(request: string, parent: unknown, isMain: boolean) {
    if (request === "electron") return electron;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return loadModule();
  } finally {
    Module._load = originalLoad;
    Object.defineProperty(process, "platform", originalPlatform as PropertyDescriptor);
    process.argv = previousArgv;
    delete process.env.LOG_LEVEL;
    delete process.env.NODE_ENV;
    delete process.env.OPENHERCULES_LOG_LEVEL;
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value !== undefined) process.env[name] = value;
    }
  }
}

function loadLogger({
  platform,
  isPackaged,
  argv,
  env,
  isReady = false,
  userDataPath = os.tmpdir(),
}: { platform: string; isPackaged: boolean; argv?: string[]; env?: Record<string, string>; isReady?: boolean; userDataPath?: string }) {
  delete require.cache[loggerPath];
  return withRuntime(
    {
      platform,
      argv,
      env,
      electron: {
        app: {
          getAppPath: () => "/openwhispr",
          getPath: () => userDataPath,
          getVersion: () => "9.9.9-test",
          isPackaged,
          isReady: () => isReady,
        },
      },
    },
    () => require(loggerPath)
  );
}

async function captureConsole(run: () => Promise<void> | void) {
  const calls: unknown[] = [];
  const originalConsole = {
    error: console.error,
    log: console.log,
    warn: console.warn,
  };

  console.error = (...args: unknown[]) => { calls.push(["error", ...args]); };
  console.log = (...args: unknown[]) => { calls.push(["log", ...args]); };
  console.warn = (...args: unknown[]) => { calls.push(["warn", ...args]); };
  try {
    await run();
  } finally {
    Object.assign(console, originalConsole);
  }
  return calls;
}

type LoggerUnderTest = { logStream: { once: (e: string, cb: (e: Error) => void) => void; end: (cb: () => void) => void } | null; logStream2?: never } & { [k: string]: any };
async function closeLogStream(logger: LoggerUnderTest) {
  if (!logger.logStream) return;
  const logStream = logger.logStream;
  logger.logStream = null;
  await new Promise<void>((resolve, reject) => {
    logStream.once("error", reject);
    logStream.end(() => resolve());
  });
}

test(
  "packaged Windows suppresses main and renderer console logging at the default level",
  async () => {
    const logger = loadLogger({ platform: "win32", isPackaged: true }) as LoggerUnderTest;

    const calls = await captureConsole(() => {
      logger.info("Recording started", { microphone: "Default" }, "audio");
      logger.warn("Recording warning");
      logger.error("Recording failure");
      logger.logEntry({
        level: "info",
        message: "Pipeline timing",
        meta: { roundTripDurationMs: 42 },
        scope: "performance",
        source: "renderer",
      });
    });

    assert.deepEqual(calls, []);
    assert.equal(logger.getLogPath(), null, "default INFO logging remains non-persistent");
  }
);

test("log-level settings never opt a packaged Windows build into console logging", async (t: import("node:test").TestContext) => {
  const cases: Array<{ name: string; argv?: string[]; env?: Record<string, string> }> = [
    { name: "--log-level", argv: ["--log-level=debug"] },
    {
      name: "OPENHERCULES_LOG_LEVEL=debug",
      env: { OPENHERCULES_LOG_LEVEL: "debug" },
    },
    {
      name: "OPENHERCULES_LOG_LEVEL=info",
      env: { OPENHERCULES_LOG_LEVEL: "info" },
    },
    { name: "LOG_LEVEL", env: { LOG_LEVEL: "debug" } },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const logger = loadLogger({
        platform: "win32",
        isPackaged: true,
        argv: testCase.argv,
        env: testCase.env,
      }) as LoggerUnderTest;

      const calls = await captureConsole(() => logger.info("Configured log level"));

      assert.deepEqual(calls, []);
    });
  }
});

test("--console-logs explicitly enables console logging in packaged Windows", async () => {
  const logger = loadLogger({
    platform: "win32",
    isPackaged: true,
    argv: ["--console-logs"],
  }) as LoggerUnderTest;

  const calls = await captureConsole(() => logger.info("Console diagnostics enabled"));

  assert.deepEqual(calls, [["log", "[INFO] Console diagnostics enabled"]]);
});

test("development and non-Windows packaged builds preserve console logging", async (t: import("node:test").TestContext) => {
  const cases = [
    { name: "Windows development", platform: "win32", isPackaged: false },
    { name: "packaged macOS", platform: "darwin", isPackaged: true },
    { name: "packaged Linux", platform: "linux", isPackaged: true },
  ];

  for (const testCase of cases as Array<{ name: string; platform: string; isPackaged: boolean }>) {
    await t.test(testCase.name, async () => {
      const logger = loadLogger(testCase) as LoggerUnderTest;

      const calls = await captureConsole(() => logger.info("Existing console behavior"));

      assert.deepEqual(calls, [["log", "[INFO] Existing console behavior"]]);
    });
  }
});

test(
  "packaged Windows retains debug logs in the file sink while suppressing the console",
  async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-debug-logger-"));
    const logger = loadLogger({
      platform: "win32",
      isPackaged: true,
      env: { OPENHERCULES_LOG_LEVEL: "debug" },
      isReady: true,
      userDataPath,
    }) as LoggerUnderTest;

    try {
      const calls = await captureConsole(() => {
        logger.logEntry({
          level: "info",
          message: "Pipeline timing",
          scope: "performance",
          source: "renderer",
        });
      });
      const logPath = logger.getLogPath();
      await closeLogStream(logger);

      assert.deepEqual(calls, []);
      assert.ok(logPath);
      assert.match(
        fs.readFileSync(logPath, "utf8"),
        /\[INFO\]\[performance\]\[renderer\] Pipeline timing/
      );
    } finally {
      await closeLogStream(logger);
      fs.rmSync(userDataPath, { recursive: true, force: true });
    }
  }
);

test("production persists capture errors with a bounded rotated file while debug logging stays off", () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-error-log-"));
  const logger = loadLogger({
    platform: "win32",
    isPackaged: true,
    isReady: true,
    userDataPath,
  }) as LoggerUnderTest;
  const active = path.join(userDataPath, "logs", "capture-errors.log");
  const previous = path.join(userDataPath, "logs", "capture-errors.1.log");

  try {
    logger.info("Normal activity is not persisted");
    assert.equal(fs.existsSync(active), false);
    logger.error("Unrelated error is not persisted");
    assert.equal(fs.existsSync(active), false);
    logger.logEntry({ level: "error", message: "capture-queue-overflow", scope: "meeting-capture", source: "renderer" });
    assert.match(fs.readFileSync(active, "utf8"), /\[ERROR\]\[meeting-capture\]\[renderer\] capture-queue-overflow/);
    assert.match(fs.readFileSync(active, "utf8"), /9\.9\.9-test/);
    assert.equal(logger.getLogPath(), null);

    logger.logEntry({ level: "error", message: "x".repeat(2_000_000), scope: "meeting-capture" });
    assert.ok(fs.statSync(active).size <= 16 * 1024 * 2);

    const payload = "x".repeat(12_000);
    for (let i = 0; i < 200; i += 1) {
      logger.logEntry({ level: "error", message: `recording failure ${i} ${payload}`, scope: "meeting-capture" });
    }

    assert.ok(fs.existsSync(previous));
    assert.ok(fs.statSync(active).size <= 1024 * 1024);
    assert.ok(fs.statSync(previous).size <= 1024 * 1024);
    assert.match(fs.readFileSync(active, "utf8"), /recording failure 199/);
    assert.doesNotMatch(fs.readFileSync(previous, "utf8"), /capture-queue-overflow/);
  } finally {
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});

test("routine window-drag activity obeys the packaged Windows console policy", async () => {
  delete require.cache[loggerPath];
  delete require.cache[dragManagerPath];
  const DragManager = withRuntime(
    {
      platform: "win32",
      electron: {
        app: {
          getAppPath: () => "/openwhispr",
          getPath: () => os.tmpdir(),
          isPackaged: true,
          isReady: () => false,
        },
        screen: {
          getCursorScreenPoint: () => ({ x: 120, y: 80 }),
        },
      },
    },
    () => require(dragManagerPath)
  );
  const dragManager = new (DragManager as new () => { setTargetWindow: (w: unknown) => void; startWindowDrag: () => void; stopWindowDrag: () => void });
  dragManager.setTargetWindow({
    getPosition: () => [100, 50],
    isDestroyed: () => false,
  });

  const calls = await captureConsole(async () => {
    assert.deepEqual(await dragManager.startWindowDrag(), { success: true });
    assert.deepEqual(await dragManager.stopWindowDrag(), { success: true });
  });

  assert.deepEqual(calls, []);
});
