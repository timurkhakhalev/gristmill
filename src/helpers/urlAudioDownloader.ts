import https from "https";
import type { IncomingMessage } from "http";
import type { Readable } from "stream";
import dns from "dns";
import { isIP } from "net";
import fs from "fs";
import path from "path";
import debugLogger from "./debugLogger.js";
import { getSafeTempDir } from "./safeTempDir.js";

const STALL_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const USER_AGENT = "Gristmill/1.0";
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

// Wire progress shape consumed by the typed url-download IPC contract.
export interface UrlAudioProgress {
  stage: "resolving" | "downloading" | "ready";
  percent: number;
  title?: string;
}

export type UrlAudioProgressCallback = (progress: UrlAudioProgress) => void;

export interface UrlAudioDownloadResult {
  tempPath: string;
  title: string;
  durationSeconds: number | null;
  sizeBytes: number;
}

interface CodedError extends Error {
  code?: string;
}

function coded(message: string, code: string): CodedError {
  return Object.assign(new Error(message), { code });
}

function isNat64Prefix(ip: string): boolean {
  const head = ip.split("::")[0].split(":");
  if (head.length < 2) return false;
  return (
    (head[0].replace(/^0+/, "") || "0") === "64" && (head[1].replace(/^0+/, "") || "0") === "ff9b"
  );
}

function nat64EmbeddedV4(ip: string): string | null {
  const parts = ip.split("::");
  const head = parts[0].split(":").filter(Boolean);
  const tail = parts.length > 1 ? parts[1].split(":").filter(Boolean) : [];
  const missing = parts.length > 1 ? 8 - head.length - tail.length : 0;
  const groups = parts.length > 1 ? [...head, ...Array(missing).fill("0"), ...tail] : head;
  if (groups.length !== 8) return null;
  const high = Number.parseInt(groups[6], 16);
  const low = Number.parseInt(groups[7], 16);
  if (Number.isNaN(high) || Number.isNaN(low)) return null;
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function isPrivateIp(ip: string): boolean {
  if (ip === "::1" || ip === "::") return true;
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (isIP(ip) !== 6) return false;
  const lower = ip.toLowerCase();
  if (isNat64Prefix(lower)) {
    const dotted = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)?.[1] || nat64EmbeddedV4(lower);
    return dotted ? isPrivateIp(dotted) : false;
  }
  if (
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    /^fe[89ab]/.test(lower) ||
    lower.startsWith("ff")
  ) {
    return true;
  }
  const mapped =
    lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) ||
    lower.match(/^::(\d+\.\d+\.\d+\.\d+)$/) ||
    lower.match(/^[0:]+:ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  const hex = lower.match(/^[0:]+:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return isPrivateIp(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return false;
}

export function isAcceptableAudioContentType(contentType: string | undefined): boolean {
  const value = (contentType || "").toLowerCase();
  return value.startsWith("audio/") || value.startsWith("video/");
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number
) => void;

// dns.lookup wrapper that refuses any resolved private/internal address, so
// the request can never be steered into the user's own network.
export function ssrfSafeLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: LookupCallback
): void {
  dns.lookup(
    hostname,
    options,
    (error, address, family) => {
      if (error) return callback(error, address, family);
      const entries = Array.isArray(address) ? address : [{ address, family }];
      if (entries.some((entry) => isPrivateIp(entry.address))) {
        return callback(
          coded("Direct downloads from private/internal addresses are not allowed", "SSRF_BLOCKED"),
          address,
          family
        );
      }
      callback(null, address, family);
    }
  );
}

export function detectUrlType(urlString: unknown): "direct" {
  if (!urlString || typeof urlString !== "string")
    throw coded("Invalid URL", "INVALID_URL");
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw coded(`Invalid URL: ${urlString}`, "INVALID_URL");
  }
  if (parsed.protocol !== "https:")
    throw coded(`Unsupported protocol: ${parsed.protocol}`, "INVALID_URL");
  if (YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase()))
    throw coded(
      "YouTube imports are not supported; use a direct HTTPS media URL",
      "UNSUPPORTED_URL"
    );
  return "direct";
}

function assertNotYouTube(parsed: URL): void {
  if (YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw coded("YouTube imports are not supported; use a direct HTTPS media URL", "UNSUPPORTED_URL");
  }
}

interface StallChecker {
  touch(): void;
  clear(): void;
}

function createStallChecker(onStall: () => void): StallChecker {
  let lastDataTime = Date.now();
  const interval = setInterval(() => {
    if (Date.now() - lastDataTime > STALL_TIMEOUT_MS) {
      clearInterval(interval);
      onStall();
    }
  }, 5_000);
  return {
    touch: () => {
      lastDataTime = Date.now();
    },
    clear: () => clearInterval(interval),
  };
}

type HttpHeaderBag = Record<string, string | string[] | undefined>;

function firstHeaderValue(headers: HttpHeaderBag, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function deriveTitleAndExt(urlPath: string): { title: string; ext: string } {
  const match = urlPath.match(/\.([a-zA-Z0-9]{2,5})$/);
  const ext = match?.[1] || "audio";
  const raw = path.basename(urlPath, `.${ext}`) || "audio";
  let title: string;
  try {
    title = decodeURIComponent(raw);
  } catch {
    title = raw;
  }
  return { title: title.replace(/[_-]+/g, " "), ext };
}

function assertPublicHost(hostname: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const raw = hostname.replace(/^\[|\]$/g, "");
    if (isIP(raw)) {
      return isPrivateIp(raw)
        ? reject(coded("Direct downloads from private/internal addresses are not allowed", "SSRF_BLOCKED"))
        : resolve();
    }
    dns.lookup(raw, { all: true }, (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => {
      if (error)
        return reject(coded(`DNS lookup failed: ${error.message}`, "DOWNLOAD_FAILED"));
      if (addresses.some((entry) => isPrivateIp(entry.address)))
        return reject(
          coded("Direct downloads from private/internal addresses are not allowed", "SSRF_BLOCKED")
        );
      resolve();
    });
  });
}

// The narrow slice of Electron's net the proxy path needs; lazily required so
// plain-Node harnesses without Electron can still load this module.
interface ElectronNetLike {
  request(options: { url: string; method: string; redirect?: "manual" }): Electron.ClientRequest;
}

async function resolveProxyForUrl(targetUrl: string): Promise<string | null> {
  let session: { defaultSession?: { resolveProxy(url: string): Promise<string> } } | undefined;
  try {
    ({ session } = require("electron"));
  } catch {
    return null;
  }
  if (!session?.defaultSession?.resolveProxy) return null;
  let result: string;
  try {
    result = await session.defaultSession.resolveProxy(targetUrl);
  } catch (error) {
    debugLogger.warn("resolveProxy failed; falling back to direct", {
      error: (error as Error).message,
    });
    return null;
  }
  const first = typeof result === "string" ? result.split(";")[0].trim() : "";
  if (!first || first.toUpperCase() === "DIRECT") return null;
  const [scheme, hostPort] = first.split(/\s+/);
  if (!hostPort) return null;
  const protocol = {
    PROXY: "http",
    HTTPS: "https",
    SOCKS: "socks5",
    SOCKS5: "socks5",
    SOCKS4: "socks4",
  }[scheme.toUpperCase()];
  return protocol ? `${protocol}://${hostPort}` : null;
}

interface HttpRequestOptions {
  method?: string;
  lookup?: typeof ssrfSafeLookup;
  signal?: AbortSignal;
}

function httpRequest(parsed: URL, options: HttpRequestOptions): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      parsed,
      { timeout: CONNECT_TIMEOUT_MS, headers: { "User-Agent": USER_AGENT }, ...options },
      resolve
    );
    request.on("error", (error) =>
      reject(
        options.signal?.aborted
          ? coded("Download cancelled", "DOWNLOAD_CANCELLED")
          : error
      )
    );
    request.on("timeout", () => {
      request.destroy();
      reject(coded("Connection timed out", "DOWNLOAD_FAILED"));
    });
    request.end();
  });
}

interface StreamToFileOptions {
  contentLength: number | null;
  title: string;
  onProgress?: UrlAudioProgressCallback;
  abortSignal?: AbortSignal;
  abort(): void;
}

function streamToFile(
  response: NodeJS.ReadableStream,
  tempPath: string,
  { contentLength, title, onProgress, abortSignal, abort }: StreamToFileOptions
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    if (abortSignal?.aborted) {
      abort();
      reject(coded("Download cancelled", "DOWNLOAD_CANCELLED"));
      return;
    }
    const output = fs.createWriteStream(tempPath);
    let downloaded = 0;
    let settled = false;
    const stall = createStallChecker(() => {
      abort();
      bail(coded("Download stalled", "DOWNLOAD_FAILED"));
    });
    const cleanupFile = () =>
      new Promise<void>((done) => {
        const unlink = () => fs.unlink(tempPath, () => done());
        if (output.closed) return unlink();
        output.once("close", unlink);
        output.destroy();
      });
    const onAbort = () => {
      abort();
      bail(coded("Download cancelled", "DOWNLOAD_CANCELLED"));
    };
    const bail = (error: Error): void => {
      if (settled) return;
      settled = true;
      stall.clear();
      abortSignal?.removeEventListener("abort", onAbort);
      void cleanupFile().then(() => reject(error));
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    response.on("data", (chunk: Buffer) => {
      if (settled) return;
      stall.touch();
      downloaded += chunk.length;
      if (downloaded > MAX_DOWNLOAD_BYTES) {
        abort();
        return bail(coded("File too large. Maximum download size is 500 MB.", "FILE_TOO_LARGE"));
      }
      if (contentLength) {
        onProgress?.({
          stage: "downloading",
          percent: Math.min(99, Math.round((downloaded / contentLength) * 100)),
          title,
        });
      }
    });
    response.on("error", (error) =>
      bail(coded(error.message || "Download failed", "DOWNLOAD_FAILED"))
    );
    response.pipe(output);
    output.on("error", (error) => bail(coded(error.message || "Write failed", "DOWNLOAD_FAILED")));
    output.on("finish", () => {
      if (settled) return;
      stall.clear();
      abortSignal?.removeEventListener("abort", onAbort);
      try {
        const size = fs.statSync(tempPath).size;
        settled = true;
        resolve(size);
      } catch (error) {
        bail(Object.assign(error as Error, { code: "DOWNLOAD_FAILED" }));
      }
    });
  });
}

// Test seam for the Electron net dependency of the proxy path.
let electronNetOverride: ElectronNetLike | null = null;
function getElectronNet(): ElectronNetLike {
  return electronNetOverride || (require("electron").net as ElectronNetLike);
}

interface ProxyHandoff {
  kind: "redirect";
  url: string;
}

interface ProxyResponse {
  kind: "response";
  response: Electron.IncomingMessage & Readable;
  contentLength: number | null;
  request: Electron.ClientRequest;
}

type ProxySettled = ProxyHandoff | ProxyResponse;

export async function downloadViaProxy(
  url: string,
  onProgress?: UrlAudioProgressCallback,
  abortSignal?: AbortSignal,
  redirectCount = 0
): Promise<UrlAudioDownloadResult> {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:") {
    throw coded("Only HTTPS URLs are supported for direct downloads", "INVALID_URL");
  }
  assertNotYouTube(parsedUrl);
  await assertPublicHost(parsedUrl.hostname);
  const netModule = getElectronNet();
  const settled: ProxySettled = await new Promise<ProxySettled>((resolve, reject) => {
    if (abortSignal?.aborted) return reject(coded("Download cancelled", "DOWNLOAD_CANCELLED"));
    let request: Electron.ClientRequest;
    try {
      request = netModule.request({ url, method: "GET", redirect: "manual" });
      request.setHeader("User-Agent", USER_AGENT);
    } catch (error) {
      return reject(coded((error as Error).message || "Download failed", "DOWNLOAD_FAILED"));
    }
    let done = false;
    let timeout: NodeJS.Timeout;
    const onAbort = () => {
      request.abort();
      finish(coded("Download cancelled", "DOWNLOAD_CANCELLED"));
    };
    const finish = (value: unknown, isError = true): void => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      abortSignal?.removeEventListener("abort", onAbort);
      if (isError) {
        reject(value as Error);
      } else {
        resolve(value as ProxySettled);
      }
    };
    timeout = setTimeout(() => {
      request.abort();
      finish(coded("Connection timed out", "DOWNLOAD_FAILED"));
    }, CONNECT_TIMEOUT_MS);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    request.on("redirect", (_status, _method, redirectUrl) => {
      if (redirectCount + 1 > MAX_REDIRECTS)
        return finish(coded("Too many redirects", "DOWNLOAD_FAILED"));
      let next: URL;
      try {
        next = new URL(redirectUrl);
      } catch {
        return finish(coded("Invalid redirect URL", "INVALID_URL"));
      }
      if (next.protocol !== "https:")
        return finish(coded("Only HTTPS URLs are supported for direct downloads", "INVALID_URL"));
      try {
        assertNotYouTube(next);
      } catch (error) {
        return finish(error as Error);
      }
      request.abort();
      finish({ kind: "redirect", url: next.href }, false);
    });
    request.on("response", (rawResponse) => {
      const response = rawResponse as Electron.IncomingMessage & Readable;
      const contentType = (
        firstHeaderValue(response.headers as HttpHeaderBag, "content-type") || ""
      ).toLowerCase();
      if (response.statusCode !== 200) {
        response.resume();
        return finish(coded(`HTTP ${response.statusCode}`, "DOWNLOAD_FAILED"));
      }
      if (!isAcceptableAudioContentType(contentType)) {
        response.resume();
        return finish(
          coded(
            `URL does not point to an audio file (content-type: ${contentType})`,
            "CONTENT_TYPE_INVALID"
          )
        );
      }
      const contentLength = Number(firstHeaderValue(response.headers as HttpHeaderBag, "content-length")) || null;
      if (contentLength !== null && contentLength > MAX_DOWNLOAD_BYTES) {
        response.resume();
        return finish(coded("File too large. Maximum download size is 500 MB.", "FILE_TOO_LARGE"));
      }
      finish({ kind: "response", response, contentLength, request }, false);
    });
    request.on("error", (error) =>
      finish(
        coded(
          error.message || "Download failed",
          abortSignal?.aborted ? "DOWNLOAD_CANCELLED" : "DOWNLOAD_FAILED"
        )
      )
    );
    request.end();
  });
  if (settled.kind === "redirect") {
    return downloadViaProxy(settled.url, onProgress, abortSignal, redirectCount + 1);
  }
  const { response, contentLength, request } = settled;
  const { title, ext } = deriveTitleAndExt(new URL(url).pathname);
  const tempPath = path.join(getSafeTempDir(), `ow-url-${Date.now()}.${ext}`);
  onProgress?.({ stage: "downloading", percent: 0, title });
  const sizeBytes = await streamToFile(response, tempPath, {
    contentLength,
    title,
    onProgress,
    abortSignal,
    abort: () => request.abort(),
  });
  onProgress?.({ stage: "ready", percent: 100, title });
  return { tempPath, title, durationSeconds: null, sizeBytes };
}

export async function downloadDirect(
  url: string,
  onProgress?: UrlAudioProgressCallback,
  abortSignal?: AbortSignal,
  redirectCount = 0
): Promise<UrlAudioDownloadResult> {
  onProgress?.({ stage: "resolving", percent: 0 });
  const parsed = new URL(url);
  if (parsed.protocol !== "https:")
    throw coded("Only HTTPS URLs are supported for direct downloads", "INVALID_URL");
  assertNotYouTube(parsed);
  if (isIP(parsed.hostname) && isPrivateIp(parsed.hostname))
    throw coded(
      "Direct downloads from private/internal addresses are not allowed",
      "SSRF_BLOCKED"
    );
  if (await resolveProxyForUrl(url)) return downloadViaProxy(url, onProgress, abortSignal, redirectCount);
  let head: URL = parsed;
  let redirects = 0;
  let headResponse: IncomingMessage | null = null;
  try {
    for (;;) {
      headResponse = await httpRequest(head, { method: "HEAD", lookup: ssrfSafeLookup, signal: abortSignal });
      headResponse.resume();
      const status = headResponse.statusCode ?? 0;
      const location = headResponse.headers.location;
      if (status >= 300 && status < 400 && location) {
        if (redirectCount + ++redirects > MAX_REDIRECTS)
          throw coded("Too many redirects", "DOWNLOAD_FAILED");
        const next = new URL(location, head.href);
        if (next.protocol !== "https:")
          throw coded("Only HTTPS URLs are supported for direct downloads", "INVALID_URL");
        assertNotYouTube(next);
        if (isIP(next.hostname) && isPrivateIp(next.hostname))
          throw coded(
            "Direct downloads from private/internal addresses are not allowed",
            "SSRF_BLOCKED"
          );
        head = next;
        continue;
      }
      break;
    }
  } catch (error) {
    const code = (error as CodedError).code;
    if (code && ["SSRF_BLOCKED", "INVALID_URL", "DOWNLOAD_FAILED", "DOWNLOAD_CANCELLED"].includes(code))
      throw error;
    headResponse = null;
  }
  let contentLength: number | null = null;
  const headResponseHeaders = headResponse?.headers;
  const headStatus = headResponse?.statusCode ?? 0;
  if (headStatus >= 200 && headStatus < 300 && headResponseHeaders) {
    const type = (headResponseHeaders["content-type"] || "").toLowerCase();
    if (!isAcceptableAudioContentType(type))
      throw coded(
        `URL does not point to an audio file (content-type: ${type})`,
        "CONTENT_TYPE_INVALID"
      );
    contentLength = Number(headResponseHeaders["content-length"]) || null;
    if (contentLength !== null && contentLength > MAX_DOWNLOAD_BYTES)
      throw coded("File too large. Maximum download size is 500 MB.", "FILE_TOO_LARGE");
  }
  const { title, ext } = deriveTitleAndExt(head.pathname);
  const tempPath = path.join(getSafeTempDir(), `ow-url-${Date.now()}.${ext}`);
  onProgress?.({ stage: "downloading", percent: 0, title });
  const response = await httpRequest(head, { method: "GET", lookup: ssrfSafeLookup, signal: abortSignal });
  const status = response.statusCode ?? 0;
  const location = response.headers.location;
  if (status >= 300 && status < 400 && location) {
    response.destroy();
    if (redirectCount + redirects >= MAX_REDIRECTS)
      throw coded("Too many redirects", "DOWNLOAD_FAILED");
    const next = new URL(location, head.href);
    if (next.protocol !== "https:")
      throw coded("Only HTTPS URLs are supported for direct downloads", "INVALID_URL");
    assertNotYouTube(next);
    return downloadDirect(next.href, onProgress, abortSignal, redirectCount + redirects + 1);
  }
  if (status !== 200) {
    response.destroy();
    throw coded(`HTTP ${status}`, "DOWNLOAD_FAILED");
  }
  const type = (response.headers["content-type"] || "").toLowerCase();
  if (!isAcceptableAudioContentType(type)) {
    response.destroy();
    throw coded(
      `URL does not point to an audio file (content-type: ${type})`,
      "CONTENT_TYPE_INVALID"
    );
  }
  if (contentLength === null) contentLength = Number(response.headers["content-length"]) || null;
  if (contentLength !== null && contentLength > MAX_DOWNLOAD_BYTES) {
    response.destroy();
    throw coded("File too large. Maximum download size is 500 MB.", "FILE_TOO_LARGE");
  }
  const sizeBytes = await streamToFile(response, tempPath, {
    contentLength,
    title,
    onProgress,
    abortSignal,
    abort: () => response.destroy(),
  });
  onProgress?.({ stage: "ready", percent: 100, title });
  return { tempPath, title, durationSeconds: null, sizeBytes };
}

export async function download(
  url: string,
  onProgress?: UrlAudioProgressCallback,
  abortSignal?: AbortSignal
): Promise<UrlAudioDownloadResult> {
  const type = detectUrlType(url);
  debugLogger.log("URL audio download starting", { url, type });
  return downloadDirect(url, onProgress, abortSignal);
}

export function sweepStaleTempArtifacts(maxAgeMs = 24 * 60 * 60 * 1000): void {
  try {
    const cutoff = Date.now() - maxAgeMs;
    const tempDir = getSafeTempDir();
    for (const name of fs.readdirSync(tempDir)) {
      if (!name.startsWith("ow-url-") && !name.startsWith("ow-diarize-")) continue;
      const filePath = path.join(tempDir, name);
      try {
        if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
      } catch {
        // Skip entries that vanished between readdir and stat.
      }
    }
  } catch {
    // Temp dir may not exist yet.
  }
}

export function _setElectronNetForTests(netModule: unknown): void {
  electronNetOverride = netModule as ElectronNetLike | null;
}
