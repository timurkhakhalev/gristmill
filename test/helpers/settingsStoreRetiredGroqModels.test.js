const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  reloadSettingsStore,
} = require("../lib/rendererTestHarness");

const modelRegistryData = require("../../src/models/modelRegistryData.json");

// Groq retired qwen3-32b and both Llamas on 2026-08-16. The registry entries
// are gone, so a persisted scope selection would 404 on every request until
// the user re-picked — the migration remaps it to a model Groq still serves.
test("retired groq model selections migrate to served replacements", async (t) => {
  const groqIds = modelRegistryData.cloudProviders
    .find((provider) => provider.id === "groq")
    .models.map((model) => model.id);
  assert.ok(
    !groqIds.includes("llama-3.3-70b-versatile"),
    "retired ids must be out of the registry"
  );

  const { storage } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-retired-groq-models-test-",
  });

  const load = () => reloadSettingsStore(vite);

  await t.test("groq scopes remap, other providers keep their model", async () => {
    storage.clear();
    storage.setItem("cleanupProvider", "groq");
    storage.setItem("cleanupModel", "llama-3.3-70b-versatile");
    storage.setItem("chatAgentProvider", "openrouter");
    storage.setItem("chatAgentModel", "llama-3.3-70b-versatile");

    const { useSettingsStore } = await load();
    const state = useSettingsStore.getState();

    assert.equal(state.cleanupModel, "openai/gpt-oss-120b");
    assert.equal(state.chatAgentModel, "llama-3.3-70b-versatile", "openrouter still serves the id");
  });

  await t.test("migration is one-shot", async () => {
    storage.clear();
    storage.setItem("_retiredGroqModelsMigrated", "1");
    storage.setItem("cleanupProvider", "groq");
    storage.setItem("cleanupModel", "llama-3.3-70b-versatile");

    const { useSettingsStore } = await load();
    assert.equal(useSettingsStore.getState().cleanupModel, "llama-3.3-70b-versatile");
  });
});
