const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { ensureSqliteRuntime } = require("./ensure-sqlite-runtime");
const { createPlan, DOMAINS, KINDS } = require("./test-selection");
const root = path.resolve(__dirname, "..");

// Forward termination to the current child and preserve failure/signal status.
function runCommand(binary, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: root, env, stdio: "inherit" });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const cleanup = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (code, signal) => {
      cleanup();
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
  log = console.log,
} = {}) {
  const plan = createPlan(args);
  if (plan.options.help) {
    log(`Usage: pnpm test [--domain NAME ...] [--kind NAME ...] [--list]\n       pnpm test -- test/path.test.js ...\nDomains: ${DOMAINS.join(", ")}\nKinds: ${KINDS.join(", ")}\nDomains are OR; kinds are OR; domain and kind filters intersect. No filters runs all tests.`);
    return 0;
  }
  log(`[test] ${plan.tests.length} files; build:main ${plan.buildMain ? "required" : "not needed"}`);
  if (plan.options.list) {
    for (const test of plan.tests) log(`${test.file}\t${test.domains.join(",")}\t${test.kind}${test.buildMain ? "\tbuild:main" : ""}`);
    return 0;
  }
  const runtime = platform === "darwin" ? "electron" : "node";
  await prepare(runtime);
  const env = { ...process.env, REQUIRE_DB_TESTS: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  if (plan.buildMain) {
    const code = await run("pnpm", ["run", "build:main"], env);
    if (code !== 0) return code;
  }
  const binary = runtime === "electron" ? electronBinary() : nodeBinary;
  if (runtime === "electron") env.ELECTRON_RUN_AS_NODE = "1";
  return run(binary, ["--import", "tsx", "--test", "--test-concurrency=1", "--test-timeout=30000", ...plan.tests.map((test) => test.file)], env);
}

module.exports = { runTests, runCommand };
if (require.main === module) {
  runTests(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[test] ${error.message}`);
    process.exitCode = 1;
  });
}
