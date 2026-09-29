const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const appDir = path.resolve(__dirname, "..");
const DISPLAY_NAME = "Gristmill Dev";

// The stock Electron.app shows the Electron logo in the Dock, Cmd+Tab and
// permission dialogs: dock.setIcon only covers the Dock and macOS ignores it
// there after the icon is hidden and shown again. Run dev from a cached copy of
// the bundle carrying the dev icon and name instead. The bundle identifier is
// kept, so existing dev TCC permissions still apply.
function prepareDevBundle(binary) {
  const source = path.resolve(binary, "../../..");
  if (!source.endsWith(".app")) return binary;
  const icon = path.join(appDir, "src", "assets", "iconDev.icns");
  const stamp = crypto
    .createHash("sha256")
    .update(source)
    .update(fs.readFileSync(icon))
    .update(fs.readFileSync(path.join(source, "Contents", "Info.plist")))
    .digest("hex");
  const cacheDir = path.join(appDir, "node_modules", ".cache", "gristmill-dev");
  const target = path.join(cacheDir, `${DISPLAY_NAME}.app`);
  const stampFile = path.join(cacheDir, "stamp");
  const targetBinary = path.join(target, path.relative(source, binary));
  if (fs.existsSync(stampFile) && fs.readFileSync(stampFile, "utf8") === stamp && fs.existsSync(targetBinary)) {
    return targetBinary;
  }
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  execFileSync("/bin/cp", ["-cR", source, target]);
  const plist = path.join(target, "Contents", "Info.plist");
  const iconFile = execFileSync("/usr/bin/plutil", ["-extract", "CFBundleIconFile", "raw", plist], {
    encoding: "utf8",
  }).trim();
  const iconName = iconFile.endsWith(".icns") ? iconFile : `${iconFile}.icns`;
  fs.copyFileSync(icon, path.join(target, "Contents", "Resources", iconName));
  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    execFileSync("/usr/bin/plutil", ["-replace", key, "-string", DISPLAY_NAME, plist]);
  }
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", target], { stdio: "ignore" });
  fs.writeFileSync(stampFile, stamp);
  return targetBinary;
}

module.exports = { prepareDevBundle };
