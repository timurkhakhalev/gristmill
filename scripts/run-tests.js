const { execFileSync, spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
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
function runCommand(binary, args, env, verbose = true) {
  return new Promise((resolve, reject) => {
    const directory = verbose ? null : fs.mkdtempSync(path.join(os.tmpdir(), "openhercules-test-"));
    const outputFile = directory && path.join(directory, "output.log");
    const outputFd = outputFile && fs.openSync(outputFile, "w");
    const child = spawn(binary, args, { cwd: root, env, stdio: verbose ? "inherit" : ["inherit", outputFd, outputFd], detached: process.platform !== "win32" });
    if (outputFd !== null) fs.closeSync(outputFd);
    const finishOutput = async (failed) => {
      if (!directory) return;
      if (failed) {
        process.stderr.write(`[test] Failed command: ${binary} ${args.join(" ")}\n`);
        await new Promise((resolve, reject) => {
          const stream = fs.createReadStream(outputFile);
          stream.on("error", reject);
          stream.on("end", resolve);
          stream.pipe(process.stderr, { end: false });
        });
      }
      fs.rmSync(directory, { recursive: true, force: true });
    };
    let requestedSignal;
    let killTimer;
    const signalGroup = (signal) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH" && error.code !== "EPERM") throw error;
      }
    };
    const groupAlive = () => {
      if (process.platform === "win32") return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH" || error.code === "EPERM") return false;
        throw error;
      }
    };
    const stop = (signal) => {
      requestedSignal = signal;
      signalGroup(signal);
      killTimer ??= setTimeout(() => signalGroup("SIGKILL"), 1000);
    };
    const interrupt = () => stop("SIGINT");
    const terminate = () => stop("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const cleanup = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      clearTimeout(killTimer);
    };
    child.once("error", async (error) => { cleanup(); try { await finishOutput(true); } finally { reject(error); } });
    child.once("close", async (code, signal) => {
      cleanup();
      try {
        if (groupAlive()) {
          if (requestedSignal !== "SIGTERM") signalGroup("SIGTERM");
          const deadline = Date.now() + 1000;
          while (groupAlive() && Date.now() < deadline) {
            await new Promise((done) => setTimeout(done, 25));
          }
          if (groupAlive()) signalGroup("SIGKILL");
          const killDeadline = Date.now() + 1000;
          while (groupAlive() && Date.now() < killDeadline) {
            await new Promise((done) => setTimeout(done, 25));
          }
          if (groupAlive()) throw new Error(`Owned process group ${child.pid} did not exit`);
        }
        const result = requestedSignal
          ? 128 + os.constants.signals[requestedSignal]
          : signal ? 128 + os.constants.signals[signal] : (code ?? 1);
        await finishOutput(result !== 0);
        resolve(result);
      } catch (error) {
        reject(error);
      }
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
    log(`Usage: pnpm test [--domain NAME ...] [--kind NAME ...] [--processes 1|2] [--list] [--verbose]\n       pnpm test -- test/path.test.ts ...\nDomains: ${DOMAINS.join(", ")}\nKinds: ${KINDS.join(", ")}\nDomains are OR; kinds are OR; domain and kind filters intersect. No filters runs all tests.`);
    return 0;
  }
  log(`[test] ${plan.tests.length} files; build:main ${plan.buildMain ? "required" : "not needed"}`);
  if (plan.options.list) {
    for (const test of plan.tests) log(`${test.file}\t${test.domains.join(",")}\t${test.kind}${test.buildMain ? "\tbuild:main" : ""}${test.serial ? "\tserial" : ""}`);
    return 0;
  }
  if (!plan.options.verbose) log("[test] Detailed output is hidden; use --verbose to show it. Output from a failed command will be shown.");
  const isFull = !plan.options.files.length && !plan.options.domains.length && !plan.options.kinds.length;
  const release = isFull ? lock() : null;
  let interrupted = 0;
  const onInterrupt = () => { interrupted = 130; };
  const onTerminate = () => { interrupted = 143; };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  const started = performance.now();
  let phaseStarted = started;
  const reportPhase = (name) => {
    const now = performance.now();
    log(`[test:timing] ${name} ${(now - phaseStarted).toFixed(0)}ms`);
    phaseStarted = now;
  };
  try {
    const runtime = platform === "darwin" ? "electron" : "node";
    await prepare(runtime);
    reportPhase("prepare");
    if (interrupted) return interrupted;
    const env = { ...process.env, REQUIRE_DB_TESTS: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    if (plan.buildMain) {
      const code = await run("pnpm", ["run", "build:main"], env, plan.options.verbose);
      reportPhase("build:main");
      if (code !== 0 || interrupted) return interrupted || code;
    }
    const binary = runtime === "electron" ? electronBinary() : nodeBinary;
    if (runtime === "electron") env.ELECTRON_RUN_AS_NODE = "1";
    const typeProbes = plan.tests.filter((test) => test.file.startsWith("test/scripts/type-probes/"));
    const otherTests = plan.tests.filter((test) => !typeProbes.includes(test));
    const phases = plan.options.processes === 1
      ? [
          { tests: otherTests, concurrency: 1 },
          { tests: typeProbes, concurrency: 1, sharedTypeProgram: true },
        ]
      : [
          { tests: otherTests.filter((test) => !test.serial && test.kind !== "types" && test.kind !== "native"), concurrency: 2 },
          { tests: typeProbes, concurrency: 1, sharedTypeProgram: true },
          { tests: otherTests.filter((test) => test.serial || test.kind === "types" || test.kind === "native"), concurrency: 1 },
        ];
    let status = 0;
    for (const [index, phase] of phases.entries()) {
      if (!phase.tests.length) continue;
      if (interrupted) break;
      const phaseEnv = phase.sharedTypeProgram
        ? { ...env, OPENHERCULES_TYPE_PROBE_GROUPS: JSON.stringify(phase.tests.map((test) => path.basename(test.file).replace(/\.test\.(js|ts)$/, ""))) }
        : env;
      const code = await run(binary, ["--import", "tsx", "--test", `--test-concurrency=${phase.concurrency}`,
        ...(phase.sharedTypeProgram ? ["--test-isolation=none"] : []), "--test-timeout=30000",
        ...phase.tests.map((test) => test.file)], phaseEnv, plan.options.verbose);
      reportPhase(`tests:${index + 1}`);
      if (code !== 0) {
        status ||= code;
        if (code === 130 || code === 143) break;
      }
      if (interrupted) break;
    }
    return interrupted || status;
  } finally {
    log(`[test:timing] total ${(performance.now() - started).toFixed(0)}ms`);
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
