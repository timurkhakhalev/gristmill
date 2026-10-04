#!/usr/bin/env node
const fs: typeof import("fs") = require("fs");
const path: typeof import("path") = require("path");
const {
  copyLibraries,
  downloadFile,
  extractArchive,
  fetchLatestRelease,
  findBinaryInDir,
  findLibrariesInDir,
  parseArgs,
  setExecutable,
  cleanupFiles,
}: import("./lib/download-utils.cts").API = require("./lib/download-utils.cts");

const LLAMA_CPP_REPO = "ggml-org/llama.cpp";

// Pinned to a tested build that loads current GGUF models. whisper-server is
// statically linked, so bumping this can't affect local Whisper.
const LLAMA_CPP_TAG = process.env.LLAMA_CPP_VERSION || "b9763";

type BinaryConfig = {
  platformArch: string;
  assetPattern: RegExp;
  binaryPath: string;
  outputName: string;
  libPattern: string;
};
const BINARIES: Record<string, BinaryConfig> = {
  "darwin-arm64": {
    platformArch: "darwin-arm64",
    assetPattern: /^llama-.*-bin-macos-arm64\.tar\.gz$/,
    binaryPath: "build/bin/llama-server",
    outputName: "llama-server-darwin-arm64",
    libPattern: "*.dylib",
  },
};

const BIN_DIR =
  process.env.GRISTMILL_LOCAL_BIN_DIR || path.join(__dirname, "..", "resources", "bin");

let cachedRelease: import("./lib/download-utils.cts").Release | null = null;

async function getRelease() {
  if (cachedRelease) return cachedRelease;
  cachedRelease = await fetchLatestRelease(LLAMA_CPP_REPO, { tag: LLAMA_CPP_TAG });
  return cachedRelease;
}

function findAsset(release: import("./lib/download-utils.cts").Release, pattern: RegExp) {
  return release?.assets?.find((a) => pattern.test(a.name));
}

async function downloadBinary(
  key: string,
  config: BinaryConfig,
  release: import("./lib/download-utils.cts").Release,
  isForce = false
) {
  if (!config) {
    console.log(`  ${key}: Not supported`);
    return false;
  }

  const outputPath = path.join(BIN_DIR, config.outputName);

  // A partial install (binary without its libraries) must not count as
  // installed: the runtime would treat the executable as sufficient and the
  // loader error would repeat on every retry. Completeness = binary + libs.
  const requiredLibs = config.libPattern
    ? findLibrariesInDir(BIN_DIR, config.libPattern, { maxDepth: 1 })
    : [];
  const complete = fs.existsSync(outputPath) && requiredLibs.length > 0;
  if (complete && !isForce) {
    console.log(`  ${key}: Already exists (use --force to re-download)`);
    return true;
  }
  if (fs.existsSync(outputPath) && !complete) {
    console.log(`  ${key}: Partial install found — reinstalling`);
  }

  const asset = findAsset(release, config.assetPattern);
  if (!asset) {
    console.error(`  ${key}: No matching asset found for pattern ${config.assetPattern}`);
    return false;
  }

  console.log(`  ${key}: Downloading from ${asset.url}`);

  const zipPath = path.join(BIN_DIR, asset.name);

  try {
    await downloadFile(asset.url, zipPath);

    const extractDir = path.join(BIN_DIR, `temp-llama-${key}`);
    fs.mkdirSync(extractDir, { recursive: true });
    await extractArchive(zipPath, extractDir);

    const binaryName = path.basename(config.binaryPath);
    let binaryPath: string | null = path.join(extractDir, config.binaryPath);

    if (!fs.existsSync(binaryPath)) {
      binaryPath = findBinaryInDir(extractDir, binaryName);
    }

    if (binaryPath && fs.existsSync(binaryPath)) {
      // Publish libraries FIRST and the executable LAST: the binary is the
      // commit point. A hard kill mid-publish can leave orphaned libraries
      // (harmless — overwritten by the next run) but never a complete-looking
      // install without the binary, and never a bare executable that both the
      // next run and the runtime mistake for a complete install (#160).
      if (config.libPattern) {
        for (const libName of copyLibraries(extractDir, BIN_DIR, config.libPattern)) {
          console.log(`  ${key}: Published library ${libName}`);
        }
      }
      fs.copyFileSync(binaryPath, outputPath);
      setExecutable(outputPath);
      console.log(`  ${key}: Installed to ${config.outputName}`);
    } else {
      console.error(`  ${key}: Binary '${binaryName}' not found in archive`);
      return false;
    }

    fs.rmSync(extractDir, { recursive: true, force: true });
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    return true;
  } catch (error) {
    console.error(`  ${key}: Failed - ${error instanceof Error ? error.message : String(error)}`);
    // Clean up everything this attempt published: a partial install
    // (executable without libraries) blocks normal recovery otherwise.
    // Orphaned libraries are left — the next successful run overwrites them.
    if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true });
    fs.rmSync(extractDir, { recursive: true, force: true });
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    return false;
  }
}

function getEntriesForPlatformArch(platformArch: string) {
  return Object.entries(BINARIES).filter(([, config]) => config.platformArch === platformArch);
}

async function main() {
  fs.mkdirSync(BIN_DIR, { recursive: true });

  const args = parseArgs();

  if (args.isCurrent) {
    const entries = getEntriesForPlatformArch(args.platformArch);

    if (entries.length === 0) {
      console.error(`Unsupported platform/arch: ${args.platformArch}`);
      process.exitCode = 1;
      return;
    }

    // Skip before fetching release info so an installed asset costs no
    // network. Completeness: the executable alone is not an install — its
    // libraries must be present too (issue #160).
    const allInstalled = entries.every(([, config]) => {
      const outputPath = path.join(BIN_DIR, config.outputName);
      if (!fs.existsSync(outputPath)) return false;
      const libs = config.libPattern
        ? findLibrariesInDir(BIN_DIR, config.libPattern, { maxDepth: 1 })
        : [outputPath];
      return libs.length > 0;
    });
    if (allInstalled && !args.isForce) {
      for (const [key] of entries) {
        console.log(`  ${key}: Already exists (use --force to re-download)`);
      }
      return;
    }

    console.log(`\n[llama-server] Using pinned version: ${LLAMA_CPP_TAG}`);
    const release = await getRelease();

    if (!release) {
      console.error(`[llama-server] Could not fetch release from ${LLAMA_CPP_REPO}`);
      console.log(`\nMake sure release exists: https://github.com/${LLAMA_CPP_REPO}/releases`);
      process.exitCode = 1;
      return;
    }

    console.log(`\nDownloading llama-server binaries (${release.tag})...`);

    for (const [key, config] of entries) {
      const ok = await downloadBinary(key, config, release, args.isForce);
      if (!ok) {
        console.error(`Failed to download binaries for ${key}`);
        process.exitCode = 1;
        return;
      }
    }

    if (args.shouldCleanup) {
      cleanupFiles(BIN_DIR, "llama-server", `llama-server-${args.platformArch}`);
    }
  } else {
    console.log(`\n[llama-server] Using pinned version: ${LLAMA_CPP_TAG}`);
    const release = await getRelease();

    if (!release) {
      console.error(`[llama-server] Could not fetch release from ${LLAMA_CPP_REPO}`);
      console.log(`\nMake sure release exists: https://github.com/${LLAMA_CPP_REPO}/releases`);
      process.exitCode = 1;
      return;
    }

    console.log(`\nDownloading llama-server binaries (${release.tag})...`);
    for (const [key, config] of Object.entries(BINARIES)) {
      const ok = await downloadBinary(key, config, release, args.isForce);
      if (!ok) process.exitCode = 1;
    }
  }

  console.log("\n---");

  const files = fs.readdirSync(BIN_DIR).filter((f) => f.startsWith("llama-server"));
  if (files.length > 0) {
    console.log("Available llama-server binaries:\n");
    files.forEach((f) => {
      const stats = fs.statSync(path.join(BIN_DIR, f));
      console.log(`  - ${f} (${Math.round(stats.size / 1024 / 1024)}MB)`);
    });
  } else {
    console.log("No binaries downloaded yet.");
    console.log(`\nMake sure release exists: https://github.com/${LLAMA_CPP_REPO}/releases`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

const api = { BINARIES, LLAMA_CPP_TAG };

module.exports = api;
export type API = typeof api;
