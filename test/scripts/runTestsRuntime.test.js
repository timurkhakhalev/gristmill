const assert = require("node:assert/strict");
const test = require("node:test");
const { runTests, runCommand } = require("../../scripts/run-tests");

function fakeRunner(extra = {}) {
  const calls = [];
  return {
    calls,
    options: {
      log: () => {},
      platform: "darwin",
      electronBinary: () => "/electron",
      nodeBinary: "/node",
      prepare: async (runtime) => { calls.push({ prepare: runtime }); },
      run: async (binary, args, env) => { calls.push({ binary, args, env: { ...env } }); return 0; },
      ...extra,
    },
  };
}

test("macOS unit selection uses Electron as Node without a main build", async () => {
  const { calls, options } = fakeRunner();
  assert.equal(await runTests(["test/utils/formatDuration.test.js"], options), 0);
  assert.deepEqual(calls[0], { prepare: "electron" });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].binary, "/electron");
  assert.equal(calls[1].env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(calls[1].env.REQUIRE_DB_TESTS, "1");
  assert.ok(calls[1].args.includes("--test-concurrency=1"));
});

test("compiled bridge selection builds once and Linux uses Node", async () => {
  const { calls, options } = fakeRunner({ platform: "linux" });
  assert.equal(await runTests(["test/helpers/notesBridge.test.js", "test/helpers/calendarBridge.test.js"], options), 0);
  assert.deepEqual(calls[0], { prepare: "node" });
  assert.equal(calls.length, 3);
  assert.equal(calls[1].binary, "pnpm");
  assert.deepEqual(calls[1].args, ["run", "build:main"]);
  assert.equal(calls[1].env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(calls[2].binary, "/node");
  assert.equal(calls[2].env.ELECTRON_RUN_AS_NODE, undefined);
});

test("listing and invalid selection never prepare dependencies or launch processes", async () => {
  const { calls, options } = fakeRunner();
  assert.equal(await runTests(["--domain", "calendar", "--list"], options), 0);
  assert.equal(await runTests(["--help"], options), 0);
  await assert.rejects(runTests(["--domain", "typo"], options));
  await assert.rejects(runTests(["test/missing.test.js"], options));
  assert.deepEqual(calls, []);
});

test("failed preparation or build prevents test execution; test status is preserved", async () => {
  const failedPrepare = fakeRunner({ prepare: async () => { throw new Error("probe failed"); } });
  await assert.rejects(runTests(["test/helpers/notesBridge.test.js"], failedPrepare.options), /probe failed/);
  assert.equal(failedPrepare.calls.length, 0);
  const commands = [];
  const failedBuild = fakeRunner({ run: async (binary) => { commands.push(binary); return 7; } });
  assert.equal(await runTests(["test/helpers/notesBridge.test.js"], failedBuild.options), 7);
  assert.deepEqual(commands, ["pnpm"]);
  const failedTests = fakeRunner({ run: async () => 3 });
  assert.equal(await runTests(["test/utils/formatDuration.test.js"], failedTests.options), 3);
});

test("real child failure and signal retain nonzero status", async () => {
  assert.equal(await runCommand(process.execPath, ["-e", "process.exit(3)"], process.env), 3);
  if (process.platform !== "win32") {
    assert.equal(await runCommand(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], process.env), 143);
  }
});
