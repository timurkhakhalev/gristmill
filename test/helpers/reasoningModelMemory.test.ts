const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals, reloadSettingsStore } = require("../lib/rendererTestHarness.ts");

let vitePromise;
const cleanup: (() => Promise<unknown> | unknown)[] = [];
test.after(async () => {
  for (const close of cleanup) await close();
});
function getVite() {
  return vitePromise ??= createRendererServer({ after: (close: any) => cleanup.push(close) }, {
    cachePrefix: "openwhispr-reasoning-model-memory-test-",
  });
}

test("per-provider reasoning model memory", async (t: import("node:test").TestContext) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      cleanupMode: "providers",
      cleanupProvider: "custom",
      cleanupModel: "parasail-llm-v1",
      cleanupCloudBaseUrl: "https://llm.parasail.example.com/v1",
    },
  });
  const vite = await getVite();
  const { useSettingsStore } = await reloadSettingsStore(vite);
  const state = () => useSettingsStore.getState();

  await t.test("switch-and-return restores the custom model (Parasail scenario)", () => {
    state().switchReasoningProvider("cleanup", "openai", "gpt-5.2");
    assert.equal(state().cleanupProvider, "openai");
    assert.equal(state().cleanupModel, "gpt-5.2");
    assert.equal(
      state().cleanupCloudBaseUrl,
      "https://llm.parasail.example.com/v1",
      "the custom URL slot must never be touched by a provider switch"
    );

    state().switchReasoningProvider("cleanup", "custom", "");
    assert.equal(state().cleanupProvider, "custom");
    assert.equal(state().cleanupModel, "parasail-llm-v1");
  });

  await t.test("reselecting the current provider keeps the current model", () => {
    state().setCleanupModel("parasail-tuned");
    state().switchReasoningProvider("cleanup", "custom", "");
    assert.equal(state().cleanupModel, "parasail-tuned");
  });

  await t.test("a remembered model the provider no longer ships falls back", () => {
    state().switchReasoningProvider("cleanup", "groq", "llama-3.3-70b-versatile");
    state().setCleanupModel("retired-groq-model");
    state().switchReasoningProvider("cleanup", "custom", "");
    state().switchReasoningProvider("cleanup", "groq", "llama-3.3-70b-versatile");
    assert.equal(
      state().cleanupModel,
      "llama-3.3-70b-versatile",
      "an unknown remembered model must degrade to the provider default"
    );
  });

  await t.test("scopes have independent memory and writes", () => {
    state().switchReasoningProvider("cleanup", "custom", "");
    const cleanupModel = state().cleanupModel;

    state().switchReasoningProvider("chatIntelligence", "openai", "gpt-5.2");
    assert.equal(state().chatAgentProvider, "openai");
    assert.equal(state().chatAgentModel, "gpt-5.2");
    assert.equal(state().cleanupProvider, "custom", "base scope untouched");
    assert.equal(state().cleanupModel, cleanupModel, "base scope untouched");
  });

  await t.test("memory persists to localStorage as JSON", () => {
    const raw = localStorage.getItem("reasoningModelByProvider");
    assert.ok(raw);
    const persisted = JSON.parse(raw);
    assert.equal(typeof persisted, "object");
    assert.ok(Object.keys(persisted).some((key) => key.startsWith("cleanup:")));
  });
});

// The reasoning picker commits only on an explicit model click via the plain
// scope setters (provider, then model). Pin that the pair lands atomically
// and that per-provider memory never overrides an explicit click.
test("explicit model click commits the (provider, model) pair atomically", async (t: import("node:test").TestContext) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      cleanupMode: "providers",
      cleanupProvider: "openai",
      cleanupModel: "gpt-5-mini",
    },
  });
  const vite = await getVite();
  const { useSettingsStore } = await reloadSettingsStore(vite);
  const state = () => useSettingsStore.getState();

  // Seed per-provider memory: anthropic remembers claude-opus-4-6.
  state().switchReasoningProvider("cleanup", "anthropic", "claude-sonnet-4-6");
  state().setCleanupModel("claude-opus-4-6");
  state().switchReasoningProvider("cleanup", "openai", "gpt-5.2");
  assert.equal(state().cleanupModel, "gpt-5-mini", "switch-and-return restores openai's model");

  // Explicit click on claude-haiku-4-5 under the browsed anthropic tab:
  // the clicked pair commits, not the remembered claude-opus-4-6.
  state().setCleanupProvider("anthropic");
  state().setCleanupModel("claude-haiku-4-5");
  assert.equal(state().cleanupProvider, "anthropic");
  assert.equal(
    state().cleanupModel,
    "claude-haiku-4-5",
    "per-provider memory must not resurrect over an explicit click"
  );

  // A later provider-only write must not drag the model along.
  state().setCleanupProvider("openai");
  assert.equal(state().cleanupProvider, "openai");
  assert.equal(
    state().cleanupModel,
    "claude-haiku-4-5",
    "the plain provider setter writes the provider alone"
  );
});

test("corrupt persisted reasoning model memory hydrates as empty, not a crash", async (t: import("node:test").TestContext) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      reasoningModelByProvider: "{not json",
    },
  });
  const vite = await getVite();
  const { useSettingsStore } = await reloadSettingsStore(vite);
  assert.deepEqual(useSettingsStore.getState().reasoningModelByProvider, {});
});

test("retired cloud model selections are repointed to the provider default", async (t: import("node:test").TestContext) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      cleanupProvider: "groq",
      cleanupModel: "meta-llama/llama-4-scout-17b-16e-instruct",
      chatAgentProvider: "openai",
      chatAgentModel: "gpt-5.2",
      noteFormattingProvider: "custom",
      noteFormattingModel: "my-endpoint-model",
    },
  });
  const vite = await getVite();
  const { useSettingsStore, reconcileRetiredCloudModelSelections } = await reloadSettingsStore(vite);

  reconcileRetiredCloudModelSelections();

  const state = useSettingsStore.getState();
  assert.notEqual(
    state.cleanupModel,
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "a registry-retired model must be repointed"
  );
  assert.ok(state.cleanupModel, "repointed to a concrete replacement, not cleared");
  assert.equal(state.chatAgentModel, "gpt-5.2", "shipping models stay untouched");
  assert.equal(state.noteFormattingModel, "my-endpoint-model", "custom ids are free-form");
});
