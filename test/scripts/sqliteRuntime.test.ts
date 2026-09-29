const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test") = require("node:test");
const { ensureSqliteRuntime, probeSqlite, repairSqlite } = require("../../scripts/ensure-sqlite-runtime");
const { runElectron } = require("../../scripts/run-electron");

type SpawnCall = [binary: string, args: string[], options: { env: Record<string, string | undefined>; timeout: number }];
type LaunchCall = [binary: string, args: string[], options: { env: Record<string, string | undefined> }];

const ABI_ERROR = `The module was compiled against a different Node.js version using
NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 145.`;

test("healthy SQLite runtime does not rebuild", async () => {
  let repairs = 0;
  const changed = await ensureSqliteRuntime("electron", {
    probe: () => ({ status: 0 }),
    repair: async () => { repairs += 1; },
  });
  assert.equal(changed, false);
  assert.equal(repairs, 0);
});

test("Electron probe uses the binary as Node without opening an app profile", () => {
  const calls: SpawnCall[] = [];
  const result = probeSqlite("electron", {
    electronBinary: () => "/electron",
    spawn: (...args: SpawnCall) => { calls.push(args); return { status: 0 }; },
  });
  assert.equal(result.status, 0);
  assert.equal(calls[0][0], "/electron");
  assert.equal(calls[0][1][0], "-e");
  assert.equal(calls[0][2].env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(calls[0][2].timeout, 10_000);
});

test("Electron repair targets only SQLite and ignores stale rebuild metadata", async () => {
  let options: Record<string, unknown> | undefined;
  await repairSqlite("electron", {
    loadRebuild: async () => ({ rebuild: async (value: Record<string, unknown>) => { options = value; } }),
    electronVersion: () => "41.10.5",
  });
  assert.ok(options);
  assert.equal(options.electronVersion, "41.10.5");
  assert.deepEqual(options.onlyModules, ["better-sqlite3"]);
  assert.equal(options.force, true);
  assert.equal(options.useCache, false);
  assert.equal(options.mode, "sequential");
});

test("Node repair invokes the installed prebuild tool", async () => {
  const calls: SpawnCall[] = [];
  await repairSqlite("node", {
    spawn: (...args: SpawnCall) => { calls.push(args); return { status: 0 }; },
  });
  assert.equal(calls[0][0], "pnpm");
  assert.deepEqual(calls[0][1].slice(-2), ["exec", "prebuild-install"]);
  assert.equal(calls[0][2].timeout, 120_000);
});

test("ABI mismatch repairs the requested runtime once and verifies it", async () => {
  const calls: string[] = [];
  const results = [{ status: 1, stderr: ABI_ERROR }, { status: 0 }];
  const changed = await ensureSqliteRuntime("node", {
    probe: (runtime: string) => { calls.push(`probe:${runtime}`); return results.shift(); },
    repair: async (runtime: string) => { calls.push(`repair:${runtime}`); },
    log: () => {},
  });
  assert.equal(changed, true);
  assert.deepEqual(calls, ["probe:node", "repair:node", "probe:node"]);
});

test("unrelated probe failure does not trigger a rebuild", async () => {
  let repairs = 0;
  await assert.rejects(ensureSqliteRuntime("electron", {
    probe: () => ({ status: 1, stderr: "Cannot find module 'better-sqlite3'" }),
    repair: async () => { repairs += 1; },
  }), /without an ABI mismatch/);
  assert.equal(repairs, 0);
});

test("failed repair prevents Electron launch", async () => {
  let launches = 0;
  await assert.rejects(runElectron({
    ensureRuntime: async () => { throw new Error("repair failed"); },
    spawnProcess: () => { launches += 1; },
    electronPath: "/unused/electron",
  }), /repair failed/);
  assert.equal(launches, 0);
});

test("Electron launch preserves app and CDP flags with a clean environment", async () => {
  const oldRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  const oldCdp = process.env.GRISTMILL_DEBUG_CDP;
  process.env.ELECTRON_RUN_AS_NODE = "1";
  process.env.GRISTMILL_DEBUG_CDP = "9222";
  let launch: LaunchCall | undefined;
  try {
    await runElectron({
      ensureRuntime: async () => false,
      spawnProcess: (...args: LaunchCall) => { launch = args; return {}; },
      electronPath: "/electron",
      platform: "linux",
      args: ["--user-data-dir", "/tmp/isolated"],
    });
  } finally {
    if (oldRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = oldRunAsNode;
    if (oldCdp === undefined) delete process.env.GRISTMILL_DEBUG_CDP;
    else process.env.GRISTMILL_DEBUG_CDP = oldCdp;
  }
  assert.ok(launch);
  assert.equal(launch[0], "/electron");
  assert.deepEqual(launch[1].slice(0, 2), ["--remote-debugging-port=9222", require("node:path").resolve(__dirname, "../..")]);
  assert.deepEqual(launch[1].slice(2), ["--user-data-dir", "/tmp/isolated"]);
  assert.equal(launch[2].env.ELECTRON_RUN_AS_NODE, undefined);
});

test("failed verification after repair stops instead of accepting a stale ABI", async () => {
  let repairs = 0;
  await assert.rejects(ensureSqliteRuntime("electron", {
    probe: () => ({ status: 1, stderr: ABI_ERROR }),
    repair: async () => { repairs += 1; },
    log: () => {},
  }), /still fails after repair/);
  assert.equal(repairs, 1);
});

test("macOS launch uses LaunchServices with isolated logs and preserves application arguments", async () => {
  const { EventEmitter }: typeof import("node:events") = require("node:events");
  const fs: typeof import("node:fs") = require("node:fs");
  const child = new EventEmitter();
  let launch: [binary: string, args: string[]] | undefined;
  const before = process.listenerCount("SIGINT");
  await runElectron({
    ensureRuntime: async () => false,
    spawnProcess: (...args: [string, string[]]) => { launch = args; return child; },
    electronPath: "/tmp/Electron.app/Contents/MacOS/Electron",
    platform: "darwin",
    args: ["--dev", "--user-data-dir=/tmp/isolated"],
  });
  assert.ok(launch);
  const logPath = launch[1][launch[1].indexOf("--stdout") + 1];
  try {
    assert.equal(launch[0], "/usr/bin/open");
    assert.deepEqual(launch[1].slice(0, 4), ["-n", "-W", "-a", "/tmp/Electron.app"]);
    const appArgs = launch[1].slice(launch[1].indexOf("--args") + 1);
    assert.deepEqual(appArgs.slice(0, 3), [require("node:path").resolve(__dirname, "../.."), "--dev", "--user-data-dir=/tmp/isolated"]);
    assert.match(appArgs[3], /^--gristmill-launch=gristmill-launch-/);
    assert.equal(fs.existsSync(logPath), true);
    assert.equal(process.listenerCount("SIGINT"), before + 1);
  } finally { child.emit("close", 0); }
  assert.equal(fs.existsSync(logPath), false);
  assert.equal(process.listenerCount("SIGINT"), before);
});
