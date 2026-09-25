const { execFileSync } = require("node:child_process");
const path = require("node:path");

if (process.platform === "darwin") {
  const executable = path.join(
    __dirname,
    "..",
    "dist-dev",
    "mac-arm64",
    "OpenHercules Dev.app",
    "Contents",
    "MacOS",
    "OpenHercules Dev"
  );
  const processes = execFileSync("ps", ["-axo", "command="], { encoding: "utf8" });
  if (processes.split("\n").some((command) => command.startsWith(executable))) {
    console.error("Close the running OpenHercules Dev.app before rebuilding dist-dev.");
    process.exit(1);
  }
}
