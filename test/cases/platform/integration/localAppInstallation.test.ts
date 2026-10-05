import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const { installApp, assertAppStopped } = require("../../../../scripts/install-macos-local.cts");

test("running-app protection resolves a symlinked bundle path", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-install-alias-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "Gristmill.app");
  const alias = path.join(root, "alias.app");
  fs.mkdirSync(target);
  fs.symlinkSync(target, alias, "dir");
  const processes = `${fs.realpathSync(target)}/Contents/MacOS/Gristmill\n`;
  assert.throws(() => assertAppStopped(alias, () => processes), /Quit Gristmill/);
  assert.doesNotThrow(() =>
    assertAppStopped(alias, () => "/unrelated/App.app/Contents/MacOS/App\n")
  );
});

test(
  "local install keeps a zip backup, rejects running apps and restores a failed replacement",
  { skip: process.platform !== "darwin" },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-install-test-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, "source/Gristmill.app");
    const target = path.join(root, "Applications/Gristmill.app");
    fs.mkdirSync(path.join(source, "Contents/MacOS"), { recursive: true });
    fs.mkdirSync(path.dirname(target));
    fs.copyFileSync("/bin/echo", path.join(source, "Contents/MacOS/Gristmill"));
    fs.writeFileSync(
      path.join(source, "Contents/Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.khakhalev.gristmill</string><key>CFBundleExecutable</key><string>Gristmill</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`
    );
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", source]);
    let running = false;
    let failRegistration = false;

    const run = (command: string, args: string[]) => {
      if (command === "/bin/ps") return running ? `${target}/Contents/MacOS/Gristmill\n` : "";

      if (command.endsWith("/lsregister")) {
        if (failRegistration) {
          failRegistration = false;
          throw new Error("registration failed");
        }

        return "";
      }

      return execFileSync(command, args, { encoding: "utf8" });
    };

    assert.equal(installApp(source, target, run), null);
    const original = fs.readFileSync(path.join(target, "Contents/MacOS/Gristmill"));
    running = true;
    assert.throws(() => installApp(source, target, run), /Quit Gristmill/);
    running = false;
    fs.mkdirSync(path.join(source, "Contents/Resources"));
    fs.writeFileSync(path.join(source, "Contents/Resources/version.txt"), "new version");
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", source]);
    failRegistration = true;
    assert.throws(() => installApp(source, target, run), /registration failed/);
    assert.deepEqual(fs.readFileSync(path.join(target, "Contents/MacOS/Gristmill")), original);
    assert.equal(fs.existsSync(path.join(target, "Contents/Resources/version.txt")), false);
    const backup = installApp(source, target, run);
    assert.ok(fs.existsSync(backup));
    assert.equal(
      fs.readFileSync(path.join(target, "Contents/Resources/version.txt"), "utf8"),
      "new version"
    );
    assert.deepEqual(fs.readdirSync(path.dirname(target)).sort(), [
      ".gristmill-backup.zip",
      "Gristmill.app",
    ]);
  }
);
