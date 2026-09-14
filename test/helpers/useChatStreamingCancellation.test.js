const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Real end-to-end coverage for useChatStreaming.ts's empty-response fallback
// and its interaction with cancellation (Esc/Stop, or an unmount mid-stream).
// A stream cancelled before any visible token must NOT leave the assistant
// message content set to the fallback string, while a stream that genuinely
// completes with no tokens still MUST get the fallback — otherwise a
// fabricated "The model returned no response." persists into a
// user-cancelled conversation as if the model said it.
//
// This drives the REAL useChatStreaming hook (not a copy of its guard
// logic): `renderToStaticMarkup` runs the hook body once synchronously,
// which is enough to obtain `sendToAI`/`cancelStream` — both plain
// (`useCallback`-wrapped) functions closing over refs, not requiring a live
// fiber to keep working afterward. `setMessages` is supplied by the test
// (useChatStreaming takes it as a prop, not internal state), so its calls
// are observed directly without needing any DOM or reconciliation. This
// harness has no jsdom or `@testing-library/react`, but this narrower technique — one
// synchronous render, then calling the returned functions like any other
// closures — does not need any of those. The one thing SSR genuinely cannot
// do is run `useEffect` bodies, so the unmount-mid-stream test mounts the
// hook for real (installHookDom + createRoot) to drive the actual unmount
// cleanup, whose cancel must persist the partial reply rather than drop it
// the way an explicit Esc/Stop cancel does.
function createOpenAiChunk(delta, finishReason = null) {
  return {
    id: "chatcmpl-cancellation-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "qwen3-4b-q4_k_m",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

const EMPTY_RESPONSE_TEXT = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
).agentMode.chat.emptyResponse;

async function renderChatStreaming(
  t,
  { electronAPI = {}, settings = {}, onStreamComplete, live = false } = {}
) {
  installBrowserGlobals(t, { window: { electronAPI } });
  const container = live ? installHookDom(t) : null;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-streaming-cancellation-test-",
  });
  const [{ default: viteI18next }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  if (!viteI18next.isInitialized) {
    const translation = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
    );
    await viteI18next.use(initReactI18next).init({
      lng: "en",
      resources: { en: { translation } },
      interpolation: { escapeValue: false },
    });
  }

  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  // A self-hosted (LAN) chat agent with no tools in play: 4B+ in the model
  // name makes it tool-eligible by the size heuristic, but the fixture
  // fetch never emits a tool call, so it stays on the plain-content path.
  useSettingsStore.setState({
    chatAgentMode: "self-hosted",
    chatAgentProvider: "lan",
    chatAgentModel: "qwen3-4b-q4_k_m",
    chatAgentRemoteUrl: "http://127.0.0.1:11434/v1",
    chatAgentDisableThinking: true,
    ...settings,
  });

  const { useChatStreaming } = await vite.ssrLoadModule("/components/chat/useChatStreaming.ts");
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  // useChatStreaming imports ReasoningService.ts, whose default export is a
  // singleton constructed at import time; its API-key cache starts a real
  // setInterval that otherwise keeps the process alive after the test ends.
  t.after(() => reasoningService.destroy());

  let messages = [];
  const setMessages = (updater) => {
    messages = typeof updater === "function" ? updater(messages) : updater;
  };

  let captured = null;
  function Harness() {
    captured = useChatStreaming({
      messages,
      setMessages,
      onStreamComplete,
    });
    return null;
  }

  let unmount;
  if (live) {
    const { createRoot } = require("react-dom/client");
    const root = createRoot(container);
    await React.act(async () => root.render(React.createElement(Harness)));
    let unmounted = false;
    unmount = async () => {
      if (unmounted) return;
      unmounted = true;
      await React.act(async () => root.unmount());
    };
    t.after(unmount);
  } else {
    renderToStaticMarkup(React.createElement(Harness));
  }

  return {
    captured,
    getMessages: () => messages,
    unmount,
  };
}

test("a genuine empty completion still shows the empty-response fallback", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  // No content deltas at all — just an immediate finish + [DONE], the
  // think-only/empty-completion shape the fallback exists for.
  globalThis.fetch = async () => {
    const finishEvent = `data: ${JSON.stringify(createOpenAiChunk({}, "stop"))}\n\n`;
    return new Response(`${finishEvent}data: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const { captured, getMessages } = await renderChatStreaming(t);

  await captured.sendToAI("hello", []);

  const [message] = getMessages();
  assert.equal(message.content, EMPTY_RESPONSE_TEXT);
  assert.equal(message.isStreaming, false);
});

test("cancelling before any token arrives never shows the empty-response fallback", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetchStarted = false;
  // A stream that never emits anything, only ending (with an abort error)
  // once the request's AbortSignal fires — i.e. once cancelStream() runs.
  globalThis.fetch = async (_input, init) => {
    fetchStarted = true;
    const body = new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener(
          "abort",
          () => controller.error(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  let streamCompleteCalls = 0;
  const { captured, getMessages } = await renderChatStreaming(t, {
    onStreamComplete: () => {
      streamCompleteCalls += 1;
    },
  });

  const sendPromise = captured.sendToAI("hello", []);

  const waitForMicrotasks = () => new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 50 && !fetchStarted; i++) await waitForMicrotasks();
  assert.equal(fetchStarted, true, "fixture setup: fetch must have started before cancelling");

  // The same primitive both Esc/Stop and an unmount mid-stream route
  // through — see useChatStreaming.ts's cancelStream and its mount/unmount
  // effect, which now calls cancelStream() instead of cancelling the
  // ReasoningService stream directly.
  captured.cancelStream();

  await sendPromise;

  const [message] = getMessages();
  assert.notEqual(message.content, EMPTY_RESPONSE_TEXT);
  assert.equal(message.content, "");
  assert.equal(message.isStreaming, false);
  assert.equal(streamCompleteCalls, 0, "a cancelled request must never persist a partial reply");
});

test("an unmount mid-stream persists the partial reply without delivering it", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const encoder = new TextEncoder();
  let releaseTail;
  const tailGate = new Promise((resolve) => {
    releaseTail = resolve;
  });
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify(createOpenAiChunk({ content: "Partial reply" }))}\n\n`
            )
          );
          // Hold the stream open across the unmount so the tail arrives after
          // the cleanup's cancel, the way a page navigation interrupts a send.
          await tailGate;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(createOpenAiChunk({}, "stop"))}\n\n`)
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );

  const persisted = [];
  const { captured, getMessages, unmount } = await renderChatStreaming(t, {
    live: true,
    onStreamComplete: (_id, content) => persisted.push(content),
  });

  let sendPromise;
  const waitForMicrotasks = () => new Promise((resolve) => setImmediate(resolve));
  await React.act(async () => {
    sendPromise = captured.sendToAI("hello", []);
    for (
      let i = 0;
      i < 50 && !getMessages().some((m) => m.content === "Partial reply");
      i++
    ) {
      await waitForMicrotasks();
    }
  });
  assert.ok(
    getMessages().some((m) => m.content === "Partial reply"),
    "the partial token must arrive before the unmount"
  );

  await unmount();
  releaseTail();
  await sendPromise;

  assert.deepEqual(
    persisted,
    ["Partial reply"],
    "an unmounted stream must keep its partial reply in history"
  );
  const assistantMessage = getMessages().find((m) => m.role === "assistant");
  assert.equal(assistantMessage.isStreaming, false);
});

test("cancelling a tool-ineligible raw stream after reading starts shows no error", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let readerStarted = false;
  globalThis.fetch = async (_input, init) => {
    const body = new ReadableStream({
      pull() {
        readerStarted = true;
      },
      start(controller) {
        init?.signal?.addEventListener(
          "abort",
          () => controller.error(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const { captured, getMessages } = await renderChatStreaming(t, {
    settings: { chatAgentModel: "qwen3-1.7b-q4_k_m" },
  });
  const sendPromise = captured.sendToAI("hello", []);
  const waitForMicrotasks = () => new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 50 && !readerStarted; i++) await waitForMicrotasks();
  assert.equal(readerStarted, true, "fixture setup: the raw response reader must be pending");

  captured.cancelStream();
  await sendPromise;

  const [message] = getMessages();
  assert.equal(message.content, "");
  assert.equal(message.isStreaming, false);
});
