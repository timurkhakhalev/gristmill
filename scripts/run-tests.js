const { execFileSync, spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ensureSqliteRuntime } = require("./ensure-sqlite-runtime");
const { createPlan, DOMAINS, KINDS } = require("./test-selection");
const root = path.resolve(__dirname, "..");

function acquireFullRunLock(file) {
  if (!file) {
    const gitDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim();
    file = path.join(gitDir, "openhercules-full-test.lock");
  }
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() });
  try {
    fs.writeFileSync(file, owner, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`Another full test run owns ${file}: ${fs.readFileSync(file, "utf8")}. Verify its owner before removing a stale lock.`);
  }
  return () => {
    if (fs.readFileSync(file, "utf8") === owner) fs.unlinkSync(file);
  };
}

// Each command owns a process group, including children spawned by a test file.
function runCommand(binary, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: root, env, stdio: "inherit", detached: process.platform !== "win32" });
    const signalGroup = (signal) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const interrupt = () => signalGroup("SIGINT");
    const terminate = () => signalGroup("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const cleanup = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (code, signal) => {
      cleanup();
      signalGroup("SIGTERM");
      resolve(signal ? 128 + os.constants.signals[signal] : (code ?? 1));
    });
  });
}

async function runTests(args, {
  platform = process.platform,
  nodeBinary = process.execPath,
  electronBinary = () => require("electron"),
  prepare = ensureSqliteRuntime,
  run = runCommand,
  lock = acquireFullRunLock,
  log = console.log,
} = {}) {
  const plan = createPlan(args);
  if (plan.options.help) {
    log(`Usage: pnpm test [--domain NAME ...] [--kind NAME ...] [--processes 1|2] [--list]\n       pnpm test -- test/path.test.js ...\nDomains: ${DOMAINS.join(", ")}\nKinds: ${KINDS.join(", ")}\nDomains are OR; kinds are OR; domain and kind filters intersect. No filters runs all tests.`);
    return 0;
  }
  log(`[test] ${plan.tests.length} files; build:main ${plan.buildMain ? "required" : "not needed"}`);
  if (plan.options.list) {
    for (const test of plan.tests) log(`${test.file}\t${test.domains.join(",")}\t${test.kind}${test.buildMain ? "\tbuild:main" : ""}${test.serial ? "\tserial" : ""}`);
    return 0;
  }
  const isFull = !plan.options.files.length && !plan.options.domains.length && !plan.options.kinds.length;
  const release = isFull ? lock() : null;
  let interrupted = 0;
  const onInterrupt = () => { interrupted = 130; };
  const onTerminate = () => { interrupted = 143; };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    const runtime = platform === "darwin" ? "electron" : "node";
    await prepare(runtime);
    if (interrupted) return interrupted;
    const env = { ...process.env, REQUIRE_DB_TESTS: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    if (plan.buildMain) {
      const code = await run("pnpm", ["run", "build:main"], env);
      if (code !== 0 || interrupted) return interrupted || code;
    }
    const binary = runtime === "electron" ? electronBinary() : nodeBinary;
    if (runtime === "electron") env.ELECTRON_RUN_AS_NODE = "1";
    const phases = plan.options.processes === 1
      ? [{ tests: plan.tests, concurrency: 1 }]
      : [
          { tests: plan.tests.filter((test) => !test.serial && test.kind !== "types" && test.kind !== "native"), concurrency: 2 },
          { tests: plan.tests.filter((test) => test.serial || test.kind === "types" || test.kind === "native"), concurrency: 1 },
        ];
    let status = 0;
    for (const phase of phases) {
      if (!phase.tests.length) continue;
      if (interrupted) break;
      const code = await run(binary, ["--import", "tsx", "--test", `--test-concurrency=${phase.concurrency}`, "--test-timeout=30000", ...phase.tests.map((test) => test.file)], env);
      if (code !== 0) {
        status ||= code;
        if (code === 130 || code === 143) break;
      }
      if (interrupted) break;
    }
    return interrupted || status;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    release?.();
  }
}

module.exports = { runTests, runCommand, acquireFullRunLock };
if (require.main === module) {
  runTests(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[test] ${error.message}`);
    process.exitCode = 1;
  });
}
