// The renderer's enterprise chat model shim against a stubbed electronAPI:
// subscription ordering, stream-id filtering, terminal cleanup (listener and
// abort listener removed exactly once), pre-aborted signals never starting a
// request, abort racing between subscribe and start, failed invokes and late
// terminal envelopes after done.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

let vitePromise;
const cleanup = [];
test.after(async () => {
  for (const close of cleanup) await close();
});

async function loadModel() {
  const vite = await (vitePromise ??= createRendererServer({ after: (close) => cleanup.push(close) }, {
    cachePrefix: "openh-enterprise-chat-model-",
  }));
  const module = await vite.moduleGraph.getModuleByUrl("/services/ai/enterpriseChatModel.ts");
  if (module) vite.moduleGraph.invalidateModule(module);
  return vite.ssrLoadModule("/services/ai/enterpriseChatModel.ts");
}

function stubApi() {
  const state = {
    starts: [],
    cancels: [],
    unsubscribed: 0,
    listeners: new Set(),
  };
  const push = (envelope) => {
    for (const listener of state.listeners) listener(envelope);
  };
  const api = {
    enterpriseStreamStart: async (payload) => {
      state.starts.push(payload);
      if (state.startBehavior) return state.startBehavior(payload);
      return { success: true };
    },
    enterpriseStreamCancel: async (streamId) => {
      state.cancels.push(streamId);
    },
    onEnterpriseStreamPart: (callback) => {
      state.listeners.add(callback);
      return () => {
        state.unsubscribed += 1;
        state.listeners.delete(callback);
      };
    },
    push,
  };
  // startBehavior lives on state (the start stub reads it); mirror assignments
  // to api.startBehavior so tests can set the behavior on either object.
  Object.defineProperty(api, "startBehavior", {
    get: () => state.startBehavior,
    set: (value) => {
      state.startBehavior = value;
    },
  });
  return { api, state };
}

test("parts flow, done settles, and both listeners are cleaned up once", async (t) => {
  const { api, state } = stubApi();
  installBrowserGlobals(t, { window: { electronAPI: api } });
  const { createEnterpriseChatModel } = await loadModel();

  const controller = new AbortController();
  const model = createEnterpriseChatModel("bedrock", "anthropic.claude-haiku");
  const { stream } = await model.doStream({ prompt: [], abortSignal: controller.signal });
  const reader = stream.getReader();

  assert.equal(state.starts.length, 1, "subscribed and started");
  const streamId = state.starts[0].streamId;
  assert.equal(typeof streamId, "string");

  api.push({ streamId: "other", part: { type: "text-delta", text: "not mine" } });
  api.push({ streamId, part: { type: "text-delta", id: "t", text: "hello" } });
  assert.deepEqual((await reader.read()).value, { type: "text-delta", id: "t", text: "hello" });

  api.push({ streamId, done: true });
  assert.deepEqual(await reader.read(), { done: true, value: undefined });
  assert.equal(state.unsubscribed, 1, "envelope listener removed on done");

  // A late terminal for the same id must not resurrect or throw.
  api.push({ streamId, error: "late" });
  api.push({ streamId, part: { type: "text-delta", text: "late" } });

  // The abort listener was removed with the envelope listener: aborting now
  // must not fire a cancel for the settled stream.
  controller.abort();
  assert.deepEqual(state.cancels, [], "a clean done never cancels");
});

test("an already-aborted signal never starts a provider request", async (t) => {
  const { api, state } = stubApi();
  installBrowserGlobals(t, { window: { electronAPI: api } });
  const { createEnterpriseChatModel } = await loadModel();

  const controller = new AbortController();
  controller.abort();
  const model = createEnterpriseChatModel("bedrock", "m");
  const { stream } = await model.doStream({ prompt: [], abortSignal: controller.signal });

  const read = stream.getReader().read();
  await assert.rejects(read, /abort/i);
  assert.equal(state.starts.length, 0, "no billable start for a dead consumer");
});

test("a failed invoke errors the local stream and cleans up", async (t) => {
  const { api, state } = stubApi();
  api.startBehavior = async () => ({ success: false, error: "provider says no" });
  installBrowserGlobals(t, { window: { electronAPI: api } });
  const { createEnterpriseChatModel } = await loadModel();

  const controller = new AbortController();
  const model = createEnterpriseChatModel("azure", "gpt-4.1");
  const { stream } = await model.doStream({ prompt: [], abortSignal: controller.signal });

  await assert.rejects(stream.getReader().read(), /provider says no/);
  assert.equal(state.unsubscribed, 1);

  controller.abort();
  assert.deepEqual(state.cancels, [], "a failed start never triggers a cancel");
});

test("abort between subscribe and start cancels the started stream", async (t) => {
  const { api, state } = stubApi();
  let releaseStart;
  const gate = new Promise((resolve) => (releaseStart = resolve));
  api.startBehavior = async () => {
    await gate;
    return { success: true };
  };
  installBrowserGlobals(t, { window: { electronAPI: api } });
  const { createEnterpriseChatModel } = await loadModel();

  const controller = new AbortController();
  const model = createEnterpriseChatModel("bedrock", "m");
  const { stream } = await model.doStream({ prompt: [], abortSignal: controller.signal });

  const read = stream.getReader().read();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.starts.length, 1, "start in flight");

  // The onAbort listener fired the cancel for an unregistered id...
  controller.abort();
  assert.equal(state.cancels.length, 1);

  // ...and the post-start re-check fails the stream without waiting for a
  // main terminal event, cancelling the now-registered stream too.
  releaseStart();
  await assert.rejects(read, /Aborted/);
  assert.deepEqual(state.cancels, [state.starts[0].streamId, state.starts[0].streamId]);
});

test("abort settles the local read immediately while the start invoke is pending", async (t) => {
  const { api, state } = stubApi();
  let releaseStart;
  const gate = new Promise((resolve) => (releaseStart = resolve));
  api.startBehavior = async () => {
    await gate;
    return { success: true };
  };
  installBrowserGlobals(t, { window: { electronAPI: api } });
  const { createEnterpriseChatModel } = await loadModel();

  const controller = new AbortController();
  const model = createEnterpriseChatModel("bedrock", "m");
  const { stream } = await model.doStream({ prompt: [], abortSignal: controller.signal });
  const reader = stream.getReader();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.starts.length, 1);

  let settled = false;
  const read = reader.read().then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );

  // Abort while the start invoke is still pending: the read must settle and
  // the envelope listener must go without waiting for main.
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    { settled, unsubscribed: state.unsubscribed, cancels: state.cancels },
    { settled: true, unsubscribed: 1, cancels: [state.starts[0].streamId] }
  );

  // The late main resolution and any late envelopes must not enqueue, close
  // or error the already-settled stream a second time.
  api.push({ streamId: state.starts[0].streamId, part: { type: "text-delta", text: "late" } });
  api.push({ streamId: state.starts[0].streamId, done: true });
  releaseStart();
  await read;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, true, "still settled exactly once");
  assert.equal(state.unsubscribed, 1, "cleanup ran exactly once");
  await assert.rejects(reader.read(), /Aborted/, "the stream stays errored");
});

test("explicit consumer cancel settles locally and aborts main", async (t) => {
  const { api, state } = stubApi();
  installBrowserGlobals(t, { window: { electronAPI: api } });
  const { createEnterpriseChatModel } = await loadModel();

  const controller = new AbortController();
  const model = createEnterpriseChatModel("vertex", "gemini-pro");
  const { stream } = await model.doStream({ prompt: [], abortSignal: controller.signal });
  const reader = stream.getReader();
  await new Promise((resolve) => setImmediate(resolve));

  await reader.cancel();
  assert.equal(state.unsubscribed, 1, "listener removed on explicit cancel");
  assert.deepEqual(state.cancels, [state.starts[0].streamId]);
});

test("an error envelope fails the stream once", async (t) => {
  const { api, state } = stubApi();
  installBrowserGlobals(t, { window: { electronAPI: api } });
  const { createEnterpriseChatModel } = await loadModel();

  const model = createEnterpriseChatModel("bedrock", "m");
  const { stream } = await model.doStream({ prompt: [] });
  const streamId = state.starts[0].streamId;

  const read = stream.getReader().read();
  api.push({ streamId, error: "mapped provider failure" });
  await assert.rejects(read, /mapped provider failure/);
  assert.equal(state.unsubscribed, 1);
  api.push({ streamId, done: true });
});
