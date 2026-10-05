const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const os: typeof import("node:os") = require("node:os");

const path: typeof import("node:path") = require("node:path");

const vm: typeof import("node:vm") = require("node:vm");

const { deferred } = require("./harness/deferred.ts") as typeof import("./harness/deferred.js");

import type {
  UrlDownloadApi,
  UrlDownloadProgress,
  UrlDownloadSuccess,
} from "../../src/contracts/urlDownload.js";

const root = path.resolve(__dirname, "../..");

const bundledPreload = path.join(root, "dist-main", "preload.js");

// Deferred-controlled fake downloader; every call is recorded and can be held
// open or failed from the test. No network, no real temp writes.
type DownloadPayload = Omit<UrlDownloadSuccess, "success">;

type DownloadCall = {
  url: string;
  onProgress: (progress: unknown) => void;
  signal: AbortSignal;
  deferred: import("./harness/deferred.js").Deferred<DownloadPayload>;
};

type Listener = (event: unknown, data: unknown) => void;

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const downloadCalls: DownloadCall[] = [];

let downloadBehavior: (call: DownloadCall) => Promise<unknown> = () => {
  throw new Error("fake download has no behavior set");
};

const activeHandlers = new Map<string, Handler>();

let dispatchSend: ((channel: string, data: unknown) => void) | null = null;

function resetDownloader() {
  downloadCalls.length = 0;
  downloadBehavior = (call) => call.deferred.promise;
}

function loadBundledPreload(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>) {
  const listeners = new Map<string, Listener[]>();
  let api: UrlDownloadApi | undefined;
  vm.runInNewContext(fs.readFileSync(bundledPreload, "utf8"), {
    // The bundle keeps CJS interop for hybrid manifest modules, so the
    // sandbox needs the same bindings Node's CJS loader provides.
    module: { exports: {} },
    exports: {},
    require(name: string) {
      assert.equal(name, "electron", "the bundled preload must only require electron");

      return {
        contextBridge: {
          exposeInMainWorld: (_name: string, value: UrlDownloadApi) => {
            api = value;
          },
        },
        ipcRenderer: {
          invoke,
          send() {},
          on(channel: string, listener: Listener) {
            const list = listeners.get(channel) || [];
            list.push(listener);
            listeners.set(channel, list);
          },
          removeListener(channel: string, listener: Listener) {
            const list = listeners.get(channel) || [];
            const index = list.indexOf(listener);

            if (index !== -1) list.splice(index, 1);
          },
        },
        webUtils: { getPathForFile: () => "" },
      };
    },
    process: { platform: "darwin", versions: {} },
    console,
  });
  assert.ok(api);

  return { api, listeners };
}

async function createFixture(t: import("node:test").TestContext) {
  activeHandlers.clear();
  dispatchSend = null;
  const safeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-url-bridge-"));
  t.after(() => fs.rmSync(safeTempDir, { recursive: true, force: true }));

  const { registerUrlDownloadHandlers } =
    await import("../../src/helpers/urlDownloadIpcHandlers.ts");

  registerUrlDownloadHandlers(
    { handle: (channel, listener) => activeHandlers.set(channel, listener) },
    {
      download: (url, onProgress, signal) => {
        const call: DownloadCall = {
          url,
          onProgress,
          signal,
          deferred: deferred<DownloadPayload>(),
        };

        downloadCalls.push(call);

        return downloadBehavior(call);
      },
      sweepStaleTempArtifacts: () => {},
      getSafeTempDir: () => safeTempDir,
      debugLogger: { error() {}, warn() {} },
    }
  );

  const handlersSnapshot = new Map(activeHandlers);

  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlersSnapshot.get(channel);

    if (!handler) throw new Error(`No handler registered for ${channel}`);

    return handler(
      {
        sender: { isDestroyed: () => false, send: (c: string, p: unknown) => dispatchSend?.(c, p) },
      },
      ...args
    );
  };

  const { api, listeners } = loadBundledPreload(invoke);
  // Close the event loop: main-side sends dispatch into the listeners the
  // preload registered, exactly like Electron would.
  dispatchSend = (channel: string, data: unknown) => {
    for (const listener of listeners.get(channel) || []) listener(null, data);
  };

  return { api, listeners, safeTempDir };
}

test("the full bundled preload chain downloads, reports progress and resolves", async (t: import("node:test").TestContext) => {
  const { api } = await createFixture(t);
  resetDownloader();

  const progressEvents: UrlDownloadProgress[] = [];
  const unsubscribe = api.onUrlDownloadProgress((p) => progressEvents.push(p));
  const pending = api.downloadUrlAudio("https://example.com/a.mp3", "job-1");
  downloadCalls[0].onProgress({ stage: "resolving", percent: 0 });
  downloadCalls[0].onProgress({ stage: "downloading", percent: 55 });
  downloadCalls[0].deferred.resolve({
    tempPath: "/t/ow-url-x",
    title: "Track",
    durationSeconds: null,
    sizeBytes: 4,
  });
  const result = await pending;
  unsubscribe();
  assert.ok(result.success);
  assert.equal(result.tempPath, "/t/ow-url-x");
  assert.equal(result.title, "Track");
  assert.equal(result.sizeBytes, 4);
  assert.deepEqual(
    progressEvents.map((p) => ({ ...p })),
    [
      { stage: "resolving", percent: 0, downloadId: "job-1" },
      { stage: "downloading", percent: 55, downloadId: "job-1" },
    ]
  );
});

test("unsubscribe stops progress; a resubscribed listener sees the next download", async (t: import("node:test").TestContext) => {
  const { api } = await createFixture(t);
  resetDownloader();

  const events: UrlDownloadProgress[] = [];
  const unsubscribe = api.onUrlDownloadProgress((p) => events.push(p));
  unsubscribe();

  const pending = api.downloadUrlAudio("https://example.com/b.mp3", "job-2");
  downloadCalls[0].onProgress({ stage: "downloading", percent: 30 });
  downloadCalls[0].deferred.resolve({
    tempPath: "/t/x",
    title: "t",
    durationSeconds: null,
    sizeBytes: 1,
  });
  await pending;
  assert.deepEqual(events, []);
});

test("a malformed progress event is dropped at the preload boundary; the next valid one passes", async (t: import("node:test").TestContext) => {
  const { api, listeners } = await createFixture(t);
  const events: UrlDownloadProgress[] = [];
  const unsubscribe = api.onUrlDownloadProgress((p) => events.push(p));

  // Inject straight at the preload input, past the main-side validation, to
  // prove the bridge itself filters junk.
  for (const listener of listeners.get("url-download-progress") || []) {
    listener({}, { stage: "sideways", percent: "many" });
    listener({}, { stage: "ready", percent: 100, downloadId: "z" });
  }

  unsubscribe();
  assert.deepEqual(
    events.map((p) => ({ ...p })),
    [{ stage: "ready", percent: 100, downloadId: "z" }]
  );
});

test("cancel-one aborts only its job; bare cancel aborts the rest; finished id fails", async (t: import("node:test").TestContext) => {
  const { api } = await createFixture(t);
  resetDownloader();

  const p1 = api.downloadUrlAudio("https://example.com/1", "c1");
  const p2 = api.downloadUrlAudio("https://example.com/2", "c2");
  const cancelOne = await api.cancelUrlDownload("c1");
  assert.equal(cancelOne.success, true);
  assert.equal(downloadCalls[0].signal.aborted, true);
  assert.equal(downloadCalls[1].signal.aborted, false);

  const cancelAll = await api.cancelUrlDownload();
  assert.equal(cancelAll.success, true);
  assert.equal(downloadCalls[1].signal.aborted, true);
  downloadCalls[0].deferred.resolve({
    tempPath: "/t/x",
    title: "t",
    durationSeconds: null,
    sizeBytes: 1,
  });
  downloadCalls[1].deferred.resolve({
    tempPath: "/t/x",
    title: "t",
    durationSeconds: null,
    sizeBytes: 1,
  });
  await Promise.all([p1, p2]);

  const cancelFinished = await api.cancelUrlDownload("c1");
  assert.equal(cancelFinished.success, false);
});

// Tolerant normalization is a main-side contract: even a JS caller bypassing
// the typed bridge gets the old dl-N generation and cancel-all semantics.
test("raw JS calls with non-string ids keep the tolerant behavior", async (t: import("node:test").TestContext) => {
  await createFixture(t);
  resetDownloader();

  const rawInvoke = async (channel: string, ...args: unknown[]): Promise<{ success: boolean }> => {
    const handler = activeHandlers.get(channel);
    assert.ok(handler);

    return (await handler({ sender: { isDestroyed: () => false, send() {} } }, ...args)) as {
      success: boolean;
    };
  };

  const pending = rawInvoke("download-url-audio", "https://example.com/raw.mp3", 7);
  const cancelAll = await rawInvoke("cancel-url-download", 7);
  assert.equal(cancelAll.success, true);
  assert.equal(downloadCalls[0].signal.aborted, true);
  downloadCalls[0].deferred.resolve({
    tempPath: "/t/x",
    title: "t",
    durationSeconds: null,
    sizeBytes: 1,
  });
  const result = await pending;
  assert.equal(result.success, true);
});

test("error results keep message and code through the bridge", async (t: import("node:test").TestContext) => {
  const { api } = await createFixture(t);
  resetDownloader();
  downloadBehavior = () => Promise.reject(Object.assign(new Error("no space"), { code: "DISK" }));
  const result = await api.downloadUrlAudio("https://example.com/x.mp3", "err1");
  assert.ok(!result.success);
  assert.equal(result.error, "no space");
  assert.equal(result.code, "DISK");
});

test("wrong arguments resolve to failure envelopes, not rejections", async (t: import("node:test").TestContext) => {
  const { api } = await createFixture(t);
  // The download boundary reports invalid URLs as a failure result — same as
  // the JS handlers did; only deleteTempFile type-checks its string.
  const badUrl = await api.downloadUrlAudio(42 as unknown as string);
  assert.ok(!badUrl.success);
  assert.equal(badUrl.code, "INVALID_URL");
  const badPath = await api.deleteTempFile(17 as unknown as string);
  assert.equal(badPath.success, false);
  assert.equal(badPath.error, "Invalid file path");
});

test("deleteTempFile removes an ow- file inside the safe root only", async (t: import("node:test").TestContext) => {
  const { api, safeTempDir } = await createFixture(t);
  const ok = path.join(safeTempDir, "ow-url-fine.tmp");
  fs.writeFileSync(ok, "audio");
  const removed = await api.deleteTempFile(ok);
  assert.equal(removed.success, true);
  assert.equal(fs.existsSync(ok), false);

  const foreign = path.join(safeTempDir, "keep.txt");
  fs.writeFileSync(foreign, "no");
  const refused = await api.deleteTempFile(foreign);
  assert.equal(refused.success, false);
  assert.equal(fs.existsSync(foreign), true);
});
