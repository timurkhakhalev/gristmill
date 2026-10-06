#!/usr/bin/env node
// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run these scripts as ESM.
const fs = require("fs") as typeof import("fs");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run these scripts as ESM.
const path = require("path") as typeof import("path");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run these scripts as ESM.
const {
  copyLibraries,
  downloadFile,
  extractZip,
  fetchLatestRelease,
  findBinaryInDir,
  parseArgs,
  setExecutable,
  cleanupFiles,
} = require("./lib/download-utils.cts") as import("./lib/download-utils.cts").API;

const WHISPER_CPP_TAG = process.env.WHISPER_CPP_VERSION || "0.0.10";

const WHISPER_CPP_REPO = "OpenWhispr/whisper.cpp";

// Pinned to a tested build. Tracking the latest release let an upstream whisper.cpp bump
// change transcription output between app releases with no diff to review. See #1348.
type BinaryConfig = {
  zipName: string;
  binaryName: string;
  outputName: string;
  libPattern?: string;
  requiredLibraries?: string[];
};

// Every platform/arch entry is a BinaryConfig; the named table keeps element
// reads typed without widening to an open Record.
interface BinaryTable {
  [platformArch: string]: BinaryConfig;
}

const BINARIES: BinaryTable = {
  "darwin-arm64": {
    zipName: "whisper-server-darwin-arm64.zip",
    binaryName: "whisper-server-darwin-arm64",
    outputName: "whisper-server-darwin-arm64",
  },
} satisfies Record<string, BinaryConfig>;

const BIN_DIR =
  process.env.GRISTMILL_LOCAL_BIN_DIR || path.join(__dirname, "..", "resources", "bin");

// Cache the release info to avoid multiple API calls
let cachedRelease: import("./lib/download-utils.cts").Release | null = null;

async function getRelease() {
  if (cachedRelease) return cachedRelease;

  cachedRelease = await fetchLatestRelease(WHISPER_CPP_REPO, { tag: WHISPER_CPP_TAG });

  return cachedRelease;
}

function getDownloadUrl(
  release: import("./lib/download-utils.cts").Release | null,
  zipName: string
) {
  const asset = release?.assets?.find((a) => a.name === zipName);

  return asset?.url || null;
}

interface InstallMarker {
  version?: string;
  libraries?: string[];
  onnxRuntime?: string;
}

function isInstallMarker(value: unknown): value is InstallMarker {
  return typeof value === "object" && value !== null;
}

function parseInstallMarker(raw: string): InstallMarker | null {
  try {
    const parsed: unknown = JSON.parse(raw);

    return isInstallMarker(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isCompleteInstall(markerPath: string, binaryPath: string, config: BinaryConfig) {
  if (!fs.existsSync(binaryPath)) return false;

  try {
    const marker = parseInstallMarker(fs.readFileSync(markerPath, "utf8"));

    if (!marker) return false;

    if (marker.version !== WHISPER_CPP_TAG || !Array.isArray(marker.libraries)) return false;

    const binDir = path.dirname(markerPath);

    if (marker.libraries.some((library) => !fs.existsSync(path.join(binDir, library)))) {
      return false;
    }

    const installedLibraries = new Set(marker.libraries.map((library) => library.toLowerCase()));

    return (config.requiredLibraries || []).every((library) =>
      installedLibraries.has(library.toLowerCase())
    );
  } catch {
    return false;
  }
}

async function downloadBinary(
  platformArch: string,
  config: BinaryConfig,
  release: import("./lib/download-utils.cts").Release,
  isForce = false
) {
  if (!config) {
    console.log(`  [server] ${platformArch}: Not supported`);

    return false;
  }

  const outputPath = path.join(BIN_DIR, config.outputName);
  const installMarkerPath = path.join(BIN_DIR, `.whisper-cpp-${platformArch}.json`);

  if (!isForce && isCompleteInstall(installMarkerPath, outputPath, config)) {
    console.log(`  [server] ${platformArch}: Already exists (use --force to re-download)`);

    return true;
  }

  if (isForce && fs.existsSync(installMarkerPath)) fs.unlinkSync(installMarkerPath);

  const url = getDownloadUrl(release, config.zipName);

  if (!url) {
    console.error(`  [server] ${platformArch}: Asset ${config.zipName} not found in release`);

    return false;
  }

  console.log(`  [server] ${platformArch}: Downloading from ${url}`);

  const zipPath = path.join(BIN_DIR, config.zipName);

  try {
    await downloadFile(url, zipPath);

    const extractDir = path.join(BIN_DIR, `temp-whisper-${platformArch}`);
    fs.mkdirSync(extractDir, { recursive: true });
    await extractZip(zipPath, extractDir);

    const binaryPath = findBinaryInDir(extractDir, config.binaryName);

    if (binaryPath) {
      fs.copyFileSync(binaryPath, outputPath);
      setExecutable(outputPath);
      console.log(`  [server] ${platformArch}: Extracted to ${config.outputName}`);

      let copiedLibraries: string[] = [];

      if (config.libPattern) {
        copiedLibraries = copyLibraries(extractDir, BIN_DIR, config.libPattern);

        for (const libName of copiedLibraries) {
          console.log(`  [server] ${platformArch}: Copied library ${libName}`);
        }
      }

      const copiedLibraryNames = new Set(copiedLibraries.map((library) => library.toLowerCase()));

      const missingLibraries = (config.requiredLibraries || []).filter(
        (library) => !copiedLibraryNames.has(library.toLowerCase())
      );

      if (missingLibraries.length > 0) {
        throw new Error(`Archive missing required libraries: ${missingLibraries.join(", ")}`);
      }

      fs.writeFileSync(
        installMarkerPath,
        JSON.stringify({ version: WHISPER_CPP_TAG, libraries: copiedLibraries })
      );
    } else {
      console.error(
        `  [server] ${platformArch}: Binary "${config.binaryName}" not found in archive`
      );

      return false;
    }

    fs.rmSync(extractDir, { recursive: true, force: true });

    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    return true;
  } catch (error) {
    console.error(
      `  [server] ${platformArch}: Failed - ${error instanceof Error ? error.message : String(error)}`
    );

    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    return false;
  }
}

async function downloadAllBinaries(
  release: import("./lib/download-utils.cts").Release,
  isForce: boolean,
  download = downloadBinary
) {
  let allSucceeded = true;

  for (const platformArch of Object.keys(BINARIES)) {
    const succeeded = await download(platformArch, BINARIES[platformArch], release, isForce);

    if (!succeeded) allSucceeded = false;
  }

  return allSucceeded;
}

async function main() {
  const args = parseArgs();
  fs.mkdirSync(BIN_DIR, { recursive: true });

  if (args.isCurrent) {
    if (!BINARIES[args.platformArch]) {
      console.error(`Unsupported platform/arch: ${args.platformArch}`);
      process.exitCode = 1;

      return;
    }

    // Skip before fetching release info so an installed asset costs no network.
    const config = BINARIES[args.platformArch];
    const installMarkerPath = path.join(BIN_DIR, `.whisper-cpp-${args.platformArch}.json`);

    if (
      !args.isForce &&
      isCompleteInstall(installMarkerPath, path.join(BIN_DIR, config.outputName), config)
    ) {
      console.log(`  [server] ${args.platformArch}: Already exists (use --force to re-download)`);

      return;
    }

    console.log(`\n[whisper-server] Using pinned version: ${WHISPER_CPP_TAG}`);
    const release = await getRelease();

    if (!release) {
      console.error(`[whisper-server] Could not fetch release from ${WHISPER_CPP_REPO}`);
      console.log(`\nMake sure release exists: https://github.com/${WHISPER_CPP_REPO}/releases`);
      process.exitCode = 1;

      return;
    }

    console.log(`\nDownloading whisper-server binaries (${release.tag})...`);

    const ok = await downloadBinary(
      args.platformArch,
      BINARIES[args.platformArch],
      release,
      args.isForce
    );

    if (!ok) {
      console.error(`Failed to download binaries for ${args.platformArch}`);
      process.exitCode = 1;

      return;
    }

    if (args.shouldCleanup) {
      cleanupFiles(BIN_DIR, "whisper-server", `whisper-server-${args.platformArch}`);
    }
  } else {
    console.log(`\n[whisper-server] Using pinned version: ${WHISPER_CPP_TAG}`);
    const release = await getRelease();

    if (!release) {
      console.error(`[whisper-server] Could not fetch release from ${WHISPER_CPP_REPO}`);
      console.log(`\nMake sure release exists: https://github.com/${WHISPER_CPP_REPO}/releases`);
      process.exitCode = 1;

      return;
    }

    console.log("Downloading binaries for all platforms:");
    const allSucceeded = await downloadAllBinaries(release, args.isForce);

    if (!allSucceeded) process.exitCode = 1;
  }

  console.log("\n---");

  const files = fs.readdirSync(BIN_DIR).filter((f) => f.startsWith("whisper-server"));

  if (files.length > 0) {
    console.log("Available whisper-server binaries:\n");
    files.forEach((f) => {
      const stats = fs.statSync(path.join(BIN_DIR, f));
      console.log(`  - ${f} (${Math.round(stats.size / 1024 / 1024)}MB)`);
    });
  } else {
    console.log("No binaries downloaded yet.");
    console.log(`\nMake sure release exists: https://github.com/${WHISPER_CPP_REPO}/releases`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

const api = { BINARIES, WHISPER_CPP_TAG, downloadAllBinaries, isCompleteInstall };

module.exports = api;

export type API = typeof api;
