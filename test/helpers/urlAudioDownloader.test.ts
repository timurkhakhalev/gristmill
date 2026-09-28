const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const dns = require("dns");
const https = require("https");
const fs = require("fs");
const { EventEmitter } = require("events");
const { Readable } = require("stream");
const downloader: typeof import("../../src/helpers/urlAudioDownloader") = require("../../src/helpers/urlAudioDownloader");

test("detectUrlType accepts direct HTTPS media URLs", () => {
  assert.equal(downloader.detectUrlType("https://cdn.example.com/interview.mp3"), "direct");
});

test("detectUrlType rejects YouTube imports", () => {
  assert.throws(
    () => downloader.detectUrlType("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    { code: "UNSUPPORTED_URL" }
  );
});

test("detectUrlType rejects non-HTTPS URLs", () => {
  assert.throws(() => downloader.detectUrlType("http://cdn.example.com/audio.mp3"), {
    code: "INVALID_URL",
  });
});

test("isPrivateIp covers private, mapped, NAT64 and public addresses", () => {
  assert.equal(downloader.isPrivateIp("127.0.0.1"), true);
  assert.equal(downloader.isPrivateIp("10.0.0.1"), true);
  assert.equal(downloader.isPrivateIp("::ffff:127.0.0.1"), true);
  assert.equal(downloader.isPrivateIp("64:ff9b::a00:1"), true);
  assert.equal(downloader.isPrivateIp("64:ff9b::8.8.8.8"), false);
  assert.equal(downloader.isPrivateIp("8.8.8.8"), false);
});

test("ssrfSafeLookup rejects private entries in an all-address lookup", async () => {
  const original = dns.lookup;
  dns.lookup = (_host: string, _options: unknown, callback: (...args: unknown[]) => void) =>
    callback(null, [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }]);
  try {
    await new Promise<void>((resolve, reject) => {
      downloader.ssrfSafeLookup("example.com", { all: true }, (error: unknown) => {
        try {
          assert.ok(error && typeof error === "object" && "code" in error);
          assert.equal(error.code, "SSRF_BLOCKED");
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  } finally {
    dns.lookup = original;
  }
});

test("ssrfSafeLookup rejects a private address in the legacy single-address form", async () => {
  const original = dns.lookup;
  dns.lookup = (_host: string, _options: unknown, callback: (...args: unknown[]) => void) => callback(null, "127.0.0.1", 4);
  try {
    await new Promise<void>((resolve, reject) => {
      downloader.ssrfSafeLookup("example.com", {}, (error: unknown) => {
        try {
          assert.ok(error && typeof error === "object" && "code" in error);
          assert.equal(error.code, "SSRF_BLOCKED");
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  } finally {
    dns.lookup = original;
  }
});

test("ssrfSafeLookup forwards an all-public lookup unchanged", async () => {
  const original = dns.lookup;
  const addresses = [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ];
  dns.lookup = (_host: string, _options: unknown, callback: (...args: unknown[]) => void) => callback(null, addresses);
  try {
    await new Promise<void>((resolve, reject) => {
      downloader.ssrfSafeLookup("example.com", { all: true }, (error: unknown, value: unknown) => {
        try {
          assert.equal(error, null);
          assert.deepEqual(value, addresses);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  } finally {
    dns.lookup = original;
  }
});

test("isAcceptableAudioContentType accepts audio and video only", () => {
  assert.equal(downloader.isAcceptableAudioContentType("audio/mpeg"), true);
  assert.equal(downloader.isAcceptableAudioContentType("video/mp4"), true);
  assert.equal(downloader.isAcceptableAudioContentType("text/html"), false);
});

function makeResponse(body: string, headers = {}) {
  const response = Readable.from([Buffer.from(body)]);
  response.statusCode = 200;
  response.headers = { "content-type": "audio/mpeg", "content-length": String(body.length), ...headers };
  return response;
}

test("download streams a validated direct HTTPS response to a temp file", async () => {
  const original = https.request;
  const calls: unknown[] = [];
  https.request = (_parsed: unknown, options: { method: string }, callback: (response: ReturnType<typeof makeResponse>) => void) => {
    calls.push(options.method);
    const request = new EventEmitter();
    request.end = () => setImmediate(() => callback(options.method === "HEAD" ? makeResponse("") : makeResponse("audio")));
    request.destroy = () => {};
    return request;
  };
  let tempPath;
  try {
    const result = await downloader.download("https://93.184.216.34/interview.mp3");
    tempPath = result.tempPath;
    assert.equal(fs.readFileSync(tempPath, "utf8"), "audio");
    assert.equal(result.title, "interview");
    assert.deepEqual(calls, ["HEAD", "GET"]);
  } finally {
    https.request = original;
    if (tempPath) fs.unlinkSync(tempPath);
  }
});

function makeDirectResponse({ statusCode = 200, headers = {}, body = null }: { statusCode?: number; headers?: Record<string, string>; body?: string | null } = {}) {
  const response = body == null ? new EventEmitter() : Readable.from([Buffer.from(body)]);
  response.statusCode = statusCode;
  response.headers = headers;
  if (!response.resume) response.resume = () => {};
  if (!response.destroy) response.destroy = () => {};
  return response;
}

async function withFakeHttps(
  handler: (parsed: URL, options: { method: string }) => ReturnType<typeof makeDirectResponse>,
  callback: (calls: { method: string; url: string }[]) => Promise<unknown>
) {
  const original = https.request;
  const calls: { method: string; url: string }[] = [];
  https.request = (parsed: URL, options: { method: string }, responseCallback: (response: ReturnType<typeof makeDirectResponse>) => void) => {
    calls.push({ method: options.method, url: parsed.href });
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => setImmediate(() => responseCallback(handler(parsed, options)));
    return request;
  };
  try {
    return await callback(calls);
  } finally {
    https.request = original;
  }
}

test("download rejects a HEAD redirect to a private IP", async () => {
  await withFakeHttps(
    () => makeDirectResponse({ statusCode: 302, headers: { location: "https://127.0.0.1/x.mp3" } }),
    async () => assert.rejects(downloader.download("https://93.184.216.34/file.mp3"), { code: "SSRF_BLOCKED" })
  );
});

test("download rejects a GET redirect to a non-HTTPS URL", async () => {
  await withFakeHttps(
    (_parsed, options) => options.method === "HEAD"
      ? makeDirectResponse({ statusCode: 405 })
      : makeDirectResponse({ statusCode: 302, headers: { location: "http://93.184.216.34/x.mp3" } }),
    async () => assert.rejects(downloader.download("https://93.184.216.34/file.mp3"), { code: "INVALID_URL" })
  );
});

test("download rejects a redirect to YouTube", async () => {
  await withFakeHttps(
    () => makeDirectResponse({ statusCode: 302, headers: { location: "https://www.youtube.com/watch?v=abc" } }),
    async () => assert.rejects(downloader.download("https://93.184.216.34/file.mp3"), { code: "UNSUPPORTED_URL" })
  );
});

test("download validates GET content type when HEAD is unavailable", async () => {
  await withFakeHttps(
    (_parsed, options) => options.method === "HEAD"
      ? makeDirectResponse({ statusCode: 405 })
      : makeDirectResponse({ headers: { "content-type": "text/html" }, body: "<html>" }),
    async () => assert.rejects(downloader.download("https://93.184.216.34/file.mp3"), { code: "CONTENT_TYPE_INVALID" })
  );
});

test("downloadViaProxy restarts HTTPS redirects and rejects private targets", async () => {
  const requests: { url: string; aborted?: boolean }[] = [];
  const fakeNet = {
    request(options: { url: string }) {
      const request = new EventEmitter();
      request.url = options.url;
      request.setHeader = () => {};
      request.abort = () => { request.aborted = true; };
      request.end = () => {
        requests.push(request);
        if (requests.length === 1) request.emit("redirect", 302, "GET", "https://93.184.216.34/real.mp3");
        else request.emit("response", makeResponse("proxy-audio"));
      };
      return request;
    },
  };
  downloader._setElectronNetForTests(fakeNet);
  let tempPath;
  try {
    const result = await downloader.downloadViaProxy("https://93.184.216.34/file.mp3");
    tempPath = result.tempPath;
    assert.equal(fs.readFileSync(tempPath, "utf8"), "proxy-audio");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, "https://93.184.216.34/real.mp3");
    requests.length = 0;
    fakeNet.request = (options) => {
      const request = new EventEmitter();
      request.url = options.url;
      request.setHeader = () => {};
      request.abort = () => {};
      request.end = () => {
        requests.push(request);
        request.emit("redirect", 302, "GET", "https://127.0.0.1/private.mp3");
      };
      return request;
    };
    await assert.rejects(downloader.downloadViaProxy("https://93.184.216.34/file.mp3"), { code: "SSRF_BLOCKED" });
    assert.equal(requests.length, 1, "private redirect is blocked before another proxy request");
  } finally {
    downloader._setElectronNetForTests(null);
    if (tempPath) fs.unlinkSync(tempPath);
  }
});
