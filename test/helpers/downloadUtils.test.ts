const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

function createElectronMock(response: unknown) {
  return {
    app: { isReady: () => false },
    net: {
      request() {
        const request = new EventEmitter();
        request.setHeader = () => {};
        request.abort = () => {};
        request.end = () => queueMicrotask(() => request.emit("response", response));
        return request;
      },
    },
  };
}

type FetchInit = Parameters<typeof fetch>[1];
type FetchImpl = (url: string, init?: FetchInit & { headers?: Record<string, string> }) => Promise<Response>;
function loadWithNetFetch(fetchImpl: FetchImpl) {
  const electronPath = require.resolve("electron");
  const downloadUtilsPath = require.resolve("../../src/helpers/downloadUtils.ts");
  const originalElectronCache = require.cache[electronPath];
  require.cache[electronPath] = {
    exports: { app: { isReady: () => false }, net: { fetch: fetchImpl } },
  } as unknown as import("node:module").Module;
  delete require.cache[downloadUtilsPath];
  return {
    downloadUtils: require(downloadUtilsPath) as typeof import("../../src/helpers/downloadUtils.ts"),
    restore() {
      delete require.cache[downloadUtilsPath];
      if (originalElectronCache) require.cache[electronPath] = originalElectronCache;
      else delete require.cache[electronPath];
    },
  };
}

test("fetchJson sends the app User-Agent and returns the parsed body", async (t: import("node:test").TestContext) => {
  const calls: Array<{ url: string; init?: FetchInit & { headers?: Record<string, string> } }> = [];
  const { downloadUtils, restore } = loadWithNetFetch(async (url: string, init) => {
    calls.push({ url, init });
    return Response.json({ tag_name: "v1" });
  });
  t.after(restore);

  assert.deepEqual(await downloadUtils.fetchJson("https://example.com/release.json"), {
    tag_name: "v1",
  });
  assert.equal(calls[0]!.init!.method, "GET");
  assert.equal(calls[0]!.init!.headers!["User-Agent"], "OpenHercules/1.0");
});

// The status is the only thing standing between an error page and a caller that
// would otherwise treat a valid-looking JSON body as a successful response.
test("fetchJson rejects a non-2xx response even when its body is valid JSON", async (t: import("node:test").TestContext) => {
  const { downloadUtils, restore } = loadWithNetFetch(async () =>
    Response.json({ error: "Entry not found" }, { status: 404 })
  );
  t.after(restore);

  await assert.rejects(
    () => downloadUtils.fetchJson("https://example.com/missing.json"),
    (error: unknown) => (error as { isHttpError?: boolean }).isHttpError === true && (error as { statusCode?: number }).statusCode === 404
  );
});

test("fetchJson forwards caller init and keeps the User-Agent alongside caller headers", async (t: import("node:test").TestContext) => {
  const calls: Array<{ url: string; init?: FetchInit & { headers?: Record<string, string> } }> = [];
  const { downloadUtils, restore } = loadWithNetFetch(async (url: string, init) => {
    calls.push({ url, init });
    return Response.json({});
  });
  t.after(restore);
  const signal = new AbortController().signal;

  await downloadUtils.fetchJson("https://example.com/pinned.json", {
    headers: { Accept: "application/vnd.github+json" },
    credentials: "omit",
    cache: "no-store",
    signal,
  });

  const { init } = calls[0]! as { init: { credentials?: string; cache?: string; signal?: AbortSignal; headers?: Record<string, string> } };
  assert.equal(init.credentials, "omit");
  assert.equal(init.cache, "no-store");
  assert.equal(init.signal, signal);
  assert.deepEqual(init.headers, {
    "User-Agent": "OpenHercules/1.0",
    Accept: "application/vnd.github+json",
  });
});

test("downloadFile waits for a cancelled write stream to close before removing its temp file", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "downloadUtils-test-"));
  const destination = path.join(tempDir, "model.bin");
  const response = new PassThrough();
  response.statusCode = 200;
  response.headers = {};

  const electronPath = require.resolve("electron");
  const downloadUtilsPath = require.resolve("../../src/helpers/downloadUtils.ts");
  const originalElectronCache = require.cache[electronPath];
  const originalCreateWriteStream = fs.createWriteStream;
  let releaseOpen!: () => void;
  const openGate = new Promise<void>((resolve) => (releaseOpen = resolve));
  let onOpenStarted!: () => void;
  const openStarted = new Promise<void>((resolve) => (onOpenStarted = resolve));
  const order: unknown[] = [];

  require.cache[electronPath] = { exports: createElectronMock(response) } as unknown as import("node:module").Module;
  delete require.cache[downloadUtilsPath];

  fs.createWriteStream = ((filePath: Parameters<typeof fs.createWriteStream>[0], options?: object) => {
    const stream = originalCreateWriteStream(filePath, {
      ...(options ?? {}),
      fs: {
        open: (...args: unknown[]) => {
          const callback = args.at(-1);
          onOpenStarted();
          openGate.then(() => (fs.open as (...a: unknown[]) => void)(...args.slice(0, -1), callback));
        },
        write: fs.write.bind(fs),
        writev: fs.writev.bind(fs),
        close: fs.close.bind(fs),
      },
    });
    stream.once("close", () => order.push("close"));
    return stream;
  }) as typeof fs.createWriteStream;

  try {
    const { createDownloadSignal, downloadFile }: typeof import("../../src/helpers/downloadUtils.ts") = require(downloadUtilsPath);
    const { signal, abort } = createDownloadSignal();
    let settled: "resolved" | { isAbort?: boolean } | null = null;
    const done = downloadFile("https://example.com/model.bin", destination, {
      signal,
      maxRetries: 0,
    }).then(
      () => (settled = "resolved"),
      (error: unknown) => {
        order.push("rejected");
        settled = error as { isAbort?: boolean };
      }
    );

    await openStarted;
    abort();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));

    assert.equal(settled, null, "cancellation must not settle while the open is still pending");

    releaseOpen();
    await done;

    assert.equal((settled as unknown as { isAbort?: boolean }).isAbort, true);
    assert.deepEqual(order, ["close", "rejected"]);
    assert.equal(
      fs.existsSync(`${destination}.tmp`),
      false,
      "the late open must not leave a temp file"
    );
  } finally {
    fs.createWriteStream = originalCreateWriteStream;
    releaseOpen();
    delete require.cache[downloadUtilsPath];
    if (originalElectronCache) require.cache[electronPath] = originalElectronCache;
    else delete require.cache[electronPath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
