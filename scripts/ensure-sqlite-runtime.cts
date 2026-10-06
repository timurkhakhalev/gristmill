#!/usr/bin/env node
// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const { spawnSync } = require("node:child_process") as typeof import("node:child_process");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const path = require("node:path") as typeof import("node:path");

const appDir = path.resolve(__dirname, "..");

// SAFETY: outside the Electron runtime `require("electron")` returns the binary
// path recorded by the package shim, which is what the probe needs to spawn.
function resolveElectronBinary(): string {
  // SAFETY: the package shim resolves to the platform binary path.
  const binary = require("electron") as string;

  return binary;
}

// SAFETY: the installed Electron package always ships package.json with a
// string `version`; electron-builder reads the same field.
function resolveElectronVersion(): string {
  // SAFETY: electron ships package.json with a string version.
  const { version } = require("electron/package.json") as { version: string };

  return version;
}

const sqliteProbe =
  'const Database = require("better-sqlite3"); const db = new Database(":memory:"); db.close()';

function probeSqlite(
  runtime: string,
  {
    spawn = spawnSync,
    electronBinary = resolveElectronBinary,
  }: {
    spawn?: typeof spawnSync;
    electronBinary?: () => string;
  } = {}
) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const binary = runtime === "electron" ? electronBinary() : process.execPath;

  if (runtime === "electron") env.ELECTRON_RUN_AS_NODE = "1";

  return spawn(binary, ["-e", sqliteProbe], {
    cwd: appDir,
    env,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
}

function probeError(result: import("node:child_process").SpawnSyncReturns<string>) {
  return [result.stderr, result.stdout, result.error?.message].filter(Boolean).join("\n").trim();
}

function isAbiMismatch(result: import("node:child_process").SpawnSyncReturns<string>) {
  const message = probeError(result);

  return (
    /NODE_MODULE_VERSION\s+\d+/i.test(message) &&
    /different Node\.js version|requires NODE_MODULE_VERSION|module version mismatch/i.test(message)
  );
}

async function repairSqlite(
  runtime: string,
  {
    spawn = spawnSync,
    loadRebuild = () => import("@electron/rebuild"),
    electronVersion = resolveElectronVersion,
  } = {}
) {
  if (runtime === "electron") {
    const { rebuild } = await loadRebuild();
    // A Node prebuild can leave Electron's .forge-meta unchanged.
    await rebuild({
      buildPath: appDir,
      electronVersion: electronVersion(),
      platform: process.platform,
      arch: process.arch,
      onlyModules: ["better-sqlite3"],
      force: true,
      useCache: false,
      mode: "sequential",
    });

    return;
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const result = spawn(
    "pnpm",
    ["--dir", path.join(appDir, "node_modules", "better-sqlite3"), "exec", "prebuild-install"],
    { cwd: appDir, env, stdio: "inherit", timeout: 120_000 }
  );

  if (result.error || result.status !== 0) {
    throw new Error(
      `Node SQLite prebuild failed: ${result.error?.message || `exit ${result.status ?? result.signal}`}`
    );
  }
}

async function ensureSqliteRuntime(
  runtime: string,
  { probe = probeSqlite, repair = repairSqlite, log = console.log } = {}
) {
  if (runtime !== "node" && runtime !== "electron") {
    throw new Error(`Unknown SQLite runtime: ${runtime}`);
  }

  const first = probe(runtime);

  if (first.status === 0) return false;

  if (!isAbiMismatch(first)) {
    throw new Error(
      `${runtime} SQLite probe failed without an ABI mismatch: ${probeError(first) || `exit ${first.status ?? first.signal}`}`
    );
  }

  log(`[sqlite] Repairing better-sqlite3 for ${runtime} after ABI mismatch`);
  await repair(runtime);
  const second = probe(runtime);

  if (second.status !== 0) {
    throw new Error(
      `${runtime} SQLite probe still fails after repair: ${probeError(second) || `exit ${second.status ?? second.signal}`}`
    );
  }

  return true;
}

const api = { ensureSqliteRuntime, probeSqlite, repairSqlite };

if (require.main === module) {
  ensureSqliteRuntime(process.argv[2]).catch((error) => {
    console.error(`[sqlite] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = api;

export type API = typeof api;
