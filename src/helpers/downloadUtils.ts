import fs from "fs";
import { promises as fsPromises } from "fs";
import path from "path";
import { net } from "electron";
import { execFile } from "child_process";
import { pipeline } from "stream";
import type { Readable } from "stream";
import debugLogger from "./debugLogger.js";
import { runSystemTar } from "./systemTar.js";

const USER_AGENT = "OpenHercules/1.0";
const PROGRESS_THROTTLE_MS = 100;
const DEFAULT_MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 30000;
const STALL_TIMEOUT_MS = 30000;
const STALE_TMP_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_DOWNLOAD_INCOMPLETE",
]);

const TLS_ERROR_CODES: ReadonlySet<string> = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_UNTRUSTED",
]);

// Coded download error: `code` drives the retry policy, `isAbort`/`isHttpError`
// mark the non-retryable cancel/HTTP classes, TLS failures carry their own tag.
export interface DownloadError extends Error {
  code?: string;
  isAbort?: boolean;
  isHttpError?: boolean;
  isTlsError?: boolean;
  statusCode?: number;
  details?: Record<string, unknown>;
}

function asDownloadError(error: unknown): DownloadError {
  return error as DownloadError;
}

function isTlsError(error: unknown): boolean {
  const err = asDownloadError(error);
  return (
    (err.code !== undefined && TLS_ERROR_CODES.has(err.code)) ||
    (err.message !== undefined && err.message.includes("unable to get local issuer certificate"))
  );
}

function isRetryable(error: unknown): boolean {
  const err = asDownloadError(error);
  if (err.isAbort || err.isHttpError || isTlsError(error)) return false;
  return err.code !== undefined && RETRYABLE_CODES.has(err.code);
}

type ResponseHeaders = Record<string, string | string[] | undefined>;

function headerValue(headers: ResponseHeaders, name: string): string | undefined {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

function backoffDelay(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), MAX_BACKOFF_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The cancellation primitive shared by the model managers. A tiny structural
// signal (not DOM AbortSignal) so managers keep their existing call sites.
export interface DownloadSignal {
  aborted: boolean;
  onAbort: (() => void) | null;
}

export interface DownloadSignalHandle {
  signal: DownloadSignal;
  abort(): void;
}

export function createDownloadSignal(): DownloadSignalHandle {
  const signal: DownloadSignal = { aborted: false, onAbort: null };
  return {
    signal,
    abort() {
      signal.aborted = true;
      if (typeof signal.onAbort === "function") {
        signal.onAbort();
      }
    },
  };
}

export type DownloadProgressCallback = (downloadedBytes: number, totalBytes: number) => void;

export interface DownloadFileOptions {
  onProgress?: DownloadProgressCallback;
  maxRetries?: number;
  signal?: DownloadSignal;
  expectedSize?: number;
}

interface DownloadAttemptResult {
  downloadedSize: number;
  totalSize: number;
}

interface DownloadAttemptOptions {
  onProgress?: DownloadProgressCallback;
  signal?: DownloadSignal;
  startOffset?: number;
  expectedSize?: number;
}

function downloadAttempt(
  url: string,
  tempPath: string,
  options: DownloadAttemptOptions
): Promise<DownloadAttemptResult> {
  const { onProgress, signal, startOffset = 0, expectedSize = 0 } = options;

  return new Promise<DownloadAttemptResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("Download cancelled"), { isAbort: true }));
      return;
    }

    const headers: Record<string, string> = { "User-Agent": USER_AGENT };
    if (startOffset > 0) {
      headers["Range"] = `bytes=${startOffset}-`;
    }

    let request: Electron.ClientRequest | null = null;
    let activeFile: fs.WriteStream | null = null;
    let stallTimer: NodeJS.Timeout | null = null;
    let downloadedSize = startOffset;
    let totalSize = 0;
    let lastProgressUpdate = 0;
    let settled = false;

    const cleanup = (): Promise<void> => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
      if (request) {
        request.abort();
        request = null;
      }
      if (!activeFile) return Promise.resolve();

      const file = activeFile;
      activeFile = null;
      if (file.closed) return Promise.resolve();

      // createWriteStream() opens asynchronously. Wait for close so callers
      // never unlink the temp path before a pending open can recreate it.
      return new Promise((done) => {
        file.once("close", done);
        file.destroy();
      });
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (signal) signal.onAbort = null;
      void cleanup().then(() => reject(error));
    };

    const onAbort = (): void => {
      fail(Object.assign(new Error("Download cancelled"), { isAbort: true }));
    };

    if (signal) {
      signal.onAbort = onAbort;
    }

    request = net.request({ url, method: "GET" });
    for (const [name, value] of Object.entries(headers)) {
      request.setHeader(name, value);
    }

    request.on("response", (response) => {
      // Electron's response extends the Node readable; the declared type is
      // narrower than the runtime object, so widen it at this one boundary.
      const responseBody = response as Electron.IncomingMessage & Readable;
      const responseHeaders = response.headers as ResponseHeaders;
      if (signal?.aborted) {
        responseBody.resume();
        fail(Object.assign(new Error("Download cancelled"), { isAbort: true }));
        return;
      }

      const statusCode = response.statusCode;

      if (statusCode === 200 && startOffset > 0) {
        // Server doesn't support Range — restart from beginning
        downloadedSize = 0;
        activeFile = fs.createWriteStream(tempPath, { flags: "w" });
        totalSize = parseInt(headerValue(responseHeaders, "content-length") ?? "", 10) || 0;
      } else if (statusCode === 206) {
        activeFile = fs.createWriteStream(tempPath, { flags: "a" });
        const contentRange = headerValue(responseHeaders, "content-range");
        if (contentRange) {
          const match = contentRange.match(/\/(\d+)$/);
          if (match) totalSize = parseInt(match[1], 10);
        }
        if (!totalSize) {
          const contentLength = parseInt(headerValue(responseHeaders, "content-length") ?? "", 10) || 0;
          totalSize = startOffset + contentLength;
        }
      } else if (statusCode === 200) {
        activeFile = fs.createWriteStream(tempPath, { flags: "w" });
        totalSize = parseInt(headerValue(responseHeaders, "content-length") ?? "", 10) || 0;
      } else {
        responseBody.resume();
        const err = Object.assign(new Error(`HTTP ${statusCode}`), {
          isHttpError: true,
          statusCode,
        }) as DownloadError;
        fail(err);
        return;
      }

      // Fall back to caller-provided expected size when Content-Length is missing
      if (totalSize <= 0 && expectedSize > 0) {
        totalSize = expectedSize;
      }

      const resetStallTimer = (): void => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          fail(
            Object.assign(new Error("Download stalled — no data received for 30s"), {
              code: "ETIMEDOUT",
            })
          );
        }, STALL_TIMEOUT_MS);
      };

      resetStallTimer();

      responseBody.on("data", (chunk: Buffer) => {
        if (signal?.aborted) {
          fail(Object.assign(new Error("Download cancelled"), { isAbort: true }));
          return;
        }
        downloadedSize += chunk.length;
        resetStallTimer();
        emitProgress();
      });

      const file = activeFile;
      if (!file) {
        // Unreachable: every accepted status branch opened a write stream.
        return;
      }
      pipeline(responseBody, file, (err) => {
        if (settled) return;
        if (stallTimer) {
          clearTimeout(stallTimer);
          stallTimer = null;
        }
        if (signal) signal.onAbort = null;
        if (err) {
          if (signal?.aborted) {
            fail(Object.assign(new Error("Download cancelled"), { isAbort: true }));
          } else {
            fail(err);
          }
        } else if (totalSize > 0 && downloadedSize < totalSize) {
          fail(
            Object.assign(
              new Error(`Download incomplete: received ${downloadedSize} of ${totalSize} bytes`),
              { code: "ERR_DOWNLOAD_INCOMPLETE" }
            )
          );
        } else {
          settled = true;
          resolve({ downloadedSize, totalSize });
        }
      });
    });

    request.on("error", (err: Error) => {
      if (signal?.aborted) {
        fail(Object.assign(new Error("Download cancelled"), { isAbort: true }));
      } else if (isTlsError(err)) {
        fail(
          Object.assign(new Error(`Certificate error: ${err.message}`), {
            code: "TLS_ERROR",
            isTlsError: true,
          })
        );
      } else {
        fail(err);
      }
    });

    request.end();

    function emitProgress(): void {
      if (!onProgress) return;
      const now = Date.now();
      if (
        now - lastProgressUpdate >= PROGRESS_THROTTLE_MS ||
        (totalSize > 0 && downloadedSize >= totalSize)
      ) {
        lastProgressUpdate = now;
        onProgress(downloadedSize, totalSize);
      }
    }
  });
}

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  signal?: unknown;
  // Passthrough request options the manifest probe relies on (cookies/cache
  // semantics); forwarded to net.fetch unchanged.
  credentials?: string;
  cache?: string;
}

export async function fetchJson<T = unknown>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { headers, ...init } = options;
  const response = await net.fetch(url, {
    method: "GET",
    useSessionCookies: false,
    ...init,
    headers: { "User-Agent": USER_AGENT, ...(headers || {}) },
  } as RequestInit);
  if (!response.ok) {
    const err = Object.assign(new Error(`HTTP ${response.status} fetching ${url}`), {
      isHttpError: true,
      statusCode: response.status,
    }) as DownloadError;
    throw err;
  }
  return (await response.json()) as T;
}

export async function downloadFile(
  url: string,
  destPath: string,
  options: DownloadFileOptions = {}
): Promise<string> {
  const { onProgress, maxRetries = DEFAULT_MAX_RETRIES, signal, expectedSize = 0 } = options;

  const tempPath = `${destPath}.tmp`;

  debugLogger.info("Download starting", { url, destPath });

  let startOffset = 0;
  try {
    const stats = await fsPromises.stat(tempPath);
    if (stats.size > 0) {
      startOffset = stats.size;
      debugLogger.info("Resuming download", { startOffset });
    }
  } catch {
    // No existing temp file
  }

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw Object.assign(new Error("Download cancelled"), { isAbort: true });
    }

    if (attempt > 0) {
      const delay = backoffDelay(attempt - 1);
      debugLogger.info("Retrying download", { attempt, delay, startOffset });
      await sleep(delay);

      // Update startOffset from temp file in case partial data was written
      try {
        const stats = await fsPromises.stat(tempPath);
        if (stats.size > 0) startOffset = stats.size;
      } catch {
        startOffset = 0;
      }
    }

    try {
      await downloadAttempt(url, tempPath, {
        onProgress,
        signal,
        startOffset,
        expectedSize,
      });

      // Atomic move to final path
      try {
        await fsPromises.rename(tempPath, destPath);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === "EXDEV") {
          await fsPromises.copyFile(tempPath, destPath);
          await fsPromises.unlink(tempPath).catch(() => {});
        } else {
          throw renameError;
        }
      }

      debugLogger.info("Download complete", { destPath });
      return destPath;
    } catch (error) {
      lastError = error;
      const err = asDownloadError(error);

      if (err.isAbort) {
        await fsPromises.unlink(tempPath).catch(() => {});
        throw error;
      }

      if (!isRetryable(error) || attempt >= maxRetries) {
        debugLogger.error("Download failed", {
          url,
          error: err.message,
          code: err.code,
        });
        await fsPromises.unlink(tempPath).catch(() => {});
        throw error;
      }

      debugLogger.warn("Download attempt failed", {
        attempt: attempt + 1,
        error: err.message,
        code: err.code,
      });
    }
  }

  debugLogger.error("Download failed after all retries", {
    url,
    error: asDownloadError(lastError)?.message,
    code: asDownloadError(lastError)?.code,
  });
  await fsPromises.unlink(tempPath).catch(() => {});
  throw lastError;
}

export function createDownloadInProgressError(
  model: string,
  activeModel: string
): DownloadError {
  return Object.assign(new Error("A model is already being downloaded"), {
    code: "DOWNLOAD_IN_PROGRESS",
    details: { model, activeModel },
  });
}

export async function validateFileSize(
  filePath: string,
  expectedSizeBytes: number,
  tolerancePercent = 10
): Promise<number> {
  const stats = await fsPromises.stat(filePath);
  const minSize = expectedSizeBytes * (1 - tolerancePercent / 100);
  if (stats.size < minSize) {
    await fsPromises.unlink(filePath).catch(() => {});
    throw Object.assign(
      new Error(
        `Download appears corrupted: file is ${Math.round(stats.size / 1_000_000)}MB, ` +
          `expected at least ${Math.round(minSize / 1_000_000)}MB`
      ),
      { code: "ERR_FILE_TOO_SMALL" }
    );
  }
  return stats.size;
}

export async function cleanupStaleDownloads(directory: string): Promise<void> {
  try {
    const entries = await fsPromises.readdir(directory);
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.endsWith(".tmp") && !entry.startsWith("temp-extract-")) continue;
      const fullPath = path.join(directory, entry);
      try {
        const stats = await fsPromises.stat(fullPath);
        if (now - stats.mtimeMs > STALE_TMP_AGE_MS) {
          if (stats.isDirectory()) {
            await fsPromises.rm(fullPath, { recursive: true, force: true });
          } else {
            await fsPromises.unlink(fullPath);
          }
          debugLogger.info("Cleaned up stale download artifact", { path: fullPath });
        }
      } catch {
        // Skip files we can't stat or delete
      }
    }
  } catch {
    // Directory may not exist yet
  }
}

export interface DiskSpaceCheck {
  ok: boolean;
  availableBytes: number;
}

export async function checkDiskSpace(
  directory: string,
  requiredBytes: number
): Promise<DiskSpaceCheck> {
  try {
    const stats = await fsPromises.statfs(directory);
    const availableBytes = stats.bavail * stats.bsize;
    return { ok: availableBytes >= requiredBytes, availableBytes };
  } catch {
    // statfs not supported or directory doesn't exist — skip check
    return { ok: true, availableBytes: Infinity };
  }
}

async function extractZipWindows(zipPath: string, destDir: string): Promise<void> {
  try {
    await runSystemTar(zipPath, destDir);
    return;
  } catch (error) {
    debugLogger.info("tar extraction failed, trying PowerShell", {
      error: (error as Error).message,
    });
  }

  return new Promise<void>((resolve, reject) => {
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${destDir}'`,
      ],
      (psError) => {
        if (psError) reject(new Error(`Zip extraction failed: ${psError.message}`));
        else resolve();
      }
    );
  });
}

async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  try {
    await runSystemTar(archivePath, destDir);
    return;
  } catch (error) {
    debugLogger.info("system tar failed, using JS extraction", { error: (error as Error).message });
  }

  const tar = require("tar") as { x(options: { file: string; cwd: string }): Promise<void> };
  await tar.x({ file: archivePath, cwd: destDir });
}

// Safe archive extraction: system tar first, then the platform fallbacks. A
// zip fallback runs through the JS unzipper as the last resort.
export function extractArchive(archivePath: string, destDir: string): Promise<void> {
  if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    return extractTarGz(archivePath, destDir);
  }

  if (process.platform === "win32") {
    return extractZipWindows(archivePath, destDir);
  }

  return new Promise<void>((resolve, reject) => {
    execFile("unzip", ["-o", archivePath, "-d", destDir], (err) => {
      if (!err) return resolve();
      debugLogger.info("system unzip failed, using JS extraction", { error: err.message });
      const unzipper = require("unzipper") as {
        Extract: (options: { path: string }) => NodeJS.ReadWriteStream;
      };
      fs.createReadStream(archivePath)
        .pipe(unzipper.Extract({ path: destDir }))
        .on("close", resolve)
        .on("error", (extractErr: Error) =>
          reject(new Error(`Zip extraction failed: ${extractErr.message}`))
        );
    });
  });
}

export async function findFile(
  dir: string,
  name: string,
  maxDepth = 5,
  depth = 0
): Promise<string | null> {
  if (depth >= maxDepth) return null;
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(full, name, maxDepth, depth + 1);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

export async function findFiles(
  dir: string,
  pattern: RegExp,
  maxDepth = 5,
  depth = 0
): Promise<string[]> {
  if (depth >= maxDepth) return [];
  const results: string[] = [];
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findFiles(full, pattern, maxDepth, depth + 1)));
    } else if (pattern.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}
