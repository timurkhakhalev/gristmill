import os from "os";
import fs from "fs";
import path from "path";

let cachedSafeTempDir: string | null = null;

// Returns a safe temp directory for native binaries on Windows.
// Falls back to ProgramData when TEMP contains spaces or non-ASCII characters,
// as many native binaries (whisper-server, ffmpeg) don't handle these paths correctly.
export function getSafeTempDir(): string {
  if (cachedSafeTempDir) return cachedSafeTempDir;

  const systemTemp: string = os.tmpdir();

  // On non-Windows platforms, use system temp directly
  // On Windows, check for problematic characters: non-ASCII or spaces
  const hasProblematicChars = !/^[\x21-\x7E]*$/.test(systemTemp);

  if (process.platform !== "win32" || !hasProblematicChars) {
    cachedSafeTempDir = systemTemp;

    return systemTemp;
  }

  const fallbackBase: string = process.env.ProgramData || "C:\\ProgramData";
  const fallback: string = path.join(fallbackBase, "Gristmill", "temp");

  try {
    fs.mkdirSync(fallback, { recursive: true });
    cachedSafeTempDir = fallback;

    return fallback;
  } catch {
    const rootFallback: string = path.join(process.env.SystemDrive || "C:", "Gristmill", "temp");

    try {
      fs.mkdirSync(rootFallback, { recursive: true });
      cachedSafeTempDir = rootFallback;

      return rootFallback;
    } catch {
      cachedSafeTempDir = systemTemp;

      return systemTemp;
    }
  }
}
