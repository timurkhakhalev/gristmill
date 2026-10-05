// Install at one stable path; never leave a renamed .app as a backup.
const fs: typeof import("node:fs") = require("node:fs");

const path: typeof import("node:path") = require("node:path");

const { execFileSync }: typeof import("node:child_process") = require("node:child_process");

const lsregister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

const runCommand = (command: string, args: string[]) =>
  execFileSync(command, args, { encoding: "utf8" });

function assertAppStopped(target: string, run = runCommand) {
  target = path.resolve(target);

  const targets = fs.existsSync(target)
    ? new Set([target, fs.realpathSync(target)])
    : new Set([target]);

  const processes = run("/bin/ps", ["-axo", "command="]);

  if (
    processes
      .split("\n")
      .some((line) => [...targets].some((bundle) => line.startsWith(`${bundle}/Contents/`)))
  ) {
    throw new Error(
      "Quit Gristmill before installing. An active or paused recording must be saved first."
    );
  }
}

function installApp(source: string, target: string, run = runCommand) {
  source = fs.realpathSync(source);
  target = path.resolve(target);

  if (source === target) throw new Error("Source is already the installed app");
  assertAppStopped(target, run);

  const validate = (bundle: string) => {
    const id = run("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleIdentifier",
      path.join(bundle, "Contents/Info.plist"),
    ]).trim();

    if (id !== "com.khakhalev.gristmill") throw new Error("Expected the production Gristmill app");
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
  };

  validate(source);

  if (fs.existsSync(target)) validate(target);
  const staging = fs.mkdtempSync(path.join(path.dirname(target), ".gristmill-install-"));
  // No .app suffix until the bundle reaches its permanent path.
  const staged = path.join(staging, "bundle");
  const backup = path.join(path.dirname(target), ".gristmill-backup.zip");
  let replacing = false;
  let hadPrevious = false;

  try {
    run("/usr/bin/ditto", [source, staged]);
    validate(staged);
    hadPrevious = fs.existsSync(target);

    if (hadPrevious) {
      const archive = path.join(staging, "backup.zip");
      run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", target, archive]);
      run("/usr/bin/unzip", ["-tq", archive]);
      fs.renameSync(archive, backup);
    }

    replacing = true;
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staged, target);
    validate(target);
    run(lsregister, ["-f", target]);
  } catch (error) {
    if (replacing) {
      fs.rmSync(target, { recursive: true, force: true });

      if (hadPrevious) {
        run("/usr/bin/ditto", ["-x", "-k", backup, path.dirname(target)]);
        run(lsregister, ["-f", target]);
      }
    }

    throw error;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  return hadPrevious ? backup : null;
}

if (require.main === module) {
  try {
    if (process.platform !== "darwin") throw new Error("Local installation requires macOS");

    const backup = installApp(
      path.resolve(process.argv[2] || "dist/mac-arm64/Gristmill.app"),
      "/Applications/Gristmill.app"
    );

    console.log(`Installed /Applications/Gristmill.app${backup ? `; backup: ${backup}` : ""}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const api = { installApp, assertAppStopped };

module.exports = api;

export type API = typeof api;
