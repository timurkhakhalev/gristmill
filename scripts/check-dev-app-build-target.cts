// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const { execFileSync } = require("node:child_process") as typeof import("node:child_process");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const path = require("node:path") as typeof import("node:path");

if (process.platform === "darwin") {
  const executable = path.join(
    __dirname,
    "..",
    "dist-dev",
    "mac-arm64",
    "Gristmill Dev.app",
    "Contents",
    "MacOS",
    "Gristmill Dev"
  );

  const processes = execFileSync("ps", ["-axo", "command="], { encoding: "utf8" });

  if (processes.split("\n").some((command) => command.startsWith(executable))) {
    console.error("Close the running Gristmill Dev.app before rebuilding dist-dev.");
    process.exit(1);
  }
}

export type {};
