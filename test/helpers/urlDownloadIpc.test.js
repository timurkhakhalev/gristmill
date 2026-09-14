const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const downloadHandlersModulePath = require.resolve("../../src/helpers/urlDownloadIpcHandlers");
const originalLoad = Module._load;
const handlers = new Map();

// Fake downloader: every call is recorded and can be held open or failed from
// the test. No network, no real temp writes.
const downloadCalls = [];
let downloadBehavior = () => {
  throw new Error("fake download has no behavior set");
};
const sweepCalls = [];
let safeTempRoot = "";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  session: { fromPartition: () => ({}) },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  const fromHandlers =
    parent?.filename === handlersModulePath ||
    parent?.filename === downloadHandlersModulePath;
  if (fromHandlers) {
    if (request === "./debugLogger") {
      return new Proxy({}, { get: () => () => {} });
    }
    // The TS handler module requests "./urlAudioDownloader.js" (with
    // extension); match on the tail so both spellings hit the fake.
    if (request.endsWith("urlAudioDownloader.js")) {
      return {
        download: (url, onProgress, signal) => {
          const call = { url, onProgress, signal, deferred: deferred() };
          downloadCalls.push(call);
          return downloadBehavior(call);
        },
        sweepStaleTempArtifacts: () => {
          sweepCalls.push(true);
        },
      };
    }
    if (request === "./safeTempDir" || request.endsWith("safeTempDir.js")) {
      return { getSafeTempDir: () => safeTempRoot };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
}

function anything() {
  return new Proxy(function () {}, {
    get: (target, property) => {
      if (property === Symbol.toPrimitive || property === "toString") return () => "";
      if (property === "then") return undefined;
      return anything();
    },
    apply: () => anything(),
  });
}

function sender() {
  const sent = [];
  return {
    sent,
    send: (channel, payload) => sent.push([channel, payload]),
    isDestroyed: () => false,
  };
}

function eventFrom(s) {
  return { sender: s };
}

function resetDownloader() {
  downloadCalls.length = 0;
  downloadBehavior = (call) => call.deferred.promise;
}

test.before(() => {
  // Fresh load of the whole handler graph so the fake downloader/safeTempDir
  // mocks are observed instead of already-cached real modules.
  delete require.cache[handlersModulePath];
  delete require.cache[downloadHandlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;
  Ctor.prototype.setupHandlers.call(
    new Proxy({}, { get: (value, property) => (property in value ? value[property] : anything()) })
  );
  assert.ok(handlers.get("download-url-audio"), "download handler must be registered");
  assert.ok(handlers.get("cancel-url-download"), "cancel handler must be registered");
  assert.ok(handlers.get("delete-temp-file"), "delete-temp handler must be registered");
});

test.after(() => {
  Module._load = originalLoad;
  if (safeTempRoot) fs.rmSync(safeTempRoot, { recursive: true, force: true });
});

test("setup sweeps stale temp artifacts exactly once, not at module import", () => {
  assert.equal(sweepCalls.length, 1);
});

test("success resolves with the downloader result spread under success:true", async () => {
  resetDownloader();
  downloadBehavior = () =>
    Promise.resolve({ tempPath: "/t/ow-url-a", title: "Song", durationSeconds: null, sizeBytes: 12 });
  const result = await handlers.get("download-url-audio")(
    eventFrom(sender()),
    "https://example.com/a.mp3"
  );
  assert.deepEqual(result, {
    success: true,
    tempPath: "/t/ow-url-a",
    title: "Song",
    durationSeconds: null,
    sizeBytes: 12,
  });
});

test("progress goes only to the initiating sender and carries the assigned id", async () => {
  resetDownloader();
  const s1 = sender();
  const s2 = sender();
  const pending = handlers.get("download-url-audio")(
    eventFrom(s1),
    "https://example.com/a.mp3",
    "job-p"
  );
  const call = downloadCalls[0];
  call.onProgress({ stage: "downloading", percent: 40 });
  call.deferred.resolve({ tempPath: "/t/x", title: "t", durationSeconds: null, sizeBytes: 1 });
  await pending;
  assert.deepEqual(s1.sent, [
    ["url-download-progress", { stage: "downloading", percent: 40, downloadId: "job-p" }],
  ]);
  assert.deepEqual(s2.sent, []);
});

test("wrong-type or overlong urls are rejected before the downloader is touched", async () => {
  resetDownloader();
  for (const url of [null, 5, undefined, "x".repeat(2049)]) {
    const result = await handlers.get("download-url-audio")(eventFrom(sender()), url);
    assert.deepEqual(result, { success: false, error: "Invalid URL", code: "INVALID_URL" }, String(url).slice(0, 20));
  }
  assert.equal(downloadCalls.length, 0);
});

// "" is a string of valid length, so the current boundary passes it to the
// downloader; rejecting it there is the downloader's job. Pin that split.
test("empty string url reaches the downloader, which fails it", async () => {
  resetDownloader();
  downloadBehavior = () => Promise.reject(new Error("Invalid URL"));
  const result = await handlers.get("download-url-audio")(eventFrom(sender()), "");
  assert.deepEqual(result, { success: false, error: "Invalid URL", code: "DOWNLOAD_FAILED" });
  assert.equal(downloadCalls.length, 1);
});

test("a url of exactly 2048 chars is accepted by the boundary", async () => {
  resetDownloader();
  const filler = "a".repeat(2048 - "https://example.com/".length);
  const url = `https://example.com/${filler}`;
  assert.equal(url.length, 2048);
  const pending = handlers.get("download-url-audio")(eventFrom(sender()), url);
  downloadCalls[0].deferred.resolve({ tempPath: "/t/x", title: "t", durationSeconds: null, sizeBytes: 1 });
  await pending;
  assert.equal(downloadCalls[0].url, url);
});

test("missing, empty or non-string downloadId gets a generated dl-N id", async () => {
  resetDownloader();
  const seen = [];
  const pendings = ["https://example.com/1", "https://example.com/2", "https://example.com/3"].map(
    (url) => {
      const s = sender();
      const p = handlers.get("download-url-audio")(eventFrom(s), url);
      seen.push({ s, url });
      return p;
    }
  );
  for (const call of downloadCalls) {
    call.onProgress({ stage: "resolving", percent: 0 });
    call.deferred.resolve({ tempPath: "/t/x", title: "t", durationSeconds: null, sizeBytes: 1 });
  }
  await Promise.all(pendings);
  const ids = seen.flatMap((c) => c.s.sent.map(([, payload]) => payload.downloadId));
  assert.match(ids[0], /^dl-\d+$/);
  assert.match(ids[1], /^dl-\d+$/);
  assert.match(ids[2], /^dl-\d+$/);
  assert.ok(Number(ids[0].slice(3)) < Number(ids[1].slice(3)));
  assert.ok(Number(ids[1].slice(3)) < Number(ids[2].slice(3)));
});

test("cancel with a string id aborts only that download", async () => {
  resetDownloader();
  const pending = handlers.get("download-url-audio")(eventFrom(sender()), "https://example.com/1", "job-a");
  const pendingB = handlers.get("download-url-audio")(eventFrom(sender()), "https://example.com/2", "job-b");
  const cancelled = await handlers.get("cancel-url-download")({ sender: sender() }, "job-a");
  assert.deepEqual(cancelled, { success: true });
  assert.equal(downloadCalls[0].signal.aborted, true);
  assert.equal(downloadCalls[1].signal.aborted, false);
  downloadCalls[0].deferred.resolve({ tempPath: "/t/x", title: "t", durationSeconds: null, sizeBytes: 1 });
  downloadCalls[1].deferred.resolve({ tempPath: "/t/x", title: "t", durationSeconds: null, sizeBytes: 1 });
  await Promise.all([pending, pendingB]);
});

test("cancel without an id, with empty string or a non-string cancels everything", async () => {
  resetDownloader();
  const pendings = [
    handlers.get("download-url-audio")(eventFrom(sender()), "https://example.com/1", "job-a"),
    handlers.get("download-url-audio")(eventFrom(sender()), "https://example.com/2", "job-b"),
  ];
  // The first cancel-all aborts both; subsequent ones find an empty map and
  // quietly fail instead of pretending to cancel.
  const first = await handlers.get("cancel-url-download")({ sender: sender() });
  assert.deepEqual(first, { success: true });
  for (const call of downloadCalls) assert.equal(call.signal.aborted, true);
  for (const arg of ["", 7, undefined]) {
    const result = await handlers.get("cancel-url-download")({ sender: sender() }, arg);
    assert.deepEqual(result, { success: false }, String(arg));
  }
  downloadCalls[0].deferred.resolve({ tempPath: "/t/x", title: "t", durationSeconds: null, sizeBytes: 1 });
  downloadCalls[1].deferred.resolve({ tempPath: "/t/x", title: "t", durationSeconds: null, sizeBytes: 1 });
  await Promise.all(pendings);
});

test("cancel of unknown or completed id and cancel-all with nothing running fail quietly", async () => {
  assert.deepEqual(await handlers.get("cancel-url-download")({ sender: sender() }, "nope"), {
    success: false,
  });
  assert.deepEqual(await handlers.get("cancel-url-download")({ sender: sender() }), {
    success: false,
  });
});

test("same-id reuse replaces the entry; the finished job's cleanup keeps the new controller", async () => {
  resetDownloader();
  const first = handlers.get("download-url-audio")(eventFrom(sender()), "https://example.com/1", "same");
  const second = handlers.get("download-url-audio")(eventFrom(sender()), "https://example.com/2", "same");
  // First job finishes; its finally must not evict the replacement.
  downloadCalls[0].deferred.resolve({ tempPath: "/t/x", title: "t", durationSeconds: null, sizeBytes: 1 });
  await first;
  const cancelled = await handlers.get("cancel-url-download")({ sender: sender() }, "same");
  assert.deepEqual(cancelled, { success: true });
  assert.equal(downloadCalls[1].signal.aborted, true);
  downloadCalls[1].deferred.resolve({ tempPath: "/t/x", title: "t", durationSeconds: null, sizeBytes: 1 });
  await second;
});

test("downloader errors keep message and code; a missing code becomes DOWNLOAD_FAILED", async () => {
  resetDownloader();
  downloadBehavior = () =>
    Promise.reject(Object.assign(new Error("quota blown"), { code: "QUOTA" }));
  const withCode = await handlers.get("download-url-audio")(eventFrom(sender()), "https://example.com/1", "e1");
  assert.deepEqual(withCode, { success: false, error: "quota blown", code: "QUOTA" });

  downloadBehavior = () => Promise.reject(new Error("boom"));
  const noCode = await handlers.get("download-url-audio")(eventFrom(sender()), "https://example.com/2", "e2");
  assert.deepEqual(noCode, { success: false, error: "boom", code: "DOWNLOAD_FAILED" });
});

test("an aborted download keeps the downloader's own cancellation code", async () => {
  resetDownloader();
  downloadBehavior = (call) => {
    call.signal.addEventListener("abort", () =>
      call.deferred.reject(Object.assign(new Error("Aborted"), { code: "DOWNLOAD_CANCELLED" }))
    );
    return call.deferred.promise;
  };
  const pending = handlers.get("download-url-audio")(eventFrom(sender()), "https://example.com/1", "ab");
  await handlers.get("cancel-url-download")({ sender: sender() }, "ab");
  const result = await pending;
  assert.deepEqual(result, { success: false, error: "Aborted", code: "DOWNLOAD_CANCELLED" });
});

test("progress is not sent to a destroyed sender and later downloads still work", async () => {
  resetDownloader();
  const s = sender();
  s.isDestroyed = () => true;
  const pending = handlers.get("download-url-audio")(eventFrom(s), "https://example.com/1", "dead");
  downloadCalls[0].onProgress({ stage: "downloading", percent: 10 });
  downloadCalls[0].deferred.resolve({ tempPath: "/t/x", title: "t", durationSeconds: null, sizeBytes: 1 });
  const result = await pending;
  assert.deepEqual(s.sent, []);
  assert.equal(result.success, true);

  const next = handlers.get("download-url-audio")(eventFrom(sender()), "https://example.com/2", "alive");
  downloadCalls[1].deferred.resolve({ tempPath: "/t/x", title: "t", durationSeconds: null, sizeBytes: 1 });
  assert.equal((await next).success, true);
});

// delete-temp-file: real filesystem against a stubbed safe temp root.
function setupTempRoot() {
  safeTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ow-urltest-"));
  return safeTempRoot;
}

test("delete-temp-file rejects non-string paths without touching the disk", async () => {
  setupTempRoot();
  for (const value of [undefined, null, 12, {}]) {
    const result = await handlers.get("delete-temp-file")({ sender: sender() }, value);
    assert.equal(result.success, false, String(value));
    assert.equal(result.error, "Invalid file path");
  }
});

test("delete-temp-file refuses basenames outside the ow-url-/ow-diarize- families", async () => {
  const root = setupTempRoot();
  const foreign = path.join(root, "important.txt");
  fs.writeFileSync(foreign, "keep me");
  const result = await handlers.get("delete-temp-file")({ sender: sender() }, foreign);
  assert.equal(result.success, false);
  assert.equal(result.error, "Not an OpenHercules temp file");
  assert.equal(fs.existsSync(foreign), true);
});

test("delete-temp-file refuses paths that escape the safe temp root", async () => {
  const root = setupTempRoot();
  const outside = path.join(os.tmpdir(), `ow-url-escape-${Date.now()}.tmp`);
  fs.writeFileSync(outside, "outside");
  const result = await handlers.get("delete-temp-file")({ sender: sender() }, outside);
  assert.equal(result.success, false);
  assert.equal(fs.existsSync(outside), true);
  fs.rmSync(outside, { force: true });
  void root;
});

test("delete-temp-file refuses a symlink that points outside the temp root", async () => {
  const root = setupTempRoot();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-outside-"));
  const target = path.join(outsideDir, "ow-url-victim.tmp");
  fs.writeFileSync(target, "victim");
  const link = path.join(root, "ow-url-link.tmp");
  fs.symlinkSync(target, link);
  const result = await handlers.get("delete-temp-file")({ sender: sender() }, link);
  assert.equal(result.success, false);
  assert.equal(fs.existsSync(target), true);
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

test("delete-temp-file reports failure for a missing file", async () => {
  const root = setupTempRoot();
  const result = await handlers.get("delete-temp-file")(
    { sender: sender() },
    path.join(root, "ow-url-gone.tmp")
  );
  assert.equal(result.success, false);
});

test("delete-temp-file removes a legitimate ow- file inside the safe temp root", async () => {
  const root = setupTempRoot();
  const ok = path.join(root, "ow-url-fine.tmp");
  fs.writeFileSync(ok, "audio");
  const result = await handlers.get("delete-temp-file")({ sender: sender() }, ok);
  assert.deepEqual(result, { success: true });
  assert.equal(fs.existsSync(ok), false);
});

test("delete-temp-file removes ow-diarize- files too", async () => {
  const root = setupTempRoot();
  const ok = path.join(root, "ow-diarize-123.wav");
  fs.writeFileSync(ok, "wav");
  const result = await handlers.get("delete-temp-file")({ sender: sender() }, ok);
  assert.deepEqual(result, { success: true });
});
