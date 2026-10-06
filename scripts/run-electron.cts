#!/usr/bin/env node
/**
 * Wrapper script to run Electron with proper environment.
 * This unsets ELECTRON_RUN_AS_NODE which can be inherited from parent processes
 * (e.g., when running from Claude Code or other Node.js-based tools).
 */

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const { spawn } = require("child_process") as typeof import("child_process");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const { constants } = require("os") as typeof import("os");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const path = require("path") as typeof import("path");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const { ensureSqliteRuntime } =
  require("./ensure-sqlite-runtime.cts") as import("./ensure-sqlite-runtime.cts").API;

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const { launchMacElectron } =
  require("./launch-macos-electron.cts") as import("./launch-macos-electron.cts").API;

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const { prepareDevBundle } =
  require("./dev-electron-bundle.cts") as import("./dev-electron-bundle.cts").API;

// Get the app directory (parent of scripts directory)
const appDir = path.resolve(__dirname, "..");

function resolveElectronPath(): string {
  try {
    // SAFETY: outside the Electron runtime, `require("electron")` returns the
    // absolute path to the platform binary recorded by the package shim.
    return require("electron") as string;
  } catch (err) {
    console.error(
      "[run-electron] Electron is installed as an npm package, but its platform binary is missing."
    );
    console.error(
      "[run-electron] This usually means npm lifecycle scripts were skipped or the Electron download failed."
    );

    if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
      console.error(
        "[run-electron] ELECTRON_SKIP_BINARY_DOWNLOAD is set; unset it before reinstalling Electron."
      );
    }

    console.error(
      "[run-electron] Try: npm config set ignore-scripts false && npm rebuild electron"
    );
    console.error(
      "[run-electron] If that still fails, remove node_modules and run npm install again."
    );
    console.error(err instanceof Error ? err.stack : err);
    throw err;
  }
}

async function runElectron({
  ensureRuntime = ensureSqliteRuntime,
  spawnProcess = spawn,
  electronPath,
  args = process.argv.slice(2),
  platform = process.platform,
}: {
  ensureRuntime?: typeof ensureSqliteRuntime;
  spawnProcess?: typeof spawn;
  electronPath?: string;
  args?: string[];
  platform?: NodeJS.Platform;
} = {}) {
  await ensureRuntime("electron");
  let binary = electronPath || resolveElectronPath();

  if (platform === "darwin" && !electronPath && args.includes("--dev")) {
    binary = prepareDevBundle(binary);
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  // Dev-only: expose CDP when requested, while preserving app arguments.
  const chromiumFlags = env.GRISTMILL_DEBUG_CDP
    ? [`--remote-debugging-port=${env.GRISTMILL_DEBUG_CDP}`]
    : [];

  console.log("[run-electron] Starting Electron:", binary, appDir, args);

  if (platform === "darwin") {
    return launchMacElectron(binary, [...chromiumFlags, appDir, ...args], env, spawnProcess);
  }

  return spawnProcess(binary, [...chromiumFlags, appDir, ...args], {
    stdio: "inherit",
    env,
    cwd: appDir,
  });
}

const api = { runElectron };

if (require.main === module) {
  runElectron()
    .then((child) => {
      child.on("close", (code, signal) => {
        process.exit(code ?? (signal ? 128 + (constants.signals[signal] || 1) : 1));
      });
      child.on("error", (err) => {
        console.error("[run-electron] Failed to start Electron:", err);
        process.exit(1);
      });
    })
    .catch((error) => {
      console.error("[run-electron] Failed to prepare or start Electron:", error);
      process.exitCode = 1;
    });
}

module.exports = api;

export type API = typeof api;
