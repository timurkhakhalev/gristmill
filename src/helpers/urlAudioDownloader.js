const https = require("https");
const dns = require("dns");
const { isIP } = require("net");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const { getSafeTempDir } = require("./safeTempDir");

const STALL_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const USER_AGENT = "OpenHercules/1.0";
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);

function isNat64Prefix(ip) {
  const head = ip.split("::")[0].split(":");
  if (head.length < 2) return false;
  return (head[0].replace(/^0+/, "") || "0") === "64" &&
    (head[1].replace(/^0+/, "") || "0") === "ff9b";
}

function nat64EmbeddedV4(ip) {
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

function isPrivateIp(ip) {
  if (ip === "::1" || ip === "::") return true;
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (isIP(ip) !== 6) return false;
  const lower = ip.toLowerCase();
  if (isNat64Prefix(lower)) {
    const dotted = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)?.[1] || nat64EmbeddedV4(lower);
    return dotted ? isPrivateIp(dotted) : false;
  }
  if (lower.startsWith("fc") || lower.startsWith("fd") || /^fe[89ab]/.test(lower) || lower.startsWith("ff")) return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) || lower.match(/^::(\d+\.\d+\.\d+\.\d+)$/) || lower.match(/^[0:]+:ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  const hex = lower.match(/^[0:]+:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return isPrivateIp(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return false;
}

function isAcceptableAudioContentType(contentType) {
  const value = (contentType || "").toLowerCase();
  return value.startsWith("audio/") || value.startsWith("video/");
}

function ssrfSafeLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (error, address, family) => {
    if (error) return callback(error);
    const entries = Array.isArray(address) ? address : [{ address, family }];
    if (entries.some((entry) => isPrivateIp(entry.address))) {
      return callback(Object.assign(new Error("Direct downloads from private/internal addresses are not allowed"), { code: "SSRF_BLOCKED" }));
    }
    callback(null, address, family);
  });
}

function detectUrlType(urlString) {
  if (!urlString || typeof urlString !== "string") throw Object.assign(new Error("Invalid URL"), { code: "INVALID_URL" });
  let parsed;
  try { parsed = new URL(urlString); } catch { throw Object.assign(new Error(`Invalid URL: ${urlString}`), { code: "INVALID_URL" }); }
  if (parsed.protocol !== "https:") throw Object.assign(new Error(`Unsupported protocol: ${parsed.protocol}`), { code: "INVALID_URL" });
  if (YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) throw Object.assign(new Error("YouTube imports are not supported; use a direct HTTPS media URL"), { code: "UNSUPPORTED_URL" });
  return "direct";
}

function assertNotYouTube(parsed) {
  if (YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw Object.assign(new Error("YouTube imports are not supported; use a direct HTTPS media URL"), {
      code: "UNSUPPORTED_URL",
    });
  }
}

function createStallChecker(onStall) {
  let lastDataTime = Date.now();
  const interval = setInterval(() => {
    if (Date.now() - lastDataTime > STALL_TIMEOUT_MS) { clearInterval(interval); onStall(); }
  }, 5_000);
  return { touch: () => { lastDataTime = Date.now(); }, clear: () => clearInterval(interval) };
}

function firstHeaderValue(headers, name) {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function deriveTitleAndExt(urlPath) {
  const match = urlPath.match(/\.([a-zA-Z0-9]{2,5})$/);
  const ext = match?.[1] || "audio";
  const raw = path.basename(urlPath, `.${ext}`) || "audio";
  let title;
  try { title = decodeURIComponent(raw); } catch { title = raw; }
  return { title: title.replace(/[_-]+/g, " "), ext };
}

function assertPublicHost(hostname) {
  return new Promise((resolve, reject) => {
    const raw = hostname.replace(/^\[|\]$/g, "");
    if (isIP(raw)) return isPrivateIp(raw) ? reject(Object.assign(new Error("Direct downloads from private/internal addresses are not allowed"), { code: "SSRF_BLOCKED" })) : resolve();
    dns.lookup(raw, { all: true }, (error, addresses) => {
      if (error) return reject(Object.assign(new Error(`DNS lookup failed: ${error.message}`), { code: "DOWNLOAD_FAILED" }));
      if (addresses.some((entry) => isPrivateIp(entry.address))) return reject(Object.assign(new Error("Direct downloads from private/internal addresses are not allowed"), { code: "SSRF_BLOCKED" }));
      resolve();
    });
  });
}

async function resolveProxyForUrl(targetUrl) {
  let session;
  try { ({ session } = require("electron")); } catch { return null; }
  if (!session?.defaultSession?.resolveProxy) return null;
  let result;
  try { result = await session.defaultSession.resolveProxy(targetUrl); } catch (error) { debugLogger.warn("resolveProxy failed; falling back to direct", { error: error.message }); return null; }
  const first = typeof result === "string" ? result.split(";")[0].trim() : "";
  if (!first || first.toUpperCase() === "DIRECT") return null;
  const [scheme, hostPort] = first.split(/\s+/);
  if (!hostPort) return null;
  const protocol = { PROXY: "http", HTTPS: "https", SOCKS: "socks5", SOCKS5: "socks5", SOCKS4: "socks4" }[scheme.toUpperCase()];
  return protocol ? `${protocol}://${hostPort}` : null;
}

function httpRequest(parsed, options) {
  return new Promise((resolve, reject) => {
    const request = https.request(parsed, { timeout: CONNECT_TIMEOUT_MS, headers: { "User-Agent": USER_AGENT }, ...options }, resolve);
    request.on("error", (error) => reject(options.signal?.aborted ? Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" }) : error));
    request.on("timeout", () => { request.destroy(); reject(Object.assign(new Error("Connection timed out"), { code: "DOWNLOAD_FAILED" })); });
    request.end();
  });
}

function streamToFile(response, tempPath, { contentLength, title, onProgress, abortSignal, abort }) {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) { abort(); reject(Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" })); return; }
    const output = fs.createWriteStream(tempPath);
    let downloaded = 0;
    let settled = false;
    const stall = createStallChecker(() => { abort(); bail(Object.assign(new Error("Download stalled"), { code: "DOWNLOAD_FAILED" })); });
    const cleanupFile = () => new Promise((done) => {
      const unlink = () => fs.unlink(tempPath, () => done());
      if (output.closed) return unlink();
      output.once("close", unlink); output.destroy();
    });
    const onAbort = () => { abort(); bail(Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" })); };
    const bail = (error) => { if (settled) return; settled = true; stall.clear(); abortSignal?.removeEventListener("abort", onAbort); cleanupFile().then(() => reject(error)); };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    response.on("data", (chunk) => {
      if (settled) return;
      stall.touch(); downloaded += chunk.length;
      if (downloaded > MAX_DOWNLOAD_BYTES) { abort(); return bail(Object.assign(new Error("File too large. Maximum download size is 500 MB."), { code: "FILE_TOO_LARGE" })); }
      if (contentLength) onProgress?.({ stage: "downloading", percent: Math.min(99, Math.round(downloaded / contentLength * 100)), title });
    });
    response.on("error", (error) => bail(Object.assign(new Error(error.message || "Download failed"), { code: "DOWNLOAD_FAILED" })));
    response.pipe(output);
    output.on("error", (error) => bail(Object.assign(new Error(error.message || "Write failed"), { code: "DOWNLOAD_FAILED" })));
    output.on("finish", () => {
      if (settled) return;
      stall.clear();
      abortSignal?.removeEventListener("abort", onAbort);
      try {
        const size = fs.statSync(tempPath).size;
        settled = true;
        resolve(size);
      } catch (error) {
        bail(Object.assign(error, { code: "DOWNLOAD_FAILED" }));
      }
    });
  });
}

let electronNetOverride = null;
const REDIRECT_RESTART = "REDIRECT_RESTART";
function getElectronNet() { return electronNetOverride || require("electron").net; }

async function downloadViaProxy(url, onProgress, abortSignal, redirectCount = 0) {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:") {
    throw Object.assign(new Error("Only HTTPS URLs are supported for direct downloads"), { code: "INVALID_URL" });
  }
  assertNotYouTube(parsedUrl);
  await assertPublicHost(parsedUrl.hostname);
  const net = getElectronNet();
  const settled = await new Promise((resolve, reject) => {
    if (abortSignal?.aborted) return reject(Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" }));
    let request;
    try { request = net.request({ url, method: "GET", redirect: "manual" }); request.setHeader("User-Agent", USER_AGENT); } catch (error) { return reject(Object.assign(new Error(error.message || "Download failed"), { code: "DOWNLOAD_FAILED" })); }
    let done = false;
    let timeout;
    const onAbort = () => { request.abort(); finish(Object.assign(new Error("Download cancelled"), { code: "DOWNLOAD_CANCELLED" })); };
    const finish = (value, isError = true) => { if (done) return; done = true; clearTimeout(timeout); abortSignal?.removeEventListener("abort", onAbort); isError ? reject(value) : resolve(value); };
    timeout = setTimeout(() => { request.abort(); finish(Object.assign(new Error("Connection timed out"), { code: "DOWNLOAD_FAILED" })); }, CONNECT_TIMEOUT_MS);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    request.on("redirect", (_status, _method, redirectUrl) => {
      if (redirectCount + 1 > MAX_REDIRECTS) return finish(Object.assign(new Error("Too many redirects"), { code: "DOWNLOAD_FAILED" }));
      let next; try { next = new URL(redirectUrl); } catch { return finish(Object.assign(new Error("Invalid redirect URL"), { code: "INVALID_URL" })); }
      if (next.protocol !== "https:") return finish(Object.assign(new Error("Only HTTPS URLs are supported for direct downloads"), { code: "INVALID_URL" }));
      try { assertNotYouTube(next); } catch (error) { return finish(error); }
      request.abort(); finish({ code: REDIRECT_RESTART, url: next.href }, false);
    });
    request.on("response", (response) => {
      const contentType = (firstHeaderValue(response.headers, "content-type") || "").toLowerCase();
      if (response.statusCode !== 200) { response.resume(); return finish(Object.assign(new Error(`HTTP ${response.statusCode}`), { code: "DOWNLOAD_FAILED" })); }
      if (!isAcceptableAudioContentType(contentType)) { response.resume(); return finish(Object.assign(new Error(`URL does not point to an audio file (content-type: ${contentType})`), { code: "CONTENT_TYPE_INVALID" })); }
      const contentLength = Number(firstHeaderValue(response.headers, "content-length")) || null;
      if (contentLength > MAX_DOWNLOAD_BYTES) { response.resume(); return finish(Object.assign(new Error("File too large. Maximum download size is 500 MB."), { code: "FILE_TOO_LARGE" })); }
      finish({ response, contentLength, request }, false);
    });
    request.on("error", (error) => finish(Object.assign(new Error(error.message || "Download failed"), { code: abortSignal?.aborted ? "DOWNLOAD_CANCELLED" : "DOWNLOAD_FAILED" })));
    request.end();
  });
  if (settled.code === REDIRECT_RESTART) return downloadViaProxy(settled.url, onProgress, abortSignal, redirectCount + 1);
  const { response, contentLength, request } = settled;
  const { title, ext } = deriveTitleAndExt(new URL(url).pathname);
  const tempPath = path.join(getSafeTempDir(), `ow-url-${Date.now()}.${ext}`);
  onProgress?.({ stage: "downloading", percent: 0, title });
  const sizeBytes = await streamToFile(response, tempPath, { contentLength, title, onProgress, abortSignal, abort: () => request.abort() });
  onProgress?.({ stage: "ready", percent: 100, title });
  return { tempPath, title, durationSeconds: null, sizeBytes };
}

async function downloadDirect(url, onProgress, abortSignal, redirectCount = 0) {
  onProgress?.({ stage: "resolving", percent: 0 });
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw Object.assign(new Error("Only HTTPS URLs are supported for direct downloads"), { code: "INVALID_URL" });
  assertNotYouTube(parsed);
  if (isIP(parsed.hostname) && isPrivateIp(parsed.hostname)) throw Object.assign(new Error("Direct downloads from private/internal addresses are not allowed"), { code: "SSRF_BLOCKED" });
  if (await resolveProxyForUrl(url)) return downloadViaProxy(url, onProgress, abortSignal, redirectCount);
  let head = parsed;
  let redirects = 0;
  let headResponse = null;
  try {
    while (true) {
      headResponse = await httpRequest(head, { method: "HEAD", lookup: ssrfSafeLookup, signal: abortSignal }); headResponse.resume();
      if (headResponse.statusCode >= 300 && headResponse.statusCode < 400 && headResponse.headers.location) {
        if (redirectCount + ++redirects > MAX_REDIRECTS) throw Object.assign(new Error("Too many redirects"), { code: "DOWNLOAD_FAILED" });
        const next = new URL(headResponse.headers.location, head.href);
        if (next.protocol !== "https:") throw Object.assign(new Error("Only HTTPS URLs are supported for direct downloads"), { code: "INVALID_URL" });
        assertNotYouTube(next);
        if (isIP(next.hostname) && isPrivateIp(next.hostname)) throw Object.assign(new Error("Direct downloads from private/internal addresses are not allowed"), { code: "SSRF_BLOCKED" });
        head = next; continue;
      }
      break;
    }
  } catch (error) {
    if (["SSRF_BLOCKED", "INVALID_URL", "DOWNLOAD_FAILED", "DOWNLOAD_CANCELLED"].includes(error.code)) throw error;
    headResponse = null;
  }
  let contentLength = null;
  if (headResponse?.statusCode >= 200 && headResponse.statusCode < 300) {
    const type = (headResponse.headers["content-type"] || "").toLowerCase();
    if (!isAcceptableAudioContentType(type)) throw Object.assign(new Error(`URL does not point to an audio file (content-type: ${type})`), { code: "CONTENT_TYPE_INVALID" });
    contentLength = Number(headResponse.headers["content-length"]) || null;
    if (contentLength > MAX_DOWNLOAD_BYTES) throw Object.assign(new Error("File too large. Maximum download size is 500 MB."), { code: "FILE_TOO_LARGE" });
  }
  const { title, ext } = deriveTitleAndExt(head.pathname);
  const tempPath = path.join(getSafeTempDir(), `ow-url-${Date.now()}.${ext}`);
  onProgress?.({ stage: "downloading", percent: 0, title });
  const response = await httpRequest(head, { method: "GET", lookup: ssrfSafeLookup, signal: abortSignal });
  if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
    response.destroy();
    if (redirectCount + redirects >= MAX_REDIRECTS) throw Object.assign(new Error("Too many redirects"), { code: "DOWNLOAD_FAILED" });
    const next = new URL(response.headers.location, head.href);
    if (next.protocol !== "https:") throw Object.assign(new Error("Only HTTPS URLs are supported for direct downloads"), { code: "INVALID_URL" });
    assertNotYouTube(next);
    return downloadDirect(next.href, onProgress, abortSignal, redirectCount + redirects + 1);
  }
  if (response.statusCode !== 200) { response.destroy(); throw Object.assign(new Error(`HTTP ${response.statusCode}`), { code: "DOWNLOAD_FAILED" }); }
  const type = (response.headers["content-type"] || "").toLowerCase();
  if (!isAcceptableAudioContentType(type)) { response.destroy(); throw Object.assign(new Error(`URL does not point to an audio file (content-type: ${type})`), { code: "CONTENT_TYPE_INVALID" }); }
  if (contentLength == null) contentLength = Number(response.headers["content-length"]) || null;
  if (contentLength > MAX_DOWNLOAD_BYTES) { response.destroy(); throw Object.assign(new Error("File too large. Maximum download size is 500 MB."), { code: "FILE_TOO_LARGE" }); }
  const sizeBytes = await streamToFile(response, tempPath, { contentLength, title, onProgress, abortSignal, abort: () => response.destroy() });
  onProgress?.({ stage: "ready", percent: 100, title });
  return { tempPath, title, durationSeconds: null, sizeBytes };
}

async function download(url, onProgress, abortSignal) {
  const type = detectUrlType(url);
  debugLogger.log("URL audio download starting", { url, type });
  return downloadDirect(url, onProgress, abortSignal);
}

function sweepStaleTempArtifacts(maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    const cutoff = Date.now() - maxAgeMs;
    const tempDir = getSafeTempDir();
    for (const name of fs.readdirSync(tempDir)) {
      if (!name.startsWith("ow-url-") && !name.startsWith("ow-diarize-")) continue;
      const filePath = path.join(tempDir, name);
      try { if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath); } catch {}
    }
  } catch {}
}

module.exports = { detectUrlType, download, downloadDirect, downloadViaProxy, sweepStaleTempArtifacts, isPrivateIp, isAcceptableAudioContentType, ssrfSafeLookup, _setElectronNetForTests: (net) => { electronNetOverride = net; } };
