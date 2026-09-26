const assert = require("node:assert/strict");
const test = require("node:test");
const { ensureSqliteRuntime, probeSqlite, repairSqlite } = require("../../scripts/ensure-sqlite-runtime");
const { runElectron } = require("../../scripts/run-electron");

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
  const calls = [];
  const result = probeSqlite("electron", {
    electronBinary: () => "/electron",
    spawn: (...args) => { calls.push(args); return { status: 0 }; },
  });
  assert.equal(result.status, 0);
  assert.equal(calls[0][0], "/electron");
  assert.equal(calls[0][1][0], "-e");
  assert.equal(calls[0][2].env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(calls[0][2].timeout, 10_000);
});

test("Electron repair targets only SQLite and ignores stale rebuild metadata", async () => {
  let options;
  await repairSqlite("electron", {
    loadRebuild: async () => ({ rebuild: async (value) => { options = value; } }),
    electronVersion: () => "41.10.5",
  });
  assert.equal(options.electronVersion, "41.10.5");
  assert.deepEqual(options.onlyModules, ["better-sqlite3"]);
  assert.equal(options.force, true);
  assert.equal(options.useCache, false);
  assert.equal(options.mode, "sequential");
});

test("Node repair invokes the installed prebuild tool", async () => {
  const calls = [];
  await repairSqlite("node", {
    spawn: (...args) => { calls.push(args); return { status: 0 }; },
  });
  assert.equal(calls[0][0], "pnpm");
  assert.deepEqual(calls[0][1].slice(-2), ["exec", "prebuild-install"]);
  assert.equal(calls[0][2].timeout, 120_000);
});

test("ABI mismatch repairs the requested runtime once and verifies it", async () => {
  const calls = [];
  const results = [{ status: 1, stderr: ABI_ERROR }, { status: 0 }];
  const changed = await ensureSqliteRuntime("node", {
    probe: (runtime) => { calls.push(`probe:${runtime}`); return results.shift(); },
    repair: async (runtime) => { calls.push(`repair:${runtime}`); },
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
  const oldCdp = process.env.OPENHERCULES_DEBUG_CDP;
  process.env.ELECTRON_RUN_AS_NODE = "1";
  process.env.OPENHERCULES_DEBUG_CDP = "9222";
  let launch;
  try {
    await runElectron({
      ensureRuntime: async () => false,
      spawnProcess: (...args) => { launch = args; return {}; },
      electronPath: "/electron",
      args: ["--user-data-dir", "/tmp/isolated"],
    });
  } finally {
    if (oldRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = oldRunAsNode;
    if (oldCdp === undefined) delete process.env.OPENHERCULES_DEBUG_CDP;
    else process.env.OPENHERCULES_DEBUG_CDP = oldCdp;
  }
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
