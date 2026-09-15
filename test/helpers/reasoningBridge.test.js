// The real bundled preload talks to the real typed reasoning handlers over
// fake transports: one-shot shapes crossing the wire, malformed main
// responses rejected at the preload boundary, stream envelopes forwarded with
// malformed ones dropped before the callback, unsubscribe, and the shared
// main registration duplicate-channel guard.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

const root = path.resolve(__dirname, "../..");
const bundledPreload = path.join(root, "dist-main", "preload.js");

let activeHandlers = new Map();

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => "/tmp",
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
      ipcMain: {
        handle: (channel, listener) => {
          if (activeHandlers.has(channel)) {
            throw new Error(`Attempted to register a second handler for '${channel}'`);
          }
          activeHandlers.set(channel, listener);
        },
        on: (channel, listener) => activeHandlers.set(channel, listener),
        removeHandler() {},
        emit() {},
      },
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
process.env.NODE_ENV = "test";

test.after(() => {
  Module._load = originalLoad;
});

function loadBundledPreload(transport) {
  let api;
  vm.runInNewContext(fs.readFileSync(bundledPreload, "utf8"), {
    require(name) {
      assert.equal(name, "electron", "the bundled preload must only require electron");
      return {
        contextBridge: {
          exposeInMainWorld: (_name, value) => {
            api = value;
          },
        },
        ipcRenderer: {
          invoke: (channel, ...args) => transport.invoke(channel, ...args),
          send: (channel, ...args) => transport.send(channel, ...args),
          on: (channel, listener) => transport.on(channel, listener),
          removeListener: (channel, listener) => transport.removeListener(channel, listener),
        },
        webUtils: { getPathForFile: () => "" },
      };
    },
    process: { platform: "darwin", versions: {} },
    console,
  });
  return api;
}

// Objects from vm.runInNewContext have a different prototype; compare by JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

async function createFixture() {
  assert.ok(fs.existsSync(bundledPreload), "Run pnpm run build:main first");
  activeHandlers = new Map();
  const ipcMain = {
    handle: (channel, listener) => activeHandlers.set(channel, listener),
    on: (channel, listener) => activeHandlers.set(channel, listener),
  };

  const { AgentStreamRequestRegistry } = await import(
    "../../src/helpers/agentStreamRequestRegistry.ts"
  );
  const { registerReasoningHandlers } = await import("../../src/helpers/reasoningIpcHandlers.ts");
  const REAL_ERRORS = require("../../src/helpers/enterpriseProviderErrors");

  registerReasoningHandlers(ipcMain, {
    localService: {
      isAvailable: async () => true,
      processText: async () => "local text",
    },
    getAnthropicKey: () => "key",
    proxyFetch: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "",
      json: async () => ({ content: [{ type: "text", text: "anthropic text" }] }),
    }),
    extractAnthropicText: (data) => data?.content?.[0]?.text ?? null,
    describeMissingAnthropicText: () => "no text",
    isEnterpriseProvider: (value) => ["bedrock", "azure", "vertex"].includes(value),
    mapEnterpriseError: REAL_ERRORS.mapEnterpriseError,
    runAbortableOperation: REAL_ERRORS.runAbortableOperation,
    runBedrockRequest: REAL_ERRORS.runBedrockRequest,
    validateEnterpriseEndpoint: () => {},
    generateText: async () => ({ text: "enterprise", finishReason: "stop" }),
    getEnterpriseAIModel: async () => ({
      doStream: async () => ({
        stream: {
          getReader: () => ({
            read: async () => ({ done: true }),
            releaseLock: () => {},
          }),
        },
      }),
    }),
    bedrockCleanupRequests: new AgentStreamRequestRegistry(),
    enterpriseStreams: new AgentStreamRequestRegistry(),
    logError: () => {},
  });

  const sends = [];
  const listeners = new Map();
  const handlersSnapshot = new Map(activeHandlers);
  const transport = {
    invoke: async (channel, ...args) => {
      const handler = handlersSnapshot.get(channel);
      if (!handler) throw new Error(`No handler for ${channel}`);
      return handler({ sender: fixtureSender }, ...args);
    },
    send: (channel, ...args) => sends.push({ channel, args }),
    on: (channel, listener) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(listener);
    },
    removeListener: (channel, listener) => {
      listeners.get(channel)?.delete(listener);
    },
  };

  const fixtureSender = {
    id: 77,
    isDestroyed: () => false,
    send: (channel, payload) => {
      for (const listener of listeners.get(channel) ?? []) listener({}, payload);
    },
    on: () => {},
    once: () => {},
    removeListener: () => {},
  };

  const api = loadBundledPreload(transport);
  return { api, sends, listeners, fixtureSender };
}

test("one-shot operations cross the bundled preload boundary", async () => {
  const { api } = await createFixture();

  assert.deepEqual(
    plain(await api.processLocalReasoning("hi", "model-a", null, { temperature: 0 })),
    { success: true, text: "local text" }
  );
  assert.equal(await api.checkLocalReasoningAvailable(), true);
  assert.deepEqual(
    plain(await api.processAnthropicReasoning("hi", "claude", null, {})),
    { success: true, text: "anthropic text" }
  );
  assert.deepEqual(
    plain(
      await api.processEnterpriseReasoning("hi", "m", null, {
        provider: "azure",
        azureEndpoint: "https://acme.openai.azure.com",
      })
    ),
    { success: true, text: "enterprise" }
  );

  api.cancelEnterpriseReasoning();
});

test("stream start/cancel cross the boundary and envelopes reach the callback", async () => {
  const { api, listeners, fixtureSender } = await createFixture();
  const received = [];
  const unsubscribe = api.onEnterpriseStreamPart((envelope) => received.push(envelope));

  const started = api.enterpriseStreamStart({
    streamId: "s1",
    provider: "bedrock",
    modelId: "m",
    options: {},
  });
  // The fake model finishes immediately, so the handler's own terminal lands
  // before the manual events below; wait it out first.
  await started;
  // Main relays a part and the terminal marker through the sender.
  for (const listener of listeners.get("enterprise-stream-part") ?? []) {
    listener({}, { streamId: "s1", part: { type: "text-delta", text: "x" } });
    listener({}, { streamId: "s1", done: true });
  }
  assert.deepEqual(plain(received), [
    { streamId: "s1", done: true },
    { streamId: "s1", part: { type: "text-delta", text: "x" } },
    { streamId: "s1", done: true },
  ]);

  unsubscribe();
  for (const listener of listeners.get("enterprise-stream-part") ?? []) {
    listener({}, { streamId: "s1", done: true });
  }
  assert.equal(received.length, 3, "unsubscribed listener receives nothing");

  await api.enterpriseStreamCancel("s1");
  void fixtureSender;
});

test("malformed envelopes are dropped before the callback", async () => {
  const { api, listeners } = await createFixture();
  const received = [];
  api.onEnterpriseStreamPart((envelope) => received.push(envelope));

  const malformed = [
    {},
    { streamId: "s1" },
    { streamId: "s1", part: { type: "text-delta" }, done: true },
    { streamId: "s1", done: true, error: "both" },
    { part: { type: "text-delta" } },
    null,
    "junk",
  ];
  for (const listener of listeners.get("enterprise-stream-part") ?? []) {
    for (const envelope of malformed) listener({}, envelope);
  }
  assert.deepEqual(received, [], "no malformed envelope reaches the callback");
});

test("junk main responses reject at the preload boundary", async () => {
  await createFixture();
  const realHandlers = new Map(activeHandlers);
  const api = loadBundledPreload({
    invoke: async (channel, ...args) => {
      if (channel === "process-local-reasoning") return { silentlyWrong: true };
      if (channel === "process-enterprise-reasoning") return { nope: 1 };
      if (channel === "check-local-reasoning-available") return "yes";
      if (channel === "enterprise-stream-start") return { noStart: true };
      return realHandlers.get(channel)(null, ...args);
    },
    send: () => {},
    on: () => {},
    removeListener: () => {},
  });
  await assert.rejects(api.processLocalReasoning("t", "m", null, {}));
  await assert.rejects(
    api.processEnterpriseReasoning("t", "m", null, { provider: "azure" })
  );
  await assert.rejects(api.checkLocalReasoningAvailable());
  await assert.rejects(
    api.enterpriseStreamStart({ streamId: "s", provider: "bedrock", modelId: "m", options: {} })
  );
});

test("the shared main registration registers every reasoning channel once", async () => {
  activeHandlers = new Map();

  const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
  delete require.cache[handlersModulePath];
  const IPCHandlers = require(handlersModulePath);
  const Ctor = IPCHandlers.default || IPCHandlers;

  const anything = () =>
    new Proxy(function () {}, {
      get: (_target, property) => {
        if (property === Symbol.toPrimitive || property === "toString") return () => "";
        if (property === "then") return undefined;
        if (property === "apply" || property === "call" || property === "bind") {
          return () => anything();
        }
        return anything();
      },
      apply: () => anything(),
    });

  const target = {};
  Ctor.prototype.setupHandlers.call(
    new Proxy(target, {
      get: (value, property) => (property in value ? value[property] : anything()),
    })
  );

  for (const channel of [
    "process-local-reasoning",
    "check-local-reasoning-available",
    "process-anthropic-reasoning",
    "process-enterprise-reasoning",
    "enterprise-reasoning-cancel",
    "enterprise-stream-start",
    "enterprise-stream-cancel",
  ]) {
    assert.ok(activeHandlers.get(channel), channel);
  }
});
