import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createRendererServer, installBrowserGlobals } from "../../../lib/rendererTestHarness.ts";
import type { ProviderContext } from "../../../../src/services/ai/inferenceProviders/types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const live = [{ id: "glm-5-3", name: "GLM-5.3", description: "", supportsThinking: true }];
const cached = (supportsThinking = false) => [{ ...live[0], supportsThinking, supportsTemperature: false, tokenParam: "max_tokens" }];

async function fixture(t: TestContext, fresh = false) {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request in catalog fixture"); });
  let fetches = 0;
  const catalog = deferred<typeof live>();
  const acquired = deferred<void>();
  const gate = deferred<void>();
  const bodies: Record<string, unknown>[] = [];
  const streams: Record<string, unknown>[] = [];
  const state = { gate: gate.promise, acquired: () => acquired.resolve(), bodies, streams };
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1", _retiredCloudModelsSwept: "1",
      tinfoilModels: JSON.stringify({ models: cached(), fetchedAt: fresh ? Date.now() : 1 }) },
    window: { fixture: state, electronAPI: { getTinfoilKey: async () => "test-key", getTinfoilChatModels: () => { fetches++; return catalog.promise; } } },
  });
  const vite = await createRendererServer(t, { cachePrefix: "tinfoil-effects-", noExternal: ["tinfoil", "ai"], resolveAlias: { tinfoil: "/tinfoil-fixture", ai: "/ai-fixture" }, mockModules: {
    "/tinfoil-fixture": `export class TinfoilAI { constructor() { window.fixture.acquired(); return window.fixture.gate.then(() => ({ chat: { completions: { create: async body => { window.fixture.bodies.push(body); return {choices:[{message:{content:"ok"}}]}; } } } })); } }
      export async function createTinfoilAI() { window.fixture.acquired(); await window.fixture.gate; return model => ({ modelId: model }); }`,
    "/ai-fixture": `export const stepCountIs = n => n; export const streamText = args => { window.fixture.streams.push(args); return {fullStream:(async function*(){yield {type:"finish",finishReason:"stop"};})()}; };`,
  } });
  const owner = await vite.ssrLoadModule("/models/tinfoilModels.ts") as typeof import("../../../../src/models/tinfoilModels.ts");
  const registry = await vite.ssrLoadModule("/models/ModelRegistry.ts") as typeof import("../../../../src/models/ModelRegistry.ts");
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts") as typeof import("../../../../src/stores/settingsStore.ts");
  const notices = await vite.ssrLoadModule("/stores/tinfoilModelSwitchStore.ts") as typeof import("../../../../src/stores/tinfoilModelSwitchStore.ts");
  notices.consumeTinfoilModelSwitches();
  return { vite, storage, owner, registry, settings, notices, catalog, acquired, gate, bodies, streams, fetches: () => fetches };
}
const ctx: ProviderContext = {
  getApiKey: async () => "test-key", getSystemPrompt: () => "system", calculateMaxTokens: () => 1000,
  getCustomDictionary: () => [], getPreferredLanguage: () => "en", getUiLanguage: () => "en",
  callChatCompletionsApi: async () => { throw new Error("Unexpected transport"); },
};

test("cold and cached Tinfoil transport acquisition has no catalog or settings effects", async t => {
  const f = await fixture(t);
  const clients = await f.vite.ssrLoadModule("/services/ai/tinfoilClient.ts") as typeof import("../../../../src/services/ai/tinfoilClient.ts");
  f.gate.resolve();
  assert.equal(await clients.getTinfoilChatClient("key"), await clients.getTinfoilChatClient("key"));
  await clients.getTinfoilLanguageModel("key", "glm-5-3");
  await clients.getTinfoilLanguageModel("key", "glm-5-3");
  assert.equal(f.fetches(), 0);
  assert.equal(f.registry.getCloudModel("glm-5-3")?.supportsThinking, false);
  assert.deepEqual(f.notices.consumeTinfoilModelSwitches(), []);
  await assert.rejects(() => clients.getTinfoilChatClient(" "), /key not configured/);
});

test("explicit expired refresh deduplicates, persists and repairs only retired Tinfoil slots", async t => {
  const f = await fixture(t);
  f.settings.useSettingsStore.setState({ cleanupProvider: "tinfoil", cleanupModel: "retired-test", noteFormattingProvider: "tinfoil", noteFormattingModel: "retired-test", chatAgentProvider: "groq", chatAgentModel: "keep-groq" });
  const first = f.owner.refreshTinfoilCatalogAndReconcileSelections();
  assert.equal(first, f.owner.refreshTinfoilCatalogAndReconcileSelections());
  assert.equal(f.fetches(), 1);
  assert.equal(f.settings.getSettings().cleanupModel, "retired-test");
  f.catalog.resolve(live);
  await first;
  assert.equal(f.settings.getSettings().cleanupModel, "glm-5-3");
  assert.equal(f.settings.getSettings().noteFormattingModel, "glm-5-3");
  assert.equal(f.settings.getSettings().chatAgentModel, "keep-groq");
  assert.deepEqual(f.notices.consumeTinfoilModelSwitches(), [{ from: "retired-test", to: "GLM-5.3" }]);
  assert.ok(JSON.parse(f.storage.getItem("tinfoilModels")!).fetchedAt > 1);
  await f.owner.refreshTinfoilCatalogAndReconcileSelections();
  assert.equal(f.fetches(), 1);
  assert.deepEqual(f.notices.consumeTinfoilModelSwitches(), []);
});

for (const failure of ["failed", "empty"] as const) {
  test(`${failure} refresh preserves registry, selections and notices`, async t => {
    const f = await fixture(t);
    f.settings.useSettingsStore.setState({ cleanupProvider: "tinfoil", cleanupModel: "retired-test" });
    const refresh = f.owner.refreshTinfoilCatalogAndReconcileSelections();
    if (failure === "failed") f.catalog.reject(new Error("offline")); else f.catalog.resolve([]);
    await assert.rejects(() => refresh);
    assert.equal(f.settings.getSettings().cleanupModel, "retired-test");
    assert.equal(f.registry.getCloudModel("glm-5-3")?.supportsThinking, false);
    assert.deepEqual(f.notices.consumeTinfoilModelSwitches(), []);
  });
}

for (const early of [true, false]) {
  test(`single-shot keeps its request snapshot when catalog completes ${early ? "before" : "after"} SDK setup`, async t => {
    const f = await fixture(t);
    const { tinfoilProvider } = await f.vite.ssrLoadModule("/services/ai/inferenceProviders/tinfoil.ts") as typeof import("../../../../src/services/ai/inferenceProviders/tinfoil.ts");
    const call = () => tinfoilProvider.call({ text: "text", model: "glm-5-3", agentName: null, config: { disableThinking: true }, ctx });
    const request = call();
    await f.acquired.promise;
    if (early) { f.catalog.resolve(live); await f.owner.refreshTinfoilCatalogAndReconcileSelections(); }
    f.gate.resolve();
    assert.equal(await request, "ok");
    assert.equal(f.bodies[0].model, "glm-5-3");
    assert.equal(f.bodies[0].chat_template_kwargs, undefined);
    if (!early) { f.catalog.resolve(live); await f.owner.refreshTinfoilCatalogAndReconcileSelections(); }
    await call(); // Client cache hit still enters the explicit request operation.
    assert.deepEqual(f.bodies[1].chat_template_kwargs, { enable_thinking: false });
  });
}

test("fresh cache from another window is applied before single-shot metadata snapshot", async t => {
  const f = await fixture(t, true);
  f.registry.applyTinfoilModels(cached(true) as Parameters<typeof f.registry.applyTinfoilModels>[0]);
  const { tinfoilProvider } = await f.vite.ssrLoadModule("/services/ai/inferenceProviders/tinfoil.ts") as typeof import("../../../../src/services/ai/inferenceProviders/tinfoil.ts");
  f.gate.resolve();
  await tinfoilProvider.call({ text: "text", model: "glm-5-3", agentName: null, config: { disableThinking: true }, ctx });
  assert.equal(f.bodies[0].chat_template_kwargs, undefined);
  assert.equal(f.fetches(), 0);
});

for (const early of [true, false]) {
  test(`SDK stream keeps sampling snapshot with ${early ? "early" : "late"} refresh`, async t => {
    const f = await fixture(t);
    const service = (await f.vite.ssrLoadModule("/services/ReasoningService.ts") as typeof import("../../../../src/services/ReasoningService.ts")).default;
    t.after(() => service.destroy());
    const collect = async () => { for await (const _chunk of service.processTextStreamingAI([{role:"user",content:"text"}], "glm-5-3", "tinfoil", {systemPrompt:"system"})) { /* consume */ } };
    const request = collect();
    await f.acquired.promise;
    if (early) { f.catalog.resolve(live); await f.owner.refreshTinfoilCatalogAndReconcileSelections(); }
    f.gate.resolve();
    await request;
    assert.equal(f.streams[0].temperature, undefined);
    assert.equal((f.streams[0].model as {modelId:string}).modelId, "glm-5-3");
    if (!early) { f.catalog.resolve(live); await f.owner.refreshTinfoilCatalogAndReconcileSelections(); }
    await collect();
    assert.equal(f.streams[1].temperature, 0.3);
  });
}

test("missing key triggers neither catalog refresh nor inference transport", async t => {
  const f = await fixture(t);
  const { tinfoilProvider } = await f.vite.ssrLoadModule("/services/ai/inferenceProviders/tinfoil.ts") as typeof import("../../../../src/services/ai/inferenceProviders/tinfoil.ts");
  await assert.rejects(() => tinfoilProvider.call({text:"text",model:"glm-5-3",agentName:null,config:{},ctx:{...ctx,getApiKey:async()=>" "}}), /key not configured/);
  const service = (await f.vite.ssrLoadModule("/services/ReasoningService.ts") as typeof import("../../../../src/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  (window.electronAPI as unknown as {getTinfoilKey:()=>Promise<string>}).getTinfoilKey = async () => " ";
  await assert.rejects(async () => { for await (const _chunk of service.processTextStreamingAI([{role:"user",content:"text"}],"glm-5-3","tinfoil",{systemPrompt:"system"})) { /* consume */ } });
  assert.equal(f.fetches(), 0);
  assert.equal(f.bodies.length + f.streams.length, 0);
});


test("Self-Hosted with saved Tinfoil provider and tools needs no Tinfoil key or catalog", async t => {
  const f = await fixture(t);
  const service = (await f.vite.ssrLoadModule("/services/ReasoningService.ts") as typeof import("../../../../src/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  for await (const _chunk of service.processTextStreamingAI([{ role: "user", content: "text" }],
    "local-model", "tinfoil", { systemPrompt: "system", lanUrl: "http://127.0.0.1:8080", customApiKey: "" }, {})) { /* consume */ }
  assert.equal(f.fetches(), 0);
  assert.equal(f.streams.length, 1);
  assert.equal((f.streams[0].model as {modelId:string}).modelId, "local-model");
});
