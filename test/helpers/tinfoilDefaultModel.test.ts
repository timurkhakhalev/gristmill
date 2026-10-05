const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness.ts");

const modelRegistryData = require("../../src/models/modelRegistryData.json");

const english = require("../../src/locales/en/translation.json");

let vitePromise;

const cleanup: (() => Promise<unknown> | unknown)[] = [];

test.after(async () => {
  for (const close of cleanup) await close();
});

async function getVite() {
  const vite = await (vitePromise ??= createRendererServer(
    { after: (close: any) => cleanup.push(close) },
    {
      cachePrefix: "openwhispr-tinfoil-default-model-test-",
    }
  ));

  for (const url of [
    "/models/ModelRegistry.ts",
    "/stores/settingsStore.ts",
    "/stores/tinfoilModelSwitchStore.ts",
  ]) {
    const module = await vite.moduleGraph.getModuleByUrl(url);

    if (module) vite.moduleGraph.invalidateModule(module);
  }

  return vite;
}

// Tinfoil retires GLM-5.2 on 2026-09-10 (replaced by glm-5-3) and its live
// /v1/models list already omits it. The default lookup must follow, otherwise
// every reconciled selection lands on whatever Tinfoil happens to list first.
const LIVE_CATALOG = [
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", description: "", supportsThinking: true },
  { id: "glm-5-3", name: "GLM-5.3", description: "", supportsThinking: true },
  { id: "gpt-oss-120b", name: "GPT-OSS 120B", description: "", supportsThinking: true },
];

test("tinfoil default model follows the glm-5-3 replacement", async (t: import("node:test").TestContext) => {
  installBrowserGlobals(t);

  const { pickDefaultTinfoilModel, DESCRIPTION_KEYS } =
    await import("../../src/models/tinfoilModels.ts");

  await t.test("picks glm-5-3 even when Tinfoil lists another model first", () => {
    assert.equal(pickDefaultTinfoilModel(LIVE_CATALOG)?.id, "glm-5-3");
  });

  await t.test("still falls back to the first served model when the default is gone", () => {
    assert.equal(pickDefaultTinfoilModel(LIVE_CATALOG.slice(0, 1))?.id, "deepseek-v4-flash");
  });

  await t.test("registry names the default and no longer ships glm-5-2", () => {
    const tinfoil = modelRegistryData.cloudProviders.find(
      (provider: { id: string; defaultModel?: string; models: { id: string }[] }) =>
        provider.id === "tinfoil"
    );

    assert.equal(tinfoil.defaultModel, "glm-5-3");
    assert.ok(
      !tinfoil.models.some((model: { id: string }) => model.id === "glm-5-2"),
      "retired id must be out of the seed"
    );
  });

  await t.test("every curated description key resolves in English", () => {
    for (const key of Object.values(DESCRIPTION_KEYS)) {
      const path = key.split(".");

      const value = path.reduce<unknown>(
        (node, segment) =>
          node && typeof node === "object" ? Reflect.get(node, segment) : undefined,
        english
      );

      assert.ok(typeof value === "string", `${key} is missing from en`);
      assert.ok(value.length > 0, `${key} is empty in en`);
    }
  });
});

// Tinfoil's catalog is fetched live and cached, so its order is Tinfoil's, not
// ours. Anything that resolves a default from list position lands on whatever
// the enclave happens to serve first — deepseek-v4-flash today.
test("a cached catalog does not displace the named Tinfoil default", async (t: import("node:test").TestContext) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      tinfoilModels: JSON.stringify({ models: LIVE_CATALOG, fetchedAt: Date.now() }),
      cleanupMode: "providers",
      cleanupProvider: "tinfoil",
      cleanupModel: "glm-5-3",
    },
  });
  const vite = await getVite();
  // Loading the registry applies the cached list, exactly as app startup does.
  (await vite.ssrLoadModule(
    "/models/ModelRegistry.ts"
  )) as typeof import("../../src/models/ModelRegistry.ts");

  const { useSettingsStore } = (await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  )) as typeof import("../../src/stores/settingsStore.ts");

  const effective = useSettingsStore.getState();

  assert.equal(effective.cleanupProvider, "tinfoil");
  assert.equal(effective.cleanupModel, "glm-5-3");
});

test("a persisted glm-5-2 selection is repointed before any request", async (t: import("node:test").TestContext) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      cleanupMode: "providers",
      cleanupProvider: "tinfoil",
      cleanupModel: "glm-5-2",
    },
  });
  const vite = await getVite();

  const { useSettingsStore } = (await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  )) as typeof import("../../src/stores/settingsStore.ts");

  // No catalog fetch and no network: the store repairs the selection on load,
  // so the first request of the session already carries a served model.
  assert.equal(useSettingsStore.getState().cleanupModel, "glm-5-3");
});

// The app tells a user when Tinfoil retires the model they picked. The startup
// sweep now moves them before the live-catalog reconcile can, so the notice has
// to come from the sweep or it is lost.
test("the retirement notice fires when the startup sweep is what moved the user", async (t: import("node:test").TestContext) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      // The user's own cached catalog is the only place the retired model's
      // display name still exists; the replacement's comes from the seed.
      tinfoilModels: JSON.stringify({
        models: [{ id: "glm-5-2", name: "GLM-5.2", description: "", supportsThinking: true }],
        fetchedAt: Date.now(),
      }),
      cleanupMode: "providers",
      cleanupProvider: "tinfoil",
      cleanupModel: "glm-5-2",
      chatAgentProvider: "tinfoil",
      chatAgentModel: "glm-5-2",
    },
  });
  const vite = await getVite();

  const { useSettingsStore } = (await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  )) as typeof import("../../src/stores/settingsStore.ts");

  const { consumeTinfoilModelSwitches } = (await vite.ssrLoadModule(
    "/stores/tinfoilModelSwitchStore.ts"
  )) as typeof import("../../src/stores/tinfoilModelSwitchStore.ts");

  assert.equal(useSettingsStore.getState().cleanupModel, "glm-5-3");
  // Two scopes moved, but the user is told about the model once.
  assert.deepEqual(consumeTinfoilModelSwitches(), [{ from: "GLM-5.2", to: "GLM-5.3" }]);
});

test("a Groq remap is not announced as a Tinfoil retirement", async (t: import("node:test").TestContext) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      cleanupMode: "providers",
      cleanupProvider: "groq",
      cleanupModel: "llama-3.3-70b-versatile",
    },
  });
  const vite = await getVite();

  const { useSettingsStore } = (await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  )) as typeof import("../../src/stores/settingsStore.ts");

  const { consumeTinfoilModelSwitches } = (await vite.ssrLoadModule(
    "/stores/tinfoilModelSwitchStore.ts"
  )) as typeof import("../../src/stores/tinfoilModelSwitchStore.ts");

  assert.equal(useSettingsStore.getState().cleanupModel, "openai/gpt-oss-120b");
  assert.deepEqual(consumeTinfoilModelSwitches(), []);
});

// Every live site that resolves a provider's default reads the name the
// registry gives it, through one helper.
test("a provider's named default beats its list position", async (t: import("node:test").TestContext) => {
  const { pickDefaultModelId } = await import("../../src/models/providerDefaultModel.ts");

  const byId = Object.fromEntries(
    modelRegistryData.cloudProviders.map((provider: { id: string }) => [provider.id, provider])
  );

  await t.test("the shared helper prefers the named default over list position", () => {
    // The seed leads with its own default, so only a list that doesn't can
    // tell the two rules apart.
    assert.equal(
      pickDefaultModelId({
        models: [{ id: "listed-first" }, { id: "named" }],
        defaultModel: "named",
      }),
      "named"
    );
    assert.equal(pickDefaultModelId(byId.tinfoil), "glm-5-3");
  });

  await t.test("a provider that names no default still leads with its first model", () => {
    assert.equal(pickDefaultModelId(byId.openai), byId.openai.models[0].id);
    assert.equal(pickDefaultModelId(undefined), "");
  });
});

// The sweep runs before any fetch, so a replacement outside the curated seed
// has no display name to show yet. Naming it by id keeps the notice truthful
// rather than dropping it; reconcileSelectedModels degrades the same way.
test("a replacement with no curated name is still announced, by id", async (t: import("node:test").TestContext) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _llmScopeKeysMigrated: "1",
      tinfoilModels: JSON.stringify({
        models: [{ id: "kimi-k2-6", name: "Kimi K2.6", description: "", supportsThinking: true }],
        fetchedAt: Date.now(),
      }),
      cleanupMode: "providers",
      cleanupProvider: "tinfoil",
      cleanupModel: "kimi-k2-6",
    },
  });
  const vite = await getVite();

  const { useSettingsStore } = (await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  )) as typeof import("../../src/stores/settingsStore.ts");

  const { consumeTinfoilModelSwitches } = (await vite.ssrLoadModule(
    "/stores/tinfoilModelSwitchStore.ts"
  )) as typeof import("../../src/stores/tinfoilModelSwitchStore.ts");

  assert.equal(useSettingsStore.getState().cleanupModel, "kimi-k3");
  assert.deepEqual(consumeTinfoilModelSwitches(), [{ from: "Kimi K2.6", to: "kimi-k3" }]);
});
