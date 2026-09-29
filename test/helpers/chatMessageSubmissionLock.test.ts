const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals }: typeof import("../lib/rendererTestHarness.ts") = require("../lib/rendererTestHarness.ts");

test("message submission lock rejects a rapid second send until conversation creation settles", async (t: import("node:test").TestContext) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-submission-lock-test-",
  });
  const { createMessageSubmissionLock } = (await vite.ssrLoadModule(
    "/components/chat/useChatMessageSender.ts"
  ) as typeof import("../../src/components/chat/useChatMessageSender.ts"));
  const lock = createMessageSubmissionLock();
  let resolveCreate!: (value?: unknown) => void;
  let createCalls = 0;
  const createConversation = new Promise((resolve) => {
    resolveCreate = resolve;
  });

  const first = lock.run(async () => {
    createCalls += 1;
    await createConversation;
  });
  const second = lock.run(async () => {
    createCalls += 1;
  });

  assert.equal(await second, false);
  assert.equal(createCalls, 1);
  resolveCreate();
  assert.equal(await first, true);
  assert.equal(await lock.run(async () => {}), true);
});

test("message sender reports whether the submission lock accepted the send", async (t: import("node:test").TestContext) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-message-sender-test-",
  });
  const { useChatMessageSender } = await vite.ssrLoadModule(
    "/components/chat/useChatMessageSender.ts"
  );

  let resolveCreate!: (value?: unknown) => void;
  const createConversation = new Promise((resolve) => {
    resolveCreate = resolve;
  });
  const persistence = {
    messages: [],
    setMessages() {},
    async saveUserMessage() {},
  };
  let sentOptions: { conversationId?: number } | undefined;
  const streaming = { async sendToAI(_text: string, _messages: unknown, options: { conversationId?: number }) { sentOptions = options; } };
  let sendMessage: any;

  function Harness() {
    sendMessage = useChatMessageSender({
      conversationId: null,
      persistence,
      streaming,
      createConversation: async () => createConversation,
    });
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));

  const first = sendMessage("first");
  const second = sendMessage("second");

  assert.equal(await second, false);
  resolveCreate(1);
  assert.equal(await first, true);
  assert.equal(sentOptions?.conversationId, 1, "the first turn uses the newly saved ID without waiting for a render");
});

test("an action turn persists a normal Chat user message with one-turn options", async (t: import("node:test").TestContext) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-action-message-test-",
  });
  const { useChatMessageSender } = await vite.ssrLoadModule(
    "/components/chat/useChatMessageSender.ts"
  );
  const saved: string[] = [];
  const streamed: unknown[][] = [];
  const previousMessage = { id: "prior", role: "assistant", content: "old context", isStreaming: false };
  const persistence = {
    messages: [previousMessage],
    setMessages() {},
    async saveUserMessage(text: string) { saved.push(text); },
  };
  let sendMessage: any;
  function Harness() {
    sendMessage = useChatMessageSender({
      conversationId: 12,
      persistence,
      streaming: { async sendToAI(...args: unknown[]) { streamed.push(args); } },
      createConversation: async () => { throw new Error("an existing note conversation is reused"); },
    });
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));

  const options = { systemPrompt: "Editable action prompt and selected meeting JSON", disableTools: true, includeConversationHistory: false };
  assert.equal(await sendMessage("Draft a follow-up", options), true);
  assert.deepEqual(saved, ["Draft a follow-up"]);
  assert.equal(streamed.length, 1);
  assert.equal(streamed[0][0], "Draft a follow-up");
  assert.deepEqual((streamed[0][1] as Array<{ role: string; content: string }>).map(({ role, content }) => [role, content]), [
    ["assistant", "old context"],
    ["user", "Draft a follow-up"],
  ]);
  assert.deepEqual(streamed[0][2], { ...options, conversationId: 12 });
});
