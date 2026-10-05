const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const {
  createRendererServer,
  installBrowserGlobals,
}: typeof import("../lib/rendererTestHarness.ts") = require("../lib/rendererTestHarness.ts");

type TestContext = import("node:test").TestContext;

// Note formatting had no explicit output budget, so it inherited the generic
// 2048-token default from calculateMaxTokens. Summaries of long meetings were
// cut off at that ceiling and saved anyway, with no error and nothing in the
// UI to say the notes were incomplete (#2142).

const ACTION = { id: 1, name: "Generate Notes", prompt: "Summarize the meeting." };

const LABELS = { noModel: "no model", noEndpoint: "no endpoint", actionFailed: "failed" };

interface ProcessTextCall {
  text: string;
  model: string;
  config: { maxTokens: number; requireCompleteOutput?: boolean };
}

interface NoteUpdateCall {
  noteId: number;
  payload: Record<string, unknown>;
}

async function loadStore(t: TestContext, modelOutput = "# Notes\n- decided things") {
  const updates: NoteUpdateCall[] = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        updateNote: async (noteId: number, payload: Record<string, unknown>) => {
          updates.push({ noteId, payload });

          return { success: true };
        },
      },
    },
  });

  const calls: ProcessTextCall[] = [];

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-action-output-test-",
    mockModules: {
      "/services/ReasoningService": `
        export default {
          processText: async (text, model, agentName, config) => {
            globalThis.__processTextCalls.push({ text, model, config });
            return globalThis.__modelOutput;
          },
        };
      `,
      "/utils/generateTitle": `export const generateNoteTitle = async () => undefined;`,
    },
  });

  (globalThis as Record<string, unknown>).__processTextCalls = calls;
  (globalThis as Record<string, unknown>).__modelOutput = modelOutput;
  t.after(() => {
    delete (globalThis as Record<string, unknown>).__processTextCalls;
    delete (globalThis as Record<string, unknown>).__modelOutput;
  });

  const store = await vite.ssrLoadModule("/stores/actionProcessingStore.ts");
  t.after(async () => {
    await new Promise(setImmediate);
    store.cancelAction(7);
    store.cancelAction(8);
  });

  return { store, calls, updates };
}

async function waitFor(predicate: () => boolean, label: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`timed out waiting for ${label}`);
}

test("note formatting asks for enough output tokens to hold a long meeting summary", async (t: TestContext) => {
  const { store, calls, updates } = await loadStore(t);

  store.runBackgroundAction(
    7,
    "## Meeting Transcript\n" + "Alice: we agreed to ship on Friday.\n".repeat(500),
    "hash",
    ACTION,
    { modelId: "gpt-4.1", isCloudMode: true, isMeetingNote: true },
    LABELS
  );

  await waitFor(() => updates.length > 0, "the note to be written");

  assert.equal(calls.length, 1);
  // 2048 is roughly 1,500 words — short of a structured summary of a long
  // meeting, which is exactly the case this feature exists for.
  assert.ok(
    calls[0].config.maxTokens >= 4096,
    `expected a real output budget, got ${calls[0].config.maxTokens}`
  );
});

test("a short model result is saved rather than discarded", async (t: TestContext) => {
  // Deliberate: unlike a selection edit, where a partial replacement would
  // corrupt the user's own text, a clipped summary is still worth keeping.
  // So note formatting must NOT set requireCompleteOutput.
  const partialOutput = "## Summary\n- Decision recorded\n## Action Items\n- [ ] Follow";
  const { store, calls, updates } = await loadStore(t, partialOutput);

  store.runBackgroundAction(
    8,
    "some notes",
    "hash",
    ACTION,
    { modelId: "gpt-4.1", isCloudMode: true, isMeetingNote: true },
    LABELS
  );

  await waitFor(() => updates.length > 0, "the note to be written");
  assert.notEqual(calls[0].config.requireCompleteOutput, true);
  assert.equal(updates[0].noteId, 8);
  assert.equal(updates[0].payload.enhanced_content, partialOutput);
});
