const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const test: typeof import("node:test") = require("node:test");

const fs: typeof import("node:fs") = require("node:fs");

const os: typeof import("node:os") = require("node:os");

const path: typeof import("node:path") = require("node:path");

const { runTests, runCommand, acquireFullRunLock } = require("../../scripts/run-tests.cts");

type RunnerCall =
  | { prepare: string }
  | { binary: string; args: string[]; env: Record<string, string | undefined> };

function runCall(calls: RunnerCall[], index: number) {
  const call = calls[index];
  assert.ok(call && "binary" in call);

  return call;
}

function fakeRunner(
  extra: Partial<{
    platform: string;
    prepare: (runtime: string) => Promise<void>;
    run: (
      binary: string,
      args: string[],
      env: Record<string, string | undefined>
    ) => Promise<number>;
    lock: () => () => void;
  }> = {}
) {
  const calls: RunnerCall[] = [];

  return {
    calls,
    options: {
      log: () => {},
      platform: "darwin",
      electronBinary: () => "/electron",
      nodeBinary: "/node",
      prepare: async (runtime: string) => {
        calls.push({ prepare: runtime });
      },
      run: async (binary: string, args: string[], env: Record<string, string | undefined>) => {
        calls.push({ binary, args, env: { ...env } });

        return 0;
      },
      ...extra,
    },
  };
}

function killOwnedGroupIfPresent(pidFile: string) {
  if (!fs.existsSync(pidFile)) return;

  try {
    process.kill(-Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL");
  } catch (error) {
    if ((error as Error & { code?: string }).code !== "ESRCH") throw error;
  }
}

test("macOS unit selection uses Electron as Node without a main build", async () => {
  const { calls, options } = fakeRunner();
  assert.equal(
    await runTests(["--processes", "1", "test/utils/formatDuration.test.ts"], options),
    0
  );
  assert.deepEqual(calls[0], { prepare: "electron" });
  assert.equal(calls.length, 2);
  assert.equal(runCall(calls, 1).binary, "/electron");
  assert.equal(runCall(calls, 1).env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(runCall(calls, 1).env.REQUIRE_DB_TESTS, "1");
  assert.ok(runCall(calls, 1).args.includes("--test-concurrency=1"));
});

test("compiled bridge selection builds once and Linux uses Node", async () => {
  const { calls, options } = fakeRunner({ platform: "linux" });
  assert.equal(
    await runTests(
      ["test/helpers/notesBridge.test.ts", "test/helpers/calendarBridge.test.ts"],
      options
    ),
    0
  );
  assert.deepEqual(calls[0], { prepare: "node" });
  assert.equal(calls.length, 3);
  assert.equal(runCall(calls, 1).binary, "pnpm");
  assert.deepEqual(runCall(calls, 1).args, ["run", "build:main"]);
  assert.equal(runCall(calls, 1).env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(runCall(calls, 2).binary, "/node");
  assert.equal(runCall(calls, 2).env.ELECTRON_RUN_AS_NODE, undefined);
});

test("two processes run ordinary files before serial compiler and native files", async () => {
  const { calls, options } = fakeRunner({ platform: "linux" });

  const files = [
    "test/utils/formatDuration.test.ts",
    "test/scripts/mainBuild.test.ts",
    "test/helpers/notesBridge.test.ts",
  ];

  assert.equal(await runTests(["--processes", "2", ...files], options), 0);
  assert.deepEqual(calls[0], { prepare: "node" });
  assert.deepEqual(runCall(calls, 1).args, ["run", "build:main"]);
  assert.equal(
    runCall(calls, 2).args.find((arg) => arg.startsWith("--test-concurrency")),
    "--test-concurrency=2"
  );
  assert.equal(
    runCall(calls, 3).args.find((arg) => arg.startsWith("--test-concurrency")),
    "--test-concurrency=1"
  );
  assert.deepEqual(
    calls
      .slice(2)
      .flatMap((call) =>
        "binary" in call
          ? call.args.filter((arg) => arg.endsWith(".test.js") || arg.endsWith(".test.ts"))
          : []
      )
      .sort(),
    files.slice().sort()
  );
});

test("type probe files share one serial compiler process without changing selected domains", async () => {
  const { calls, options } = fakeRunner({ platform: "linux" });

  const files = [
    "test/scripts/type-probes/actions.test.ts",
    "test/scripts/type-probes/calendar.test.ts",
    "test/scripts/mainBuild.test.ts",
  ];

  assert.equal(await runTests(files, options), 0);
  assert.deepEqual(calls[0], { prepare: "node" });
  assert.equal(runCall(calls, 1).binary, "pnpm");
  assert.equal(runCall(calls, 2).args.includes("--test-isolation=none"), true);
  assert.deepEqual(JSON.parse(runCall(calls, 2).env.GRISTMILL_TYPE_PROBE_GROUPS!), [
    "actions",
    "calendar",
  ]);
  assert.deepEqual(
    runCall(calls, 2).args.filter((arg) => arg.endsWith(".test.js") || arg.endsWith(".test.ts")),
    files.slice(0, 2)
  );
  assert.equal(runCall(calls, 3).args.includes("--test-isolation=none"), false);
  assert.deepEqual(
    runCall(calls, 3).args.filter((arg) => arg.endsWith(".test.js") || arg.endsWith(".test.ts")),
    [files[2]]
  );
});

test("a failed parallel phase still runs serial tests and preserves failure", async () => {
  const { options } = fakeRunner({ platform: "linux" });
  let testsRun = 0;
  options.run = async (binary) => (binary === "pnpm" ? 0 : ++testsRun === 1 ? 3 : 0);
  assert.equal(
    await runTests(
      ["--processes", "2", "test/utils/formatDuration.test.ts", "test/scripts/mainBuild.test.ts"],
      options
    ),
    3
  );
  assert.equal(testsRun, 2);
});

test("full-run lock rejects another owner and releases only its own lock", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "oh-runner-lock-"));
  const file = path.join(directory, "full.lock");
  const release = acquireFullRunLock(file);

  try {
    assert.throws(() => acquireFullRunLock(file), /Another full test run owns/);
  } finally {
    release();
    acquireFullRunLock(file)();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("failed full run releases its lock", async () => {
  let released = false;

  const { options } = fakeRunner({
    lock: () => () => {
      released = true;
    },
    run: async () => 7,
  });

  assert.equal(await runTests([], options), 7);
  assert.equal(released, true);
});

test("quiet command hides success output and reveals failure output", async () => {
  const output: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    output.push(String(chunk));

    return true;
  }) as typeof process.stderr.write;

  try {
    assert.equal(
      await runCommand(
        process.execPath,
        ["-e", "console.log('quiet success')"],
        process.env,
        false
      ),
      0
    );
    assert.equal(output.join(""), "");
    assert.equal(
      await runCommand(
        process.execPath,
        ["-e", "console.error('visible failure'); process.exit(3)"],
        process.env,
        false
      ),
      3
    );
    assert.match(output.join(""), /visible failure/);
  } finally {
    process.stderr.write = write;
  }
});

test("interruption between phases releases the full-run lock", async () => {
  let released = false;
  let testPhases = 0;

  const { options } = fakeRunner({
    platform: "linux",
    lock: () => () => {
      released = true;
    },
    run: async (binary) => {
      if (binary !== "pnpm") {
        testPhases++;
        process.emit("SIGTERM");
      }

      return 0;
    },
  });

  assert.equal(await runTests(["--processes", "2"], options), 143);
  assert.equal(testPhases, 1);
  assert.equal(released, true);
});

test("termination stops an owned child and grandchild", { timeout: 5000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "oh-runner-lifecycle-"));
  const heartbeat = path.join(directory, "heartbeat");
  const ready = path.join(directory, "ready");
  const grandchild = `const fs = require('node:fs'); setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 20);`;
  const child = `const { spawn } = require('node:child_process'); const fs = require('node:fs'); spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`;

  try {
    const running = runCommand(process.execPath, ["-e", child], process.env);

    for (let i = 0; i < 200 && !fs.existsSync(heartbeat); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(fs.existsSync(heartbeat), true, "grandchild started");
    process.emit("SIGTERM");
    assert.equal(await running, 143);
    const stoppedAt = fs.statSync(heartbeat).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.statSync(heartbeat).mtimeMs, stoppedAt, "grandchild stopped");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "termination kills descendants that ignore SIGTERM before returning",
  { timeout: 6000 },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "oh-runner-stubborn-"));
    const heartbeat = path.join(directory, "heartbeat");
    const pidFile = path.join(directory, "pid");
    const grandchild = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 20);`;
    const child = `const { spawn } = require('node:child_process'); const fs = require('node:fs'); process.on('SIGTERM', () => {}); spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;

    try {
      const running = runCommand(process.execPath, ["-e", child], process.env);

      for (let i = 0; i < 200 && !fs.existsSync(heartbeat); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      assert.equal(fs.existsSync(heartbeat), true, "grandchild started");
      process.emit("SIGTERM");
      assert.equal(await running, 143);
      const stoppedAt = fs.statSync(heartbeat).mtimeMs;
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(fs.statSync(heartbeat).mtimeMs, stoppedAt, "no owned descendant remains");
    } finally {
      killOwnedGroupIfPresent(pidFile);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
);

test(
  "a normally exiting child cannot leave a TERM-ignoring grandchild",
  { timeout: 6000 },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "oh-runner-orphan-"));
    const heartbeat = path.join(directory, "heartbeat");
    const pidFile = path.join(directory, "pid");
    const grandchild = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 20);`;
    const child = `const { spawn } = require('node:child_process'); const fs = require('node:fs'); spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(heartbeat)})) { clearInterval(timer); process.exit(0); } }, 10);`;

    try {
      assert.equal(await runCommand(process.execPath, ["-e", child], process.env), 0);
      assert.equal(fs.existsSync(heartbeat), true, "grandchild started before the parent exited");
      const stoppedAt = fs.statSync(heartbeat).mtimeMs;
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(fs.statSync(heartbeat).mtimeMs, stoppedAt, "orphan was reaped before return");
    } finally {
      killOwnedGroupIfPresent(pidFile);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
);

test("listing and invalid selection never prepare dependencies or launch processes", async () => {
  const { calls, options } = fakeRunner();
  assert.equal(await runTests(["--domain", "calendar", "--list"], options), 0);
  assert.equal(await runTests(["--help"], options), 0);
  await assert.rejects(runTests(["--domain", "typo"], options));
  await assert.rejects(runTests(["test/missing.test.js"], options));
  assert.deepEqual(calls, []);
});

test("failed preparation or build prevents test execution; test status is preserved", async () => {
  const failedPrepare = fakeRunner({
    prepare: async () => {
      throw new Error("probe failed");
    },
  });

  await assert.rejects(
    runTests(["test/helpers/notesBridge.test.ts"], failedPrepare.options),
    /probe failed/
  );
  assert.equal(failedPrepare.calls.length, 0);
  const commands: string[] = [];

  const failedBuild = fakeRunner({
    run: async (binary) => {
      commands.push(binary);

      return 7;
    },
  });

  assert.equal(await runTests(["test/helpers/notesBridge.test.ts"], failedBuild.options), 7);
  assert.deepEqual(commands, ["pnpm"]);
  const failedTests = fakeRunner({ run: async () => 3 });
  assert.equal(await runTests(["test/utils/formatDuration.test.ts"], failedTests.options), 3);
});

test("real child failure and signal retain nonzero status", async () => {
  assert.equal(await runCommand(process.execPath, ["-e", "process.exit(3)"], process.env), 3);

  if (process.platform !== "win32") {
    assert.equal(
      await runCommand(
        process.execPath,
        ["-e", "process.kill(process.pid, 'SIGTERM')"],
        process.env
      ),
      143
    );
  }
});
