const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const { createRendererServer, installBrowserGlobals }: typeof import("../lib/rendererTestHarness.ts") = require("../lib/rendererTestHarness.ts");
import type { TestContext } from "node:test";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The module's default export is an instance of a non-exported class.
type ReasoningService = typeof import("../../src/services/ReasoningService.js").default;
type SentRequest = { endpoint: string; headers: Record<string, string> };

async function loadReasoningService(t: TestContext, cachePrefix: string): Promise<ReasoningService> {
  installBrowserGlobals(t, {});
  const vite = await createRendererServer(t, { cachePrefix });
  const reasoningService = ((await vite.ssrLoadModule("/services/ReasoningService.ts") as typeof import("../../src/services/ReasoningService.ts"))).default;
  t.after(() => reasoningService.destroy());
  return reasoningService;
}

/** Captures the headers of the streaming POST and answers with a one-chunk SSE body. */
function installStreamRecorder(t: TestContext, sent: SentRequest[]) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input: unknown, init: { headers?: unknown } = {}) => {
    sent.push({ endpoint: String(input), headers: (init.headers ?? {}) as Record<string, string> });
    const event = `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`;
    return new Response(`${event}data: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

async function streamAgainst(reasoningService: ReasoningService, lanUrl: string) {
  const stream = reasoningService.processTextStreaming(
    [{ role: "user", content: "hello" }],
    "kimi-k2.5",
    "lan",
    { systemPrompt: "Answer the user.", lanUrl }
  );
  let output = "";
  for await (const chunk of stream) output += chunk;
  return output;
}

test("self-hosted streaming sends a session id to OpenCode Go", async (t: import("node:test").TestContext) => {
  const reasoningService = await loadReasoningService(t, "openwhispr-opencode-stream-test-");
  const sent: SentRequest[] = [];
  installStreamRecorder(t, sent);

  assert.equal(await streamAgainst(reasoningService, "https://opencode.ai/zen/go/v1"), "ok");

  assert.equal(sent.length, 1);
  assert.equal(sent[0].endpoint, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.match(sent[0].headers["x-opencode-session"], UUID_RE);
});

test("self-hosted streaming sends no session id to other endpoints", async (t: import("node:test").TestContext) => {
  const reasoningService = await loadReasoningService(t, "openwhispr-opencode-stream-other-test-");
  const sent: SentRequest[] = [];
  installStreamRecorder(t, sent);

  assert.equal(await streamAgainst(reasoningService, "http://127.0.0.1:11434/v1"), "ok");

  assert.equal(sent.length, 1);
  assert.equal("x-opencode-session" in sent[0].headers, false);
});

/** Captures the headers of the non-streaming POST and answers with a chat completion. */
function installCompletionRecorder(t: TestContext, sent: SentRequest[]) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input: unknown, init: { headers?: unknown } = {}) => {
    sent.push({ endpoint: String(input), headers: (init.headers ?? {}) as Record<string, string> });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Cleaned" }, finish_reason: "stop" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
}

test("self-hosted cleanup sends a session id to OpenCode Go", async (t: import("node:test").TestContext) => {
  const reasoningService = await loadReasoningService(t, "openwhispr-opencode-cleanup-test-");
  const sent: SentRequest[] = [];
  installCompletionRecorder(t, sent);

  const result = await reasoningService.processText("clean this up", "kimi-k2.5", null, {
    lanUrl: "https://opencode.ai/zen/go/v1",
  });

  assert.equal(result, "Cleaned");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].endpoint, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.match(sent[0].headers["x-opencode-session"], UUID_RE);
});
