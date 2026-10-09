// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const { spawnSync } = require("node:child_process") as typeof import("node:child_process");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const fs = require("node:fs") as typeof import("node:fs");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const path = require("node:path") as typeof import("node:path");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const { buildMacosSwiftBinary } =
  require("./lib/build-macos-swift-binary.cts") as import("./lib/build-macos-swift-binary.cts").API;

// SAFETY: CJS require seam for the native build script.
const { buildMeetingResampler } =
  require("./lib/build-meeting-resampler.cts") as import("./lib/build-meeting-resampler.cts").API;

const root = path.resolve(__dirname, "..");

// Dev builds are launched from a terminal, so macOS attributes the helper's
// calendar permission request to the terminal app, which lacks calendar usage
// strings — the TCC prompt is silently aborted. The manager therefore spawns
// the helper through this shim in dev, disclaiming responsibility so the
// helper's embedded Info.plist usage strings apply. Packaged builds are
// self-responsible (usage strings via electron-builder's mac.extendInfo) and
// don't use the shim, so it is not in the electron-builder bin filter.
function buildDisclaimShim() {
  if (process.platform !== "darwin") return;

  const source = path.join(root, "resources", "macos-disclaim-exec.c");
  const output = path.join(root, "resources", "bin", "macos-disclaim-exec");

  try {
    if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs) {
      return;
    }
  } catch {
    // fall through to rebuild
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  const result = spawnSync("cc", ["-O2", "-o", output, source], { stdio: "inherit" });

  if (result.status !== 0) {
    console.warn(
      "[calendar-listener] Warning: failed to compile macos-disclaim-exec; " +
        "calendar permission prompts will not work in dev."
    );

    return;
  }

  try {
    fs.chmodSync(output, 0o755);
  } catch (error) {
    console.warn(
      `[calendar-listener] Unable to set shim permissions: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  console.log("[calendar-listener] Built macos-disclaim-exec.");
}

const helpers = {
  globe: { binaryName: "macos-globe-listener", frameworks: [] },
  mic: { binaryName: "macos-mic-listener", frameworks: ["CoreAudio", "Foundation"] },
  "meeting-ax": {
    binaryName: "macos-meeting-ax",
    frameworks: ["AppKit", "ApplicationServices", "CryptoKit"],
  },
  calendar: { binaryName: "macos-calendar-listener", frameworks: ["EventKit", "Foundation"] },
  "audio-tap": {
    binaryName: "macos-audio-tap",
    frameworks: ["CoreAudio", "AudioToolbox", "AVFoundation", "Foundation"],
  },
};

const requested = process.argv.slice(2);

if (requested.some((name) => !(name in helpers) && name !== "meeting-resampler"))
  throw new Error(`Unknown native helper: ${requested.join(", ")}`);

for (const [name, config] of Object.entries(helpers)) {
  if (requested.length && !requested.includes(name)) continue;

  if (name === "calendar") buildDisclaimShim();
  buildMacosSwiftBinary({
    ...config,
    label: name,
    sourceName: `${config.binaryName}.swift`,
    ...(name === "calendar"
      ? { linkerInfoPlist: path.join(root, "resources", "macos-calendar-listener-Info.plist") }
      : {}),
    ...(name === "audio-tap" ? { target: "arm64-apple-macosx14.2" } : {}),
  });
}

if (!requested.length || requested.includes("meeting-resampler")) buildMeetingResampler(root);

export type {};
