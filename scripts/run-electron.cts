#!/usr/bin/env node
/**
 * Wrapper script to run Electron with proper environment.
 * This unsets ELECTRON_RUN_AS_NODE which can be inherited from parent processes
 * (e.g., when running from Claude Code or other Node.js-based tools).
 */

const { spawn }: typeof import("child_process") = require("child_process");

const { constants }: typeof import("os") = require("os");

const path: typeof import("path") = require("path");

const {
  ensureSqliteRuntime,
}: import("./ensure-sqlite-runtime.cts").API = require("./ensure-sqlite-runtime.cts");

const {
  launchMacElectron,
}: import("./launch-macos-electron.cts").API = require("./launch-macos-electron.cts");

const {
  prepareDevBundle,
}: import("./dev-electron-bundle.cts").API = require("./dev-electron-bundle.cts");

// Get the app directory (parent of scripts directory)
const appDir = path.resolve(__dirname, "..");

function resolveElectronPath(): string {
  try {
    return require("electron");
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
