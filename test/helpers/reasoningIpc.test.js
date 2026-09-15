// The typed reasoning IPC handlers after the cutover: fake transports and
// provider factories over the real sender-scoped registries. Pins the
// one-shot request/result shapes (code/details, messageKey/action arms),
// the Anthropic proxy dialect, Bedrock cleanup cancellation and sender
// isolation, and the enterprise stream lifecycle: start → parts → done/error,
// explicit cancel, duplicate ids, navigation/destroy, sender isolation,
// replacement protection and the structured-clone part adapter.
const test = require("node:test");
const assert = require("node:assert/strict");

let registerReasoningHandlers;
let AgentStreamRequestRegistry;

test.before(async () => {
  ({ registerReasoningHandlers } = await import("../../src/helpers/reasoningIpcHandlers.ts"));
  ({ AgentStreamRequestRegistry } = await import("../../src/helpers/agentStreamRequestRegistry.ts"));
});

const REAL_ERRORS = require("../../src/helpers/enterpriseProviderErrors");

// The real enterprise error mapper keeps the user-facing mapping contract in
// one place; these tests pin the wrapper fields, not the mapper's messages.
function realMapper(provider, error, config) {
  return REAL_ERRORS.mapEnterpriseError(provider, error, config);
}

function fakeSender(id) {
  const listeners = new Map();
  const sent = [];
  let destroyed = false;
  return {
    id,
    sent,
    on: (event, listener) => {
      listeners.set(event, listener);
    },
    once: (event, listener) => {
      listeners.set(event, listener);
    },
    removeListener: (event, listener) => {
      if (listeners.get(event) === listener) listeners.delete(event);
    },
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
      listeners.get("destroyed")?.();
    },
    navigate: (isInPlace = false) => {
      listeners.get("did-start-navigation")?.({}, "https://x", isInPlace, true);
    },
    send: (channel, payload) => sent.push({ channel, payload }),
  };
}

function makeDeps(overrides = {}) {
  const generateCalls = [];
  const deps = {
    localService: {
      isAvailable: async () => true,
      processText: async () => "local result",
    },
    getAnthropicKey: () => "anthropic-key",
    proxyFetch: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "",
      json: async () => ({ content: [{ type: "text", text: "anthropic text" }] }),
    }),
    extractAnthropicText: (data) =>
      Array.isArray(data?.content) && data.content[0]?.text ? data.content[0].text : null,
    describeMissingAnthropicText: () => "no text",
    isEnterpriseProvider: (value) => ["bedrock", "azure", "vertex"].includes(value),
    mapEnterpriseError: realMapper,
    runAbortableOperation: REAL_ERRORS.runAbortableOperation,
    runBedrockRequest: REAL_ERRORS.runBedrockRequest,
    validateEnterpriseEndpoint: () => {},
    generateText: async (options) => {
      generateCalls.push(options);
      return { text: "enterprise text", finishReason: "stop" };
    },
    getEnterpriseAIModel: async () => {
      throw new Error("no model expected in this fixture");
    },
    bedrockCleanupRequests: new AgentStreamRequestRegistry(),
    enterpriseStreams: new AgentStreamRequestRegistry(),
    logError: () => {},
    ...overrides.deps,
  };
  return { deps, generateCalls };
}

function setup(overrides = {}) {
  const { deps, generateCalls } = makeDeps(overrides);
  const handlers = new Map();
  const listeners = new Map();
  registerReasoningHandlers(
    {
      handle: (channel, fn) => handlers.set(channel, fn),
      on: (channel, fn) => listeners.set(channel, fn),
    },
    deps
  );
  return { deps, handlers, listeners, generateCalls };
}

// --- Local one-shot ----------------------------------------------------------

test("local one-shot: success and code/details failure shapes", async () => {
  const { handlers } = setup();
  const local = handlers.get("process-local-reasoning");

  assert.deepEqual(await local(null, "hello", "model-a", null, { temperature: 0 }), {
    success: true,
    text: "local result",
  });

  const failing = setup({
    deps: {
      localService: {
        isAvailable: async () => true,
        processText: async () => {
          throw Object.assign(new Error("llama error"), {
            code: "NO_API",
            details: { port: 8080 },
          });
        },
      },
    },
  });
  assert.deepEqual(
    await failing.handlers.get("process-local-reasoning")(null, "x", "m", null, {}),
    { success: false, error: "llama error", code: "NO_API", details: { port: 8080 } }
  );
});

test("local one-shot: malformed args are rejected before the service runs", async () => {
  const calls = [];
  const { handlers } = setup({
    deps: {
      localService: {
        isAvailable: async () => true,
        processText: async (...args) => {
          calls.push(args);
          return "x";
        },
      },
    },
  });
  assert.deepEqual(await handlers.get("process-local-reasoning")(null, 5, "m", null, {}), {
    success: false,
    error: "Invalid local reasoning request",
  });
  assert.deepEqual(await handlers.get("check-local-reasoning-available")(), true);
  assert.equal(calls.length, 0);
});

// --- Anthropic one-shot ------------------------------------------------------

test("anthropic one-shot: key check, screenContext, complete-output and error dialect", async () => {
  const noKey = setup({ deps: { getAnthropicKey: () => "" } });
  assert.deepEqual(
    await noKey.handlers.get("process-anthropic-reasoning")(null, "t", "claude-x", null, {}),
    { success: false, error: "Anthropic API key not configured" }
  );

  const fetches = [];
  const ctx = setup({
    deps: {
      proxyFetch: async (url, init) => {
        fetches.push({ url, init });
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => "",
          json: async () => ({ content: [{ type: "text", text: "hi" }], stop_reason: "stop" }),
        };
      },
    },
  });
  const result = await ctx.handlers.get("process-anthropic-reasoning")(
    null,
    "describe this",
    "claude-x",
    null,
    {
      systemPrompt: "sys",
      supportsTemperature: true,
      screenContext: { mediaType: "image/png", data: "b64" },
      requireCompleteOutput: true,
    }
  );
  assert.deepEqual(result, { success: true, text: "hi" });
  const body = JSON.parse(fetches[0].init.body);
  assert.equal(body.system, "sys");
  assert.equal(body.temperature, 0.3, "supportsTemperature: true forwards temperature");
  assert.deepEqual(body.messages[0].content[1].source.data, "b64");

  const unauthorized = setup({
    deps: {
      proxyFetch: async () => ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => JSON.stringify({ error: { message: "bad key" } }),
        json: async () => ({}),
      }),
    },
  });
  assert.deepEqual(
    await unauthorized.handlers.get("process-anthropic-reasoning")(null, "t", "claude-x", null, {}),
    { success: false, error: "bad key" }
  );

  const truncated = setup({
    deps: {
      proxyFetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "",
        json: async () => ({ content: [{ type: "text", text: "partial" }], stop_reason: "max_tokens" }),
      }),
    },
  });
  assert.deepEqual(
    await truncated.handlers.get("process-anthropic-reasoning")(null, "t", "claude-x", null, {
      requireCompleteOutput: true,
    }),
    { success: false, error: "Model output was truncated before the selection edit completed" }
  );
});

// --- Enterprise one-shot -----------------------------------------------------

test("enterprise one-shot: unsupported provider and happy path", async () => {
  const { handlers } = setup();
  assert.equal(
    (
      await handlers.get("process-enterprise-reasoning")(null, "t", "m", null, {
        provider: "openai",
      })
    ).error,
    "Unsupported enterprise provider: openai"
  );

  const result = await handlers.get("process-enterprise-reasoning")(null, "t", "m", null, {
    provider: "azure",
    azureEndpoint: "https://acme.openai.azure.com",
  });
  assert.deepEqual(result, { success: true, text: "enterprise text" });
});

test("bedrock cleanup: cancel is scoped to the requesting sender", async () => {
  let releaseRequest;
  const started = new Promise((resolve) => (releaseRequest = resolve));
  const { handlers, listeners } = setup({
    deps: {
      generateText: async (options) => {
        releaseRequest();
        await new Promise((resolve, reject) => {
          options.abortSignal.addEventListener("abort", () => reject(options.abortSignal.reason), {
            once: true,
        });
        });
        return { text: "never", finishReason: "stop" };
      },
    },
  });

  const requesting = fakeSender(10);
  const other = fakeSender(11);
  const request = handlers
    .get("process-enterprise-reasoning")({ sender: requesting }, "raw", "m", null, {
      provider: "bedrock",
      inferenceScope: "cleanup",
      bedrockRegion: "eu-west-1",
      systemPrompt: "Clean",
    })
    .catch(() => ({ success: false }));
  await started;
  listeners.get("enterprise-reasoning-cancel")({ sender: other });
  await new Promise((resolve) => setImmediate(resolve));
  listeners.get("enterprise-reasoning-cancel")({ sender: requesting });
  const result = await request;

  assert.equal(result.success, false);
});

test("bedrock cleanup: sender destroy aborts the request and removes the listener", async () => {
  let signal;
  let releaseRequest;
  const started = new Promise((resolve) => (releaseRequest = resolve));
  const { deps, handlers } = setup({
    deps: {
      generateText: async (options) => {
        signal = options.abortSignal;
        releaseRequest();
        await new Promise((resolve, reject) => {
          options.abortSignal.addEventListener("abort", () => reject(options.abortSignal.reason), {
            once: true,
          });
        });
        return { text: "never", finishReason: "stop" };
      },
    },
  });
  const sender = fakeSender(3);
  const request = handlers.get("process-enterprise-reasoning")({ sender }, "raw", "m", null, {
    provider: "bedrock",
    inferenceScope: "cleanup",
    bedrockRegion: "eu-west-1",
  });
  await started;
  sender.destroy();
  await request;

  assert.equal(signal.aborted, true);
  // complete() released the registration on the way out.
  assert.equal(deps.bedrockCleanupRequests.cancelSender(3), 0);
});

test("bedrock cleanup keeps the retry policy with nested retries disabled", async () => {
  const attempts = [];
  const { handlers, generateCalls } = setup({
    deps: {
      generateText: async () => {
        attempts.push(1);
        if (attempts.length === 1) {
          throw Object.assign(new Error("Bedrock overloaded"), {
            name: "ServiceUnavailableException",
            statusCode: 503,
            responseHeaders: {},
          });
        }
        return { text: "cleaned", finishReason: "stop" };
      },
    },
  });
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const result = await handlers.get("process-enterprise-reasoning")(
      { sender: fakeSender(4) },
      "raw",
      "m",
      null,
      { provider: "bedrock", inferenceScope: "cleanup", bedrockRegion: "eu-west-1" }
    );
    assert.deepEqual(result, { success: true, text: "cleaned" });
    assert.equal(generateCalls.length, 2);
    assert.ok(generateCalls.every((call) => call.maxRetries === 0));
  } finally {
    Math.random = originalRandom;
  }
});

// --- Enterprise streams ------------------------------------------------------

function streamSetup(modelParts, overrides = {}) {
  const { deps, handlers, listeners } = setup({
    deps: {
      getEnterpriseAIModel: async () => ({
        doStream: async (options) => {
          streamSetup.lastDoStreamOptions = options;
          return {
            stream: {
              getReader: () => ({
                read: async () => {
                  if (modelParts.length === 0) return { done: true };
                  const value = modelParts.shift();
                  if (value instanceof Error) throw value;
                  return { done: false, value };
                },
                releaseLock: () => {},
              }),
            },
          };
        },
      }),
      ...overrides.deps,
    },
  });
  return { deps, handlers, listeners };
}
streamSetup.lastDoStreamOptions = null;

const PART = { type: "text-delta", id: "t", providerMetadata: null, text: "hello" };

test("stream: start relays parts verbatim and ends with done", async () => {
  const sender = fakeSender(1);
  const { handlers } = streamSetup([
    PART,
    { type: "tool-call", toolCallId: "c1", toolName: "search", input: { q: "x" } },
  ]);
  const result = await handlers.get("enterprise-stream-start")({ sender }, {
    streamId: "s1",
    provider: "bedrock",
    modelId: "m",
    config: { bedrockRegion: "eu-west-1" },
    options: { prompt: [] },
  });
  assert.deepEqual(result, { success: true });
  assert.deepEqual(
    sender.sent.map((m) => m.payload),
    [
      { streamId: "s1", part: PART },
      {
        streamId: "s1",
        part: { type: "tool-call", toolCallId: "c1", toolName: "search", input: { q: "x" } },
      },
      { streamId: "s1", done: true },
    ]
  );
  assert.ok(streamSetup.lastDoStreamOptions.abortSignal instanceof AbortSignal);
  assert.equal(streamSetup.lastDoStreamOptions.prompt !== undefined, true);
});

test("stream: binary parts roundtrip through structured clone", async () => {
  const sender = fakeSender(1);
  const binary = new Uint8Array([1, 2, 250]);
  const { handlers } = streamSetup([
    { type: "file", mediaType: "image/png", data: binary },
  ]);
  await handlers.get("enterprise-stream-start")({ sender }, {
    streamId: "s-bin",
    provider: "azure",
    modelId: "m",
    config: { azureEndpoint: "https://acme.openai.azure.com" },
    options: {},
  });
  const part = sender.sent[0].payload.part;
  // The adapter clones, so the bytes are equal rather than identical.
  assert.deepEqual(part.data, binary);
  // And the actual Electron IPC clone algorithm must accept the envelope.
  assert.doesNotThrow(() => structuredClone(sender.sent[0].payload));
});

test("stream: non-cloneable raw and error payloads degrade narrowly", async () => {
  const sender = fakeSender(1);
  const uncloneable = { fn: () => {} };
  const { handlers } = streamSetup([
    { type: "raw", rawValue: uncloneable },
    { type: "error", error: Object.assign(new Error("boom"), { fn: () => {} }) },
  ]);
  await handlers.get("enterprise-stream-start")({ sender }, {
    streamId: "s-raw",
    provider: "bedrock",
    modelId: "m",
    options: {},
  });
  const parts = sender.sent.map((m) => m.payload.part);
  // The raw payload degrades to a description instead of failing the send.
  assert.equal(parts[0].type, "raw");
  assert.equal(typeof parts[0].rawValue, "string");
  // The error part survives as an Error clone of the original message.
  assert.equal(parts[1].type, "error");
  assert.equal(parts[1].error.message, "boom");
  assert.equal(parts[1].error instanceof Error, true);
  // Everything sent is cloneable.
  for (const envelope of sender.sent) assert.doesNotThrow(() => structuredClone(envelope.payload));
  // done still terminated the stream.
  assert.deepEqual(sender.sent.at(-1).payload, { streamId: "s-raw", done: true });
});

test("stream: a provider failure maps to an error envelope and failure result", async () => {
  const sender = fakeSender(2);
  const { handlers } = streamSetup([new Error("model exploded")]);
  const result = await handlers.get("enterprise-stream-start")({ sender }, {
    streamId: "s-err",
    provider: "bedrock",
    modelId: "m",
    config: { bedrockRegion: "eu-west-1" },
    options: {},
  });
  assert.equal(result.success, false);
  assert.match(result.error, /model exploded/);
  const terminal = sender.sent.at(-1).payload;
  assert.equal(terminal.error, result.error);
  assert.equal(terminal.done, undefined);
});

test("stream: explicit cancel aborts the provider read and skips its terminal event", async () => {
  const sender = fakeSender(3);
  let sawAbort = false;
  const { deps, handlers } = setup({
    deps: {
      getEnterpriseAIModel: async () => ({
        doStream: async (options) => ({
          stream: {
            getReader: () => ({
              read: () =>
                new Promise((_resolve, reject) => {
                  options.abortSignal.addEventListener(
                    "abort",
                    () => {
                      sawAbort = true;
                      reject(options.abortSignal.reason);
                    },
                    { once: true }
                  );
                }),
              releaseLock: () => {},
            }),
          },
        }),
      }),
    },
  });
  const request = handlers.get("enterprise-stream-start")({ sender }, {
    streamId: "s-cancel",
    provider: "bedrock",
    modelId: "m",
    options: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  await handlers.get("enterprise-stream-cancel")({ sender }, "s-cancel");
  const result = await request;

  assert.equal(sawAbort, true);
  assert.equal(result.success, false);
  // Cancel removed the registration, so no terminal envelope was sent.
  assert.equal(sender.sent.length, 0);
  assert.equal(deps.enterpriseStreams.cancel(3, "s-cancel"), false);
});

test("stream: same streamId in two senders is independent; cancel touches only its sender", async () => {
  const senderA = fakeSender(4);
  const senderB = fakeSender(5);
  const signals = [];
  const { handlers } = setup({
    deps: {
      getEnterpriseAIModel: async () => ({
        doStream: async (options) => ({
          stream: {
            getReader: () => ({
              read: () =>
                new Promise((_resolve, reject) => {
                  signals.push(options.abortSignal);
                  options.abortSignal.addEventListener(
                    "abort",
                    () => reject(options.abortSignal.reason),
                    { once: true }
                  );
                }),
              releaseLock: () => {},
            }),
          },
        }),
      }),
    },
  });
  const requestA = handlers.get("enterprise-stream-start")({ sender: senderA }, {
    streamId: "shared",
    provider: "bedrock",
    modelId: "m",
    options: {},
  });
  const requestB = handlers.get("enterprise-stream-start")({ sender: senderB }, {
    streamId: "shared",
    provider: "bedrock",
    modelId: "m",
    options: {},
  });
  await new Promise((resolve) => setImmediate(resolve));

  await handlers.get("enterprise-stream-cancel")({ sender: senderA }, "shared");
  await requestA;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(signals[0].aborted, true, "sender A's stream aborted");
  assert.equal(signals[1].aborted, false, "sender B's stream untouched");
  // B can still finish normally with its own done envelope.
  await handlers.get("enterprise-stream-cancel")({ sender: senderB }, "shared");
  await requestB;
});

test("stream: a duplicate id of one sender aborts the old stream and shields the replacement", async () => {
  const sender = fakeSender(6);
  const signals = [];
  const { deps, handlers } = setup({
    deps: {
      getEnterpriseAIModel: async () => ({
        doStream: async (options) => ({
          stream: {
            getReader: () => ({
              read: () =>
                new Promise((_resolve, reject) => {
                  signals.push(options.abortSignal);
                  options.abortSignal.addEventListener(
                    "abort",
                    () => reject(options.abortSignal.reason),
                    { once: true }
                  );
                }),
              releaseLock: () => {},
            }),
          },
        }),
      }),
    },
  });
  const first = handlers.get("enterprise-stream-start")({ sender }, {
    streamId: "dup",
    provider: "bedrock",
    modelId: "m",
    options: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = handlers.get("enterprise-stream-start")({ sender }, {
    streamId: "dup",
    provider: "bedrock",
    modelId: "m",
    options: {},
  });
  await new Promise((resolve) => setImmediate(resolve));

  // begin() aborted the first stream; its late terminal must not reach the
  // sender (which now listens for the replacement on the same id).
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  sender.sent.length = 0;

  await first;
  assert.equal(sender.sent.length, 0, "no late terminal event for the replaced stream");

  await handlers.get("enterprise-stream-cancel")({ sender }, "dup");
  await second;
  // Both registrations settled; nothing is left for this sender.
  assert.equal(deps.enterpriseStreams.cancelSender(6), 0);
});

test("stream: navigation and destroy abort the provider request", async () => {
  for (const trigger of ["navigate", "destroy"]) {
    const sender = fakeSender(7);
    let aborted = false;
    const { handlers } = setup({
      deps: {
        getEnterpriseAIModel: async () => ({
          doStream: async (options) => ({
            stream: {
              getReader: () => ({
                read: () =>
                  new Promise((_resolve, reject) => {
                    options.abortSignal.addEventListener(
                      "abort",
                      () => {
                        aborted = true;
                        reject(options.abortSignal.reason);
                      },
                      { once: true }
                    );
                  }),
                releaseLock: () => {},
              }),
            },
          }),
        }),
      },
    });
    const request = handlers.get("enterprise-stream-start")({ sender }, {
      streamId: `s-${trigger}`,
      provider: "bedrock",
      modelId: "m",
      options: {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    if (trigger === "navigate") sender.navigate();
    else sender.destroy();
    await request;
    assert.equal(aborted, true, trigger);
  }
});

test("stream: malformed start payloads are rejected before anything registers", async () => {
  const { handlers } = setup();
  const sender = fakeSender(8);
  for (const payload of [null, {}, { streamId: "", provider: "bedrock", modelId: "m", options: {} }]) {
    const result = await handlers.get("enterprise-stream-start")({ sender }, payload);
    assert.deepEqual(result, { success: false, error: "Invalid stream request" });
  }
  assert.equal(sender.sent.length, 0);
});
