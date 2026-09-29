#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const {
  cleanupFiles,
  downloadFile,
  findBinaryInDir,
  findLibrariesInDir,
  parseArgs,
  setExecutable,
} = require("./lib/download-utils");
// Plain Node (this script runs from the pack hook, not under tsx) still
// loads the pure-ESM helper via Node type-stripping — same as stt-canary.
const {
  PARAKEET_MINIMUM_MACOS_VERSION,
  compareVersions,
} = require("../src/helpers/parakeetCapability.ts");

const SHERPA_ONNX_VERSION = "1.13.4";
const GITHUB_RELEASE_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_ONNX_VERSION}`;

// sherpa-onnx's macOS archives bundle a universal2 libonnxruntime whose arm64
// slice runs INT8 models ~3x slower than the arm64-only build of the same
// version from the same maintainer (the zip sherpa-onnx's own
// cmake/onnxruntime-osx-arm64.cmake pins). On macOS hosts we swap that slice
// in and keep the x86_64 slice, so the file stays universal2.
const MACOS_ARM64_ONNXRUNTIME = {
  url: "https://github.com/csukuangfj/onnxruntime-libs/releases/download/v1.27.0/onnxruntime-osx-arm64-1.27.0.zip",
  sha256: "5f05b2653eb0af852dab46c85778f0e012c514ed2e71a6dbb9c9550434b0a514",
  libraryName: "libonnxruntime.1.27.0.dylib",
  marker: "arm64-1.27.0", // recorded in the install marker so older installs re-extract
};

// Binary configuration for the supported macOS Apple Silicon target.
const BINARIES = {
  "darwin-arm64": {
    archiveName: `sherpa-onnx-v${SHERPA_ONNX_VERSION}-osx-universal2-shared.tar.bz2`,
    binaryPath: "sherpa-onnx-offline-websocket-server",
    outputName: "sherpa-onnx-ws-darwin-arm64",
    onlineBinaryPath: "sherpa-onnx-online-websocket-server",
    onlineOutputName: "sherpa-onnx-online-ws-darwin-arm64",
    diarizeBinaryPath: "sherpa-onnx-offline-speaker-diarization",
    diarizeOutputName: "sherpa-onnx-diarize-darwin-arm64",
    libPattern: "*.dylib",
  },
};

const BIN_DIR = process.env.OPENHERCULES_LOCAL_BIN_DIR || path.join(__dirname, "..", "resources", "bin");

const VERSIONED_LIB_PATTERN = /^(lib.+?)\.(\d+\.\d+\.\d+)\.(dylib|so|dll)$/;
const REQUIRED_MACOS_ARCHITECTURES = ["x86_64", "arm64"];

function isMacosHostTarget(platformArch) {
  return process.platform === "darwin" && platformArch === "darwin-arm64";
}

// Upstream 1.13.4 ships an invalid arm64 signature on libonnxruntime; dyld SIGKILLs unsigned loads.
function adhocSign(filePath, platformArch) {
  if (process.platform !== "darwin" || platformArch !== "darwin-arm64") return;
  execFileSync("codesign", ["--force", "--sign", "-", filePath], { stdio: "ignore" });
}

async function replaceMacosArm64OnnxRuntime(libraryPath, platformArch) {
  const { url, sha256, libraryName } = MACOS_ARM64_ONNXRUNTIME;
  if (path.basename(libraryPath) !== libraryName) {
    throw new Error(
      `sherpa-onnx ships ${path.basename(libraryPath)}; update MACOS_ARM64_ONNXRUNTIME to match`
    );
  }
  const zipPath = `${libraryPath}.arm64.zip`;
  const extractDir = `${libraryPath}.arm64`;
  const x86Path = `${libraryPath}.x86_64`;
  try {
    console.log(`  ${platformArch}: Downloading arm64 ONNX Runtime from ${url}`);
    await downloadFile(url, zipPath);
    const actual = crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");
    if (actual !== sha256) throw new Error(`arm64 ONNX Runtime sha256 mismatch: ${actual}`);
    execFileSync("unzip", ["-q", "-o", zipPath, "-d", extractDir], { stdio: "ignore" });
    const arm64Path = findLibrariesInDir(extractDir, "*.dylib").find(
      (file) => path.basename(file) === libraryName
    );
    if (!arm64Path) throw new Error(`${libraryName} missing from arm64 ONNX Runtime zip`);
    execFileSync("lipo", ["-thin", "x86_64", libraryPath, "-output", x86Path]);
    execFileSync("lipo", ["-create", x86Path, arm64Path, "-output", libraryPath]);
    console.log(`  ${platformArch}: Replaced arm64 slice of ${libraryName}`);
  } finally {
    for (const file of [zipPath, extractDir, x86Path]) {
      fs.rmSync(file, { recursive: true, force: true });
    }
  }
}

function getDownloadUrl(archiveName) {
  return `${GITHUB_RELEASE_URL}/${archiveName}`;
}

function parseMacosDeploymentTargets(vtoolOutput) {
  const targets = [];
  let architecture = null;
  let isMacosBuildVersion = false;

  for (const line of String(vtoolOutput).split("\n")) {
    const architectureMatch = line.match(/\(architecture ([^)]+)\):\s*$/);
    if (architectureMatch) {
      architecture = architectureMatch[1];
      isMacosBuildVersion = false;
      continue;
    }

    if (/^\s*platform MACOS\s*$/.test(line)) {
      isMacosBuildVersion = true;
      continue;
    }

    const minimumMatch = line.match(/^\s*minos (\S+)\s*$/);
    if (architecture && isMacosBuildVersion && minimumMatch) {
      targets.push({ architecture, minimumVersion: minimumMatch[1] });
      isMacosBuildVersion = false;
    }
  }

  return targets;
}

function validateMacosDeploymentTargets(targets) {
  const architectures = new Set(targets.map((target) => target.architecture));
  for (const architecture of REQUIRED_MACOS_ARCHITECTURES) {
    if (!architectures.has(architecture)) {
      throw new Error(`ONNX Runtime is missing required architecture: ${architecture}`);
    }
  }

  for (const target of targets) {
    if (compareVersions(target.minimumVersion, PARAKEET_MINIMUM_MACOS_VERSION) !== 0) {
      throw new Error(
        `${target.architecture} requires macOS ${target.minimumVersion}, but the Parakeet capability gate is ${PARAKEET_MINIMUM_MACOS_VERSION}`
      );
    }
  }

  return {
    architectures: [...architectures],
    minimumVersion: PARAKEET_MINIMUM_MACOS_VERSION,
  };
}

function verifyPackagedMacosParakeet(
  appPath,
  {
    readDirectory = fs.readdirSync,
    runVtool = (libraryPath) =>
      execFileSync("xcrun", ["vtool", "-show-build", libraryPath], { encoding: "utf8" }),
  } = {}
) {
  const binDirectory = path.join(appPath, "Contents", "Resources", "bin");
  const libraries = readDirectory(binDirectory).filter((fileName) =>
    /^libonnxruntime\.\d+(?:\.\d+)*\.dylib$/.test(fileName)
  );

  if (libraries.length !== 1) {
    throw new Error(
      `Expected one versioned ONNX Runtime library in ${binDirectory}, found ${libraries.length}`
    );
  }

  const libraryPath = path.join(binDirectory, libraries[0]);
  const targets = parseMacosDeploymentTargets(runVtool(libraryPath));
  return { ...validateMacosDeploymentTargets(targets), libraryPath };
}

async function extractTarBz2(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const cwd = path.dirname(archivePath);
  execFileSync("tar", ["-xjf", path.basename(archivePath), "-C", path.relative(cwd, destDir)], {
    stdio: "inherit",
    cwd,
  });
}

function copyBinary(extractDir, binaryName, outputPath, platformArch) {
  const foundPath = findBinaryInDir(extractDir, binaryName);

  if (!foundPath || !fs.existsSync(foundPath)) {
    console.error(`  ${platformArch}: Binary '${binaryName}' not found in archive`);
    return false;
  }

  fs.rmSync(outputPath, { force: true });
  fs.copyFileSync(foundPath, outputPath);
  setExecutable(outputPath);
  adhocSign(outputPath, platformArch);
  console.log(`  ${platformArch}: Extracted to ${path.basename(outputPath)}`);
  return true;
}

function isCompleteInstall(markerPath, binaryPaths, { binDir = BIN_DIR }) {
  if (binaryPaths.some((binaryPath) => !fs.existsSync(binaryPath))) return false;

  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (marker.version !== SHERPA_ONNX_VERSION || !Array.isArray(marker.libraries)) return false;
    if (marker.libraries.some((lib) => !fs.existsSync(path.join(binDir, lib)))) return false;
    return marker.onnxRuntime === MACOS_ARM64_ONNXRUNTIME.marker;
  } catch {
    return false;
  }
}

async function downloadBinary(platformArch, config, isForce = false) {
  if (!config) {
    console.log(`  ${platformArch}: Not supported`);
    return false;
  }

  const outputPath = path.join(BIN_DIR, config.outputName);
  const onlineOutputPath = path.join(BIN_DIR, config.onlineOutputName);
  const diarizeOutputPath = path.join(BIN_DIR, config.diarizeOutputName);
  const installMarkerPath = path.join(BIN_DIR, `.sherpa-onnx-${platformArch}.json`);

  if (
    !isForce &&
    isCompleteInstall(installMarkerPath, [outputPath, onlineOutputPath, diarizeOutputPath], {
      platformArch,
    })
  ) {
    console.log(`  ${platformArch}: Already exists (use --force to re-download)`);
    return true;
  }
  // A failed repair must not leave a previous marker certifying partially patched binaries.
  if (fs.existsSync(installMarkerPath)) fs.unlinkSync(installMarkerPath);

  const url = getDownloadUrl(config.archiveName);
  console.log(`  ${platformArch}: Downloading from ${url}`);

  const archivePath = path.join(BIN_DIR, config.archiveName);
  const extractDir = path.join(BIN_DIR, `temp-sherpa-${platformArch}`);

  try {
    await downloadFile(url, archivePath);

    fs.mkdirSync(extractDir, { recursive: true });
    await extractTarBz2(archivePath, extractDir);

    for (const [binaryName, destPath] of [
      [config.binaryPath, outputPath],
      [config.onlineBinaryPath, onlineOutputPath],
      [config.diarizeBinaryPath, diarizeOutputPath],
    ]) {
      if (!copyBinary(extractDir, binaryName, destPath, platformArch)) return false;
    }

    // Copy shared libraries
    const copiedLibraries = [];
    if (config.libPattern) {
      const libraries = findLibrariesInDir(extractDir, config.libPattern, {
        ignoreReadErrors: true,
      });

      // Separate versioned and unversioned libraries to create symlinks where possible
      // e.g. libonnxruntime.dylib -> libonnxruntime.1.23.2.dylib (saves ~71MB)
      const versionedLibs = new Map(); // base name -> versioned file name

      for (const libPath of libraries) {
        const libName = path.basename(libPath);
        const destPath = path.join(BIN_DIR, libName);

        const versionMatch = libName.match(VERSIONED_LIB_PATTERN);
        if (versionMatch) {
          versionedLibs.set(`${versionMatch[1]}.${versionMatch[3]}`, libName);
        }

        // rm first: copying onto an existing symlink would write through it
        fs.rmSync(destPath, { force: true });
        fs.copyFileSync(libPath, destPath);
        setExecutable(destPath);
        if (isMacosHostTarget(platformArch) && versionMatch?.[1] === "libonnxruntime") {
          await replaceMacosArm64OnnxRuntime(destPath, platformArch);
        }
        adhocSign(destPath, platformArch);
        copiedLibraries.push(libName);
        console.log(`  ${platformArch}: Copied library ${libName}`);
      }

      // Replace unversioned copies with symlinks to versioned ones.
      for (const [baseName, versionedName] of versionedLibs) {
        const basePath = path.join(BIN_DIR, baseName);
        fs.rmSync(basePath, { force: true });
        fs.symlinkSync(versionedName, basePath);
        console.log(`  ${platformArch}: Symlinked ${baseName} -> ${versionedName}`);

        for (const file of fs.readdirSync(BIN_DIR)) {
          const match = file.match(VERSIONED_LIB_PATTERN);
          if (match && `${match[1]}.${match[3]}` === baseName && file !== versionedName) {
            fs.unlinkSync(path.join(BIN_DIR, file));
            console.log(`  ${platformArch}: Removed stale ${file}`);
          }
        }
      }
    }

    fs.writeFileSync(
      installMarkerPath,
      JSON.stringify({
        version: SHERPA_ONNX_VERSION,
        libraries: copiedLibraries,
        onnxRuntime: MACOS_ARM64_ONNXRUNTIME.marker,
      })
    );
    return true;
  } catch (error) {
    console.error(`  ${platformArch}: Failed - ${error.message}`);
    return false;
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
  }
}

async function main() {
  console.log(`\nDownloading sherpa-onnx binaries (v${SHERPA_ONNX_VERSION})...\n`);

  fs.mkdirSync(BIN_DIR, { recursive: true });

  const args = parseArgs();

  if (args.isCurrent) {
    if (!BINARIES[args.platformArch]) {
      console.error(`Unsupported platform/arch: ${args.platformArch}`);
      process.exitCode = 1;
      return;
    }

    const config = BINARIES[args.platformArch];
    console.log(`Downloading for target platform (${args.platformArch}):`);
    const ok = await downloadBinary(args.platformArch, config, args.isForce);
    if (!ok) {
      console.error(`Failed to download binaries for ${args.platformArch}`);
      process.exitCode = 1;
      return;
    }

    // Remove old CLI-style binaries replaced by WS server binaries
    const oldBinaryName = `sherpa-onnx-${args.platformArch}`;
    const oldBinaryPath = path.join(BIN_DIR, oldBinaryName);
    if (fs.existsSync(oldBinaryPath)) {
      console.log(`  Removing old CLI binary: ${oldBinaryName}`);
      fs.unlinkSync(oldBinaryPath);
    }

    if (args.shouldCleanup) {
      cleanupFiles(BIN_DIR, "sherpa-onnx", [
        `sherpa-onnx-ws-${args.platformArch}`,
        `sherpa-onnx-online-ws-${args.platformArch}`,
        `sherpa-onnx-diarize-${args.platformArch}`,
      ]);
    }
  } else {
    console.log("Downloading binaries for all platforms:");
    for (const platformArch of Object.keys(BINARIES)) {
      await downloadBinary(platformArch, BINARIES[platformArch], args.isForce);
    }
  }

  console.log("\n---");

  const files = fs.readdirSync(BIN_DIR).filter((f) => f.startsWith("sherpa-onnx"));
  if (files.length > 0) {
    console.log("Available sherpa-onnx binaries:\n");
    files.forEach((f) => {
      const stats = fs.statSync(path.join(BIN_DIR, f));
      console.log(`  - ${f} (${Math.round(stats.size / 1024 / 1024)}MB)`);
    });
  } else {
    console.log("No binaries downloaded yet.");
    console.log(
      `\nCheck: https://github.com/k2-fsa/sherpa-onnx/releases/tag/v${SHERPA_ONNX_VERSION}`
    );
  }
}

// Export config for potential imports
module.exports = {
  SHERPA_ONNX_VERSION,
  MACOS_ARM64_ONNXRUNTIME,
  BINARIES,
  BIN_DIR,
  getDownloadUrl,
  extractTarBz2,
  isCompleteInstall,
  parseMacosDeploymentTargets,
  validateMacosDeploymentTargets,
  verifyPackagedMacosParakeet,
};

// Only run main() when executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
