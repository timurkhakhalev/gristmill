const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const Module = require("node:module");

const loopbackModulePath = require.resolve("../../src/helpers/oauthLoopbackFlow.ts");
const originalLoad = Module._load;

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function loadLoopback(): typeof import("../../src/helpers/oauthLoopbackFlow.ts") {
  delete require.cache[loopbackModulePath];
  Module._load = function loadWithElectronMock(request: string, parent: unknown, isMain: boolean) {
    if (request === "electron") {
      return { shell: { openExternal() {} } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(loopbackModulePath) as typeof import("../../src/helpers/oauthLoopbackFlow.ts");
  } finally {
    Module._load = originalLoad;
  }
}

function startFlow(handleCallback: (code: string) => Promise<{ ok?: boolean; code?: string }> = async () => ({ ok: true })) {
  const { runOAuthLoopbackFlow } = loadLoopback();
  let redirectUri: unknown;
  let state: unknown;
  let server!: import("node:http").Server;
  const originalCreateServer = http.createServer;
  http.createServer = (...args: unknown[]) => {
    server = originalCreateServer(...args);
    return server;
  };

  try {
    const flow = runOAuthLoopbackFlow({
      buildAuthUrl: (uri, flowState) => {
        redirectUri = uri;
        state = flowState;
        return "https://example.test/auth";
      },
      handleCallback,
    });
    return { flow, server, getRedirectUri: () => redirectUri, getState: () => state };
  } finally {
    http.createServer = originalCreateServer;
  }
}

function startBlockedFlow() {
  let callbackCount = 0;
  let releaseHandleCallback!: () => void;
  let markCallbackStarted!: () => void;
  const callbackStarted = new Promise<void>((resolve) => {
    markCallbackStarted = resolve;
  });
  const startedFlow = startFlow(async (code: string) => {
    callbackCount += 1;
    if (callbackCount === 1) {
      markCallbackStarted();
      await new Promise<void>((resolve) => {
        releaseHandleCallback = resolve;
      });
    }
    return { code };
  });

  return {
    ...startedFlow,
    callbackStarted,
    getCallbackCount: () => callbackCount,
    releaseHandleCallback: () => releaseHandleCallback?.(),
  };
}

function startFlowWithControlledTimeout(handleCallback: NonNullable<Parameters<typeof startFlow>[0]>) {
  const originalSetTimeout = global.setTimeout;
  let runFlowTimeout: (() => void) | undefined;

  global.setTimeout = ((callback: (...args: unknown[]) => void, delay: number, ...args: unknown[]) => {
    if (delay === 120000) {
      runFlowTimeout = () => callback(...args);
      return originalSetTimeout(() => {}, 0);
    }
    return originalSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout;

  try {
    const startedFlow = startFlow(handleCallback);
    return {
      ...startedFlow,
      triggerTimeout: () => {
        if (!runFlowTimeout) throw new Error("OAuth timeout was not scheduled");
        runFlowTimeout();
      },
    };
  } finally {
    global.setTimeout = originalSetTimeout;
  }
}

async function waitForListen(getRedirectUri: () => unknown): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const redirectUri = getRedirectUri();
    if (typeof redirectUri === "string") return redirectUri;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("loopback server did not start");
}

function requestPath(redirectUri: string, path: string): Promise<number> {
  const { hostname, port } = new URL(redirectUri);
  return new Promise<number>((resolve, reject) => {
    const request = http.get(
      { hostname, port, path, agent: false, headers: { Connection: "close" } },
      (response: import("node:http").IncomingMessage) => {
        response.resume();
        response.on("end", () => { assert.ok(response.statusCode); resolve(response.statusCode); });
      }
    );
    request.on("error", reject);
  });
}

async function parkPartialRequest(redirectUri: string, server: import("node:http").Server) {
  const { hostname, port } = new URL(redirectUri);
  let response = "";
  let responseStatus: number | undefined;
  let responseSettled = false;
  let resolveStatus!: (status: number) => void;
  let rejectStatus!: (error: unknown) => void;
  const status = new Promise<number>((resolve, reject) => {
    resolveStatus = resolve;
    rejectStatus = reject;
  });
  const requestStarted = new Promise<unknown>((resolve) => {
    server.once("connection", (acceptedSocket: import("node:net").Socket) => {
      acceptedSocket.once("data", resolve);
    });
  });
  const socket = net.createConnection({ host: hostname, port });
  socket.setEncoding("utf8");
  socket.on("data", (chunk: unknown) => {
    response += chunk;
    const match = /^HTTP\/1\.1 (\d{3})/.exec(response);
    if (match) {
      responseStatus = Number(match[1]);
    }
  });
  socket.on("end", () => {
    if (responseStatus && !responseSettled) {
      responseSettled = true;
      resolveStatus(responseStatus);
    }
  });
  socket.on("error", (error: unknown) => {
    if (!responseSettled) {
      responseSettled = true;
      rejectStatus(error);
    }
  });
  socket.on("close", () => {
    if (!responseSettled) {
      responseSettled = true;
      rejectStatus(new Error("parked request closed without a response"));
    }
  });

  await new Promise<void>((resolve, reject) => {
    const handleConnect = () => {
      socket.off("error", handleError);
      resolve();
    };
    const handleError = (error: unknown) => {
      socket.off("connect", handleConnect);
      reject(error);
    };
    socket.once("connect", handleConnect);
    socket.once("error", handleError);
  });
  socket.write("GET /");
  await requestStarted;

  return {
    complete: (path: string) => {
      socket.end(
        `${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: close\r\n\r\n`
      );
      return status;
    },
    destroy: () => socket.destroy(),
  };
}

test("a callback with a code and the wrong state rejects immediately", async () => {
  const { flow, getRedirectUri } = startFlow();
  const redirectUri = await waitForListen(getRedirectUri);
  const started = Date.now();
  const rejected = assert.rejects(flow, /OAuth state mismatch/);

  const response = await fetch(`${redirectUri}/?code=stolen&state=wrong`, {
    redirect: "manual",
  });
  assert.equal(response.status, 400);

  await rejected;
  assert.ok(Date.now() - started < 5000, "must not wait for the 120s timeout");
});

test("a request with no code leaves the flow running until a real callback", async () => {
  const { flow, getRedirectUri, getState } = startFlow(async (code: string) => ({ code }));
  const redirectUri = await waitForListen(getRedirectUri);

  const stray = await fetch(`${redirectUri}/favicon.ico`, { redirect: "manual" });
  assert.equal(stray.status, 400);

  const stillPending = await Promise.race([
    flow.then(
      () => "resolved",
      () => "rejected"
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 200)),
  ]);
  assert.equal(stillPending, "pending");

  const success = await fetch(`${redirectUri}/?code=ok&state=${getState()}`, {
    redirect: "manual",
  });
  assert.equal(success.status, 200);
  assert.deepEqual(await flow, { code: "ok" });
});

test("a provider error query with the valid state still fails the flow immediately", async () => {
  const { flow, getRedirectUri, getState } = startFlow();
  const redirectUri = await waitForListen(getRedirectUri);
  const rejected = assert.rejects(flow, /OAuth error: access_denied/);

  const response = await fetch(`${redirectUri}/?error=access_denied&state=${getState()}`, {
    redirect: "manual",
  });
  assert.equal(response.status, 400);
  await rejected;
});

test("a late state mismatch cannot reject a valid callback already in progress", async () => {
  const {
    flow,
    getRedirectUri,
    getState,
    callbackStarted,
    releaseHandleCallback,
  } = startBlockedFlow();
  const redirectUri = await waitForListen(getRedirectUri);
  const flowOutcome = flow.then(
    () => "resolved",
    (error: unknown) => `rejected: ${errorMessage(error)}`
  );

  const validResponsePromise = fetch(`${redirectUri}/?code=ok&state=${getState()}`, {
    redirect: "manual",
  });
  await callbackStarted;

  let mismatchResponse;
  let outcomeBeforeRelease;
  try {
    mismatchResponse = await fetch(`${redirectUri}/?code=stale&state=wrong`, {
      redirect: "manual",
    });
    outcomeBeforeRelease = await Promise.race([
      flowOutcome,
      new Promise((resolve) => setTimeout(() => resolve("pending"), 200)),
    ]);
  } finally {
    releaseHandleCallback();
  }

  const validResponse = await validResponsePromise;
  assert.equal(mismatchResponse.status, 400);
  assert.equal(outcomeBeforeRelease, "pending");
  assert.equal(validResponse.status, 200);
  assert.equal(await flowOutcome, "resolved");
});

test("a late malformed request cannot reject a valid callback already in progress", async () => {
  const {
    flow,
    getRedirectUri,
    getState,
    callbackStarted,
    releaseHandleCallback,
  } = startBlockedFlow();
  const redirectUri = await waitForListen(getRedirectUri);
  const flowOutcome = flow.then(
    () => "resolved",
    (error: unknown) => `rejected: ${errorMessage(error)}`
  );

  const validResponsePromise = fetch(`${redirectUri}/?code=ok&state=${getState()}`, {
    redirect: "manual",
  });
  await callbackStarted;

  let malformedStatus;
  let outcomeBeforeRelease;
  try {
    malformedStatus = await requestPath(redirectUri, "//[");
    outcomeBeforeRelease = await Promise.race([
      flowOutcome,
      new Promise((resolve) => setTimeout(() => resolve("pending"), 200)),
    ]);
  } finally {
    releaseHandleCallback();
  }

  const validResponse = await validResponsePromise;
  assert.equal(malformedStatus, 400);
  assert.equal(outcomeBeforeRelease, "pending");
  assert.equal(validResponse.status, 200);
  assert.equal(await flowOutcome, "resolved");
});

test("a second valid callback cannot start another token exchange", async () => {
  const {
    flow,
    getRedirectUri,
    getState,
    callbackStarted,
    getCallbackCount,
    releaseHandleCallback,
  } = startBlockedFlow();
  const redirectUri = await waitForListen(getRedirectUri);
  const flowOutcome = flow.then(
    (result: unknown) => ({ status: "resolved", result }),
    (error: unknown) => ({ status: "rejected", error: errorMessage(error) })
  );

  const firstResponsePromise = fetch(`${redirectUri}/?code=first&state=${getState()}`, {
    redirect: "manual",
  });
  await callbackStarted;

  let duplicateResponse;
  let outcomeBeforeRelease;
  try {
    duplicateResponse = await fetch(`${redirectUri}/?code=duplicate&state=${getState()}`, {
      redirect: "manual",
    });
    outcomeBeforeRelease = await Promise.race([
      flowOutcome,
      new Promise((resolve) => setTimeout(() => resolve("pending"), 200)),
    ]);
  } finally {
    releaseHandleCallback();
  }

  const firstResponse = await firstResponsePromise;
  assert.equal(duplicateResponse.status, 400);
  assert.equal(outcomeBeforeRelease, "pending");
  assert.equal(getCallbackCount(), 1);
  assert.equal(firstResponse.status, 200);
  assert.deepEqual(await flowOutcome, {
    status: "resolved",
    result: { code: "first" },
  });
});

test("an accepted callback cannot run after a malformed request rejects the flow", async () => {
  let callbackCount = 0;
  const { flow, server, getRedirectUri, getState } = startFlow(async () => {
    callbackCount += 1;
    return { ok: true };
  });
  const redirectUri = await waitForListen(getRedirectUri);
  const parkedRequest = await parkPartialRequest(redirectUri, server);
  const rejected = assert.rejects(flow, /Invalid URL/);

  try {
    assert.equal(await requestPath(redirectUri, "//["), 400);
    await rejected;

    const lateStatus = await parkedRequest.complete(`?code=late&state=${getState()}`);
    assert.equal(lateStatus, 400);
    assert.equal(callbackCount, 0);
  } finally {
    parkedRequest.destroy();
  }
});

test("an accepted callback cannot run after the flow times out", async () => {
  let callbackCount = 0;
  const { flow, server, getRedirectUri, getState, triggerTimeout } = startFlowWithControlledTimeout(
    async () => {
      callbackCount += 1;
      return { ok: true };
    }
  );
  const redirectUri = await waitForListen(getRedirectUri);
  const parkedRequest = await parkPartialRequest(redirectUri, server);
  const rejected = assert.rejects(flow, /OAuth flow timed out/);

  try {
    triggerTimeout();
    await rejected;

    const lateStatus = await parkedRequest.complete(`?code=late&state=${getState()}`);
    assert.equal(lateStatus, 400);
    assert.equal(callbackCount, 0);
  } finally {
    parkedRequest.destroy();
  }
});
