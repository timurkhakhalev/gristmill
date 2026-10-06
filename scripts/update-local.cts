// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const path = require("node:path") as typeof import("node:path");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const { execFileSync } = require("node:child_process") as typeof import("node:child_process");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const { installApp, assertAppStopped } =
  require("./install-macos-local.cts") as import("./install-macos-local.cts").API;

const root = path.resolve(__dirname, "..");

const installedApp = "/Applications/Gristmill.app";

interface UpdateLocalOptions {
  target?: string;
  userDataDir?: string;
}

const run = (command: string, args: string[]) => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  execFileSync(command, args, { cwd: root, env, stdio: "inherit" });
};

function updateLocal(
  { target = installedApp, userDataDir }: { target?: string; userDataDir?: string } = {},
  {
    checkStopped = assertAppStopped,
    build = () => run("pnpm", ["run", "build:mac:arm64:local"]),
    install = installApp,
    launch = (bundle: string, profile?: string) =>
      run("/usr/bin/open", [
        "-n",
        bundle,
        ...(profile ? ["--args", `--user-data-dir=${profile}`] : []),
      ]),
  } = {}
) {
  target = path.resolve(target);

  if (target !== installedApp && !userDataDir)
    throw new Error("A test destination requires --user-data-dir to isolate app data");
  checkStopped(target);
  build();
  const backup = install(path.join(root, "dist", "mac-arm64", "Gristmill.app"), target);
  launch(target, userDataDir ? path.resolve(userDataDir) : undefined);

  return { target, backup };
}

if (require.main === module) {
  try {
    if (process.platform !== "darwin" || process.arch !== "arm64")
      throw new Error("Local update requires macOS Apple Silicon");
    const args = process.argv.slice(2);
    const options: UpdateLocalOptions = {};

    while (args.length) {
      const flag = args.shift();
      const value = args.shift();

      if (!value || value.startsWith("--") || (flag !== "--target" && flag !== "--user-data-dir")) {
        throw new Error(
          "Usage: pnpm run update:local [--target /temporary/Gristmill.app --user-data-dir /temporary/profile]"
        );
      }

      if (flag === "--target") options.target = value;
      else options.userDataDir = value;
    }

    const { target, backup } = updateLocal(options);
    console.log(`Updated and launched ${target}${backup ? `; backup: ${backup}` : ""}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const api = { updateLocal };

module.exports = api;

export type API = typeof api;
