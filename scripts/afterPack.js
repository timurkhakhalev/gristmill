// electron-builder afterPack hook
//
// Runs after electron-builder assembles the output directory but before the
// final macOS installer (DMG/zip) is created. Operates only on the output
// directory — never touches source node_modules/.
//
// 1. Strips non-target platform/arch binaries from onnxruntime-node
//    (saves 150–180 MB per build).
// 2. Fails the build if required binaries (ffmpeg-static,
//    onnx worker script) are missing from app.asar.unpacked/.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// ---------------------------------------------------------------------------
// macOS resource binary signing
// ---------------------------------------------------------------------------

function resolveAppPath(context) {
  if (context.electronPlatformName !== "darwin") {
    return context.appOutDir;
  }

  if (context.appOutDir.endsWith(".app")) {
    return context.appOutDir;
  }

  return path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
}

function resolveResourcesDir(context) {
  return context.electronPlatformName === "darwin"
    ? path.join(resolveAppPath(context), "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
}

function collectFiles(rootDir, skipDirs = new Set()) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const files = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (skipDirs.has(fullPath)) continue;
        queue.push(fullPath);
        continue;
      }

      if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function collectFrameworks(rootDir) {
  if (!fs.existsSync(rootDir)) return [];

  const out = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.name.endsWith(".framework")) {
        out.push(fullPath);
        // Don't descend into a framework — the bundle is signed as a unit.
        continue;
      }
      queue.push(fullPath);
    }
  }

  return out;
}

function isMachOBinary(filePath) {
  try {
    const description = execFileSync("file", ["-b", filePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    return description.includes("Mach-O");
  } catch {
    return false;
  }
}

function registerMacResourceBinariesForSigning(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const resourcesDir = resolveResourcesDir(context);
  const frameworks = collectFrameworks(resourcesDir);
  const skipDirs = new Set(frameworks);
  const machOFiles = collectFiles(resourcesDir, skipDirs).filter(isMachOBinary);
  const toRegister = [...frameworks, ...machOFiles];

  if (toRegister.length === 0) {
    return;
  }

  const macConfig = context.packager.platformSpecificBuildOptions;
  const existingBinaries = Array.isArray(macConfig.binaries) ? macConfig.binaries : [];

  macConfig.binaries = [...new Set([...existingBinaries, ...toRegister])];

  console.log(
    `  afterPack: registered ${frameworks.length} framework(s) and ${machOFiles.length} loose Mach-O file(s) under Contents/Resources for signing`
  );
}

// ---------------------------------------------------------------------------
// onnxruntime-node binary stripping
// ---------------------------------------------------------------------------

function stripOnnxruntimeBinaries(context) {
  const platform = context.electronPlatformName;
  // Resolve the resources directory inside the packed output
  const resourcesDir = resolveResourcesDir(context);

  const onnxBinDir = path.join(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "onnxruntime-node",
    "bin",
    "napi-v6"
  );

  if (!fs.existsSync(onnxBinDir)) return;

  const keepArchs = ["arm64"];

  const platformDirs = fs.readdirSync(onnxBinDir);
  let totalRemoved = 0;

  for (const dir of platformDirs) {
    const fullPath = path.join(onnxBinDir, dir);
    if (!fs.statSync(fullPath).isDirectory()) continue;

    if (dir !== platform) {
      // Wrong platform — remove entirely
      fs.rmSync(fullPath, { recursive: true, force: true });
      totalRemoved++;
      continue;
    }

    // Right platform — strip non-target architectures
    const archDirs = fs.readdirSync(fullPath);
    for (const arch of archDirs) {
      const archPath = path.join(fullPath, arch);
      if (!fs.statSync(archPath).isDirectory()) continue;
      if (!keepArchs.includes(arch)) {
        fs.rmSync(archPath, { recursive: true, force: true });
        totalRemoved++;
      }
    }
  }

  if (totalRemoved > 0) {
    console.log(
      `  afterPack: stripped ${totalRemoved} non-target onnxruntime-node directories (keeping ${platform}/${keepArchs.join(",")})`
    );
  }
}

function verifyUnpackedBinaries(context) {
  const unpackedDir = path.join(resolveResourcesDir(context), "app.asar.unpacked");
  const unpackedModulesDir = path.join(unpackedDir, "node_modules");

  const ffmpegPath = path.join(unpackedModulesDir, "ffmpeg-static", "ffmpeg");
  if (!fs.existsSync(ffmpegPath)) {
    throw new Error(
      `afterPack: missing ${ffmpegPath} — ffmpeg-static was not unpacked from app.asar (asarUnpack/packaging failure); the packed app cannot spawn FFmpeg`
    );
  }

  const onnxWorkerPath = path.join(unpackedDir, "dist-main", "src", "workers", "onnxWorker.js");
  if (!fs.existsSync(onnxWorkerPath)) {
    throw new Error(
      `afterPack: missing ${onnxWorkerPath} — src/workers was not unpacked from app.asar (asarUnpack/packaging failure); the ONNX utility process would crash-loop in the packed app`
    );
  }

  console.log("  afterPack: verified unpacked bundled binaries");
}

// ---------------------------------------------------------------------------
// Main hook
// ---------------------------------------------------------------------------

function verifySqliteRuntime(context) {
  const executable = path.join(resolveAppPath(context), "Contents", "MacOS", context.packager.appInfo.productFilename);
  const sqlite = path.join(resolveResourcesDir(context), "app.asar", "node_modules", "better-sqlite3");
  execFileSync(executable, ["-e", `const db = new (require(${JSON.stringify(sqlite)}))(':memory:'); db.prepare('SELECT 1').get(); db.close();`], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: 15000,
    stdio: "pipe",
  });
  console.log("  afterPack: verified SQLite against the packaged Electron runtime");
}

exports.default = async function (context) {
  stripOnnxruntimeBinaries(context);
  verifyUnpackedBinaries(context);
  verifySqliteRuntime(context);
  registerMacResourceBinariesForSigning(context);
};
