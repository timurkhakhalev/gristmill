const { app } = require("electron");

const os = require("os");

const fs = require("fs");

const path = require("path");

// Same rule as safeTempDir: native whisper/parakeet binaries crash on Windows
// when model paths contain spaces or non-ASCII (CJK / Cyrillic profile dirs).
export function pathHasProblematicChars(candidate: string): boolean {
  return !/^[\x21-\x7E]*$/.test(candidate);
}

function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });

  return dir;
}

function getAsciiSafeFallbackRoot(): string | null {
  const candidates: string[] = [
    path.join(process.env.ProgramData || "C:\\ProgramData", "Gristmill", "cache"),
    path.join(process.env.SystemDrive || "C:", "Gristmill", "cache"),
  ];

  for (const candidate of candidates) {
    if (pathHasProblematicChars(candidate)) continue;

    try {
      return ensureDir(candidate);
    } catch {}
  }

  return null;
}

function getPreferredCacheRoot(homeCache: string): string {
  const cacheRootEnv = process.env.GRISTMILL_CACHE_ROOT;

  if (cacheRootEnv) {
    return cacheRootEnv;
  }

  if (process.platform === "win32") {
    const redirectedProfile = process.env.USERPROFILE;

    if (redirectedProfile && path.isAbsolute(redirectedProfile)) {
      return path.join(redirectedProfile, ".cache", "gristmill");
    }
  }

  if (process.platform === "linux") {
    const xdgCacheHome = process.env.XDG_CACHE_HOME;

    if (xdgCacheHome && path.isAbsolute(xdgCacheHome)) {
      return path.join(xdgCacheHome, "gristmill");
    }
  }

  return homeCache;
}

// Only these subdirs resolve through getCacheRoot(). qdrant-data,
// embedding-models, and yt-dlp are read from the home cache directly by their
// managers (and tolerate non-ASCII paths), so they must stay put.
const RELOCATED_SUBDIRS: string[] = [
  "whisper-models",
  "parakeet-models",
  "diarization-models",
  "models",
];

let migratedRootPair: string | null = null;

interface CompletedMove {
  from: string;
  to: string;
  copied: boolean;
}

function rollbackMigration(completedMoves: CompletedMove[]): void {
  for (const move of completedMoves.reverse()) {
    try {
      if (!fs.existsSync(move.to)) continue;

      if (move.copied) {
        fs.cpSync(move.to, move.from, { recursive: true });
        fs.rmSync(move.to, { recursive: true, force: true });
      } else if (!fs.existsSync(move.from)) {
        fs.renameSync(move.to, move.from);
      }
    } catch {}
  }
}

function migrateLegacyModelDirs(legacyRoot: string, targetRoot: string): boolean {
  const rootPair = `${legacyRoot}\0${targetRoot}`;

  if (migratedRootPair === rootPair) return true;

  const completedMoves: CompletedMove[] = [];
  let staging: string | null = null;

  try {
    ensureDir(targetRoot);

    for (const subdir of RELOCATED_SUBDIRS) {
      const from = path.join(legacyRoot, subdir);
      const to = path.join(targetRoot, subdir);

      if (!fs.existsSync(from) || fs.existsSync(to)) continue;

      try {
        fs.renameSync(from, to);
        completedMoves.push({ from, to, copied: false });
      } catch {
        // Cross-volume move: copy to a staging dir first so an interrupted
        // copy can never be mistaken for a complete model dir.
        staging = `${to}.migrating`;
        fs.rmSync(staging, { recursive: true, force: true });
        fs.cpSync(from, staging, { recursive: true });
        fs.renameSync(staging, to);
        staging = null;
        completedMoves.push({ from, to, copied: true });
      }
    }

    for (const move of completedMoves) {
      if (move.copied) fs.rmSync(move.from, { recursive: true, force: true });
    }

    migratedRootPair = rootPair;

    return true;
  } catch {
    if (staging) {
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch {}
    }

    rollbackMigration(completedMoves);

    return false;
  }
}

export function getCacheRoot(): string {
  const homeDir: string = app?.getPath?.("home") || os.homedir();
  const homeCache = path.join(homeDir, ".cache", "gristmill");
  let targetRoot: string = getPreferredCacheRoot(homeCache);

  if (process.platform === "win32" && pathHasProblematicChars(targetRoot)) {
    targetRoot = getAsciiSafeFallbackRoot() || homeCache;
  }

  if (targetRoot === homeCache) return homeCache;

  return migrateLegacyModelDirs(homeCache, targetRoot) ? targetRoot : homeCache;
}

export function getModelsDirForService(service: string): string {
  return path.join(getCacheRoot(), `${service}-models`);
}
