const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const Module = require("node:module");

const { EventEmitter }: typeof import("node:events") = require("node:events");

import type { OnnxWorkerClient } from "../../src/helpers/onnxWorkerClient.ts";

const clientModulePath = require.resolve("../../src/helpers/onnxWorkerClient.ts");

const originalLoad = Module._load;

// A fake utility-process graph: MessageChannelMain ports are EventEmitters
// wired both ways, and fork() returns a scripted child the test controls.
function createFakeRuntime({ neverSpawn = false, exitOnShutdown = true } = {}) {
  class FakePort extends EventEmitter {
    peer: FakePort | null;
    closed = false;
    constructor(peer: FakePort | null) {
      super();
      this.peer = peer;
    }
    postMessage(message: unknown) {
      if (!this.closed) this.peer?.emit("message", { data: message });
    }
    start() {}
    close() {
      this.closed = true;
    }
  }

  class FakeMessageChannelMain {
    port1: InstanceType<typeof FakePort>;
    port2: InstanceType<typeof FakePort>;
    constructor() {
      const a = new FakePort(null);
      const b = new FakePort(a);
      a.peer = b;
      this.port1 = a;
      this.port2 = b;
    }
  }

  class FakeChild extends EventEmitter {
    pid = 4242;
    stderr = new EventEmitter();
    stdout = new EventEmitter();
    killCalls = 0;
    kill() {
      this.killCalls += 1;
    }
    postMessage(_message: unknown, [port]: FakePort[]) {
      port.on("message", ({ data }: { data: unknown }) => {
        if (
          exitOnShutdown &&
          data &&
          typeof data === "object" &&
          "method" in data &&
          data.method === "shutdown"
        ) {
          setImmediate(() => this.emit("exit", 0));
        }
      });
    }
  }

  const state = {
    children: [] as FakeChild[],
    forkCalls: 0,
    MessageChannelMain: FakeMessageChannelMain,
    makeChild,
  };

  function makeChild() {
    const child = new FakeChild();

    if (!neverSpawn) setImmediate(() => child.emit("spawn"));
    state.children.push(child);
    state.forkCalls += 1;

    return child;
  }

  return state;
}

function loadClient(
  runtime: ReturnType<typeof createFakeRuntime>
): OnnxWorkerClient & { OnnxWorkerClient: typeof OnnxWorkerClient } {
  delete require.cache[clientModulePath];
  Module._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "electron") {
      return {
        app: { getPath: () => "/tmp" },
        utilityProcess: { fork: () => runtime.makeChild() },
        MessageChannelMain: runtime.MessageChannelMain,
      };
    }

    if (request === "./debugLogger" || request === "./debugLogger.js") {
      return new Proxy({}, { get: () => () => {} });
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(clientModulePath) as OnnxWorkerClient & {
      OnnxWorkerClient: typeof OnnxWorkerClient;
    };
  } finally {
    Module._load = originalLoad;
  }
}

// Waits until the spawned client has its port, then hands the test a
// deliver() that injects a reply as if the worker sent it.
function whenPortReady(client: OnnxWorkerClient) {
  return new Promise<(message: unknown) => void>((resolve, reject) => {
    const poll = setInterval(() => {
      if (client.port) {
        clearInterval(poll);
        clearTimeout(timeout);

        // Replies travel the way a real worker sends them: port2.postMessage
        // delivers to the client's port1 listener.
        const peer = (
          client.port as InstanceType<
            ReturnType<typeof createFakeRuntime>["MessageChannelMain"]
          >["port1"]
        ).peer;

        assert.ok(peer);
        resolve((message: unknown) => peer.postMessage(message));
      }
    }, 1);

    const timeout = setTimeout(() => {
      clearInterval(poll);
      reject(new Error("worker port was not ready"));
    }, 1000);
  });
}

const PING_OK = { ok: true, sessions: { speaker: false } };

test("a ping round trip resolves through the port and clears pending", async () => {
  const runtime = createFakeRuntime();
  const client = loadClient(runtime);
  const request = client.request("ping", {});
  const deliver = await whenPortReady(client);
  deliver({ id: 1, result: PING_OK });
  assert.deepEqual(await request, PING_OK);
  assert.equal(client.pending.size, 0);
  await client.stop();
});

test("malformed replies are dropped before pending resolution", async () => {
  const runtime = createFakeRuntime();
  const client = loadClient(runtime);
  const request = client.request("ping", {});
  const deliver = await whenPortReady(client);

  const badReplies = [
    null,
    "string",
    {},
    { id: "not-a-number", result: PING_OK },
    { id: 1 }, // neither result nor error
    { id: 1, error: { message: 42 } },
    { id: 1, error: "plain-string" },
  ];

  for (const bad of badReplies) deliver(bad);

  assert.equal(client.pending.size, 1, "no malformed reply may settle the request");
  deliver({ id: 1, result: PING_OK });
  assert.deepEqual(await request, PING_OK);
  await client.stop();
});

test("a reply for a foreign id never settles the live request", async () => {
  const runtime = createFakeRuntime();
  const client = loadClient(runtime);
  const request = client.request("ping", {});
  const deliver = await whenPortReady(client);
  // A late reply carrying a stale/foreign id is dropped by the pending map.
  deliver({ id: 999, result: PING_OK });
  deliver({ id: 999, error: { message: "stale" } });
  assert.equal(client.pending.size, 1);

  deliver({ id: 1, result: { ok: true, sessions: { speaker: true } } });
  assert.deepEqual(await request, { ok: true, sessions: { speaker: true } });
  assert.equal(client.pending.size, 0);
  await client.stop();
});

test("an error reply rejects with the worker's message", async () => {
  const runtime = createFakeRuntime();
  const client = loadClient(runtime);
  const request = client.request("speaker.extract", { samplesBuffer: new ArrayBuffer(8) });
  const deliver = await whenPortReady(client);
  deliver({ id: 1, error: { message: "speaker session not loaded" } });
  await assert.rejects(request, /speaker session not loaded/);
  await client.stop();
});

test("a worker crash rejects every pending request exactly once", async () => {
  const runtime = createFakeRuntime();
  const client = loadClient(runtime);
  const first = client.request("ping", {});
  const second = client.request("ping", {});
  await whenPortReady(client);
  runtime.children[0].emit("exit", 1);

  const outcomes = await Promise.allSettled([first, second]);

  for (const outcome of outcomes) {
    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.reason.name, "WorkerCrashedError");
  }

  assert.equal(client.pending.size, 0);

  // Respawn is scheduled with backoff; requests during the window fail fast.
  await assert.rejects(client.request("ping", {}), /worker restarting/);

  // Cancel the respawn timer so the suite does not carry it.
  await client.stop();
});

test("stop during a stuck spawn returns immediately and flags shutdown", async () => {
  const runtime = createFakeRuntime({ neverSpawn: true });
  const client = loadClient(runtime);

  const request = client.request("ping", {});
  const stop = client.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.shuttingDown, true);
  // The spawn never completed, so stop() has no child to wait for.
  await stop;
  // Silence the stillborn request: its spawn promise never settles here.
  request.catch(() => {});
});

test("the queue limit evicts the oldest pending request", async () => {
  const runtime = createFakeRuntime();
  const loaded = loadClient(runtime);
  const { OnnxWorkerClient } = loaded;
  const client = new OnnxWorkerClient();
  let evictedName = null;

  for (let id = 1; id <= 1000; id += 1) {
    client.pending.set(id, {
      resolve: () => {},
      reject: (err: Error) => {
        if (id === 1) evictedName = err.name;
      },
      timeout: setTimeout(() => {}, 10_000),
    });
  }

  const request = client.request("ping", {});
  assert.equal(evictedName, "WorkerOverloadedError");

  // The new entry is only filed once the spawn completes.
  const deliver = await whenPortReady(client);
  assert.equal(client.pending.size, 1000);
  deliver({ id: 1, result: PING_OK });
  assert.deepEqual(await request, PING_OK);
  await client.stop();
});

test("stop sends the shutdown rpc and waits for exit before killing", async () => {
  const runtime = createFakeRuntime({ exitOnShutdown: false });
  const client = loadClient(runtime);
  const warm = client.request("ping", {});
  const warmDeliver = await whenPortReady(client);
  warmDeliver({ id: 1, result: PING_OK });
  await warm;

  let shutdownSeen = null;

  const port = client.port as InstanceType<
    ReturnType<typeof createFakeRuntime>["MessageChannelMain"]
  >["port1"];

  assert.ok(port.peer);
  port.peer.on("__inspect", () => {});
  // Capture the shutdown rpc on the worker side of the channel.
  const originalPost = port.peer.emit.bind(port.peer);
  port.peer.emit = function (event: string | symbol, payload: unknown) {
    if (
      event === "message" &&
      payload &&
      typeof payload === "object" &&
      "data" in payload &&
      payload.data &&
      typeof payload.data === "object" &&
      "method" in payload.data &&
      payload.data.method === "shutdown"
    ) {
      shutdownSeen = payload.data;
    }

    return originalPost(event, payload);
  };

  const child = runtime.children[0];
  const stopped = client.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(shutdownSeen, "shutdown rpc must be posted");
  assert.equal(child.killCalls, 0, "the child gets its exit grace period");
  child.emit("exit", 0);
  await stopped;
});

test("stop kills a child that ignores shutdown after its grace period", async (t: import("node:test").TestContext) => {
  const runtime = createFakeRuntime({ exitOnShutdown: false });
  const client = loadClient(runtime);
  const warm = client.request("ping", {});
  const deliver = await whenPortReady(client);
  deliver({ id: 1, result: PING_OK });
  await warm;

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = runtime.children[0];
  const stopped = client.stop();
  t.mock.timers.tick(4999);
  assert.equal(child.killCalls, 0);
  t.mock.timers.tick(1);
  await stopped;
  assert.equal(child.killCalls, 1);
});
