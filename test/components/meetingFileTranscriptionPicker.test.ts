const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test") = require("node:test");
const path: typeof import("node:path") = require("node:path");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness.ts") as typeof import("../lib/rendererTestHarness.js");

type TestContext = import("node:test").TestContext;
interface CatalogModel { id: string; name: string; }
interface CatalogGroup { providerId: string; models: CatalogModel[]; form?: string; }

test("meeting model choices are only models the post-Stop file worker can process", async (t: TestContext) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "meeting-file-picker-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    mockModules: {
      "react-i18next": `export function useTranslation() { return { t(key) { return key; } }; }`,
    },
  });
  const { getMeetingFileTranscriptionProviders } = await vite.ssrLoadModule(
    "/models/ModelRegistry.ts"
  );
  const { supportedMeetingFileProvider } = await vite.ssrLoadModule(
    "/helpers/meetingFileTranscription.ts"
  );
  const { resolveTranscriptionRoute } = await vite.ssrLoadModule("/helpers/transcriptionRoute.ts");
  const { cloudGroups } = await vite.ssrLoadModule("/components/settings/models/taskCatalog.ts");
  const translate = (key: string) => key;
  const providers = getMeetingFileTranscriptionProviders();
  assert.deepEqual(
    providers.map((provider: { id: string }) => provider.id),
    ["openai", "gemini", "deepgram", "elevenlabs"]
  );
  assert.deepEqual(
    Object.fromEntries(
      providers.map((provider: { id: string; models: Array<{ id: string }> }) => [provider.id, provider.models.map((model: { id: string }) => model.id)])
    ),
    {
      openai: ["gpt-4o-transcribe-diarize"],
      gemini: ["gemini-3.5-transcribe"],
      deepgram: ["nova-3"],
      elevenlabs: ["scribe_v2"],
    }
  );

  for (const provider of providers) {
    for (const model of provider.models) {
      assert.equal(supportedMeetingFileProvider(provider.id, model.id), provider.id);
      const route = resolveTranscriptionRoute({
        settings: {
          transcriptionMode: "providers",
          cloudTranscriptionProvider: provider.id,
          cloudTranscriptionModel: model.id,
        },
      });
      assert.notEqual(route.transport, "error", `${provider.id}/${model.id} has no file route`);
      assert.equal(route.provider, provider.id);
      assert.equal(route.model, model.id);

    }
  }

  // The Models page offers a meeting exactly these providers and models, no live/streaming ones.
  const meetingGroups = cloudGroups("meeting", translate, []) as unknown as CatalogGroup[];
  assert.deepEqual(
    Object.fromEntries(meetingGroups.map((group: CatalogGroup) => [group.providerId, group.models.map((model: CatalogModel) => model.id)])),
    Object.fromEntries(providers.map((provider: { id: string; models: Array<{ id: string }> }) => [provider.id, provider.models.map((model: { id: string }) => model.id)]))
  );
  assert.equal(meetingGroups.some((group: CatalogGroup) => group.form), false, "meetings have no custom endpoint");
  const names = meetingGroups.flatMap((group: CatalogGroup) => group.models.map((model: CatalogModel) => model.name)).join("\n");
  assert.doesNotMatch(names, /Gemini 3\.5 Transcribe Live|GPT-4o Mini Transcribe|Universal Streaming/);

  const uploadGroups = cloudGroups("upload", translate, []) as unknown as CatalogGroup[];
  assert.ok(uploadGroups.some((group: CatalogGroup) => group.form === "custom"), "uploads keep the custom endpoint");
});

test("switching meeting providers selects a file model, including ElevenLabs and Gemini", async (t: TestContext) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "meeting-file-switch-" });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const state = useSettingsStore.getState();
  t.after(() => useSettingsStore.setState(state));
  useSettingsStore.setState({
    meetingCloudTranscriptionProvider: "openai",
    meetingCloudTranscriptionModel: "gpt-4o-transcribe-diarize",
    transcriptionModelByProvider: {},
  });
  for (const [provider, model] of [
    ["gemini", "gemini-3.5-transcribe"],
    ["elevenlabs", "scribe_v2"],
    ["deepgram", "nova-3"],
    ["openai", "gpt-4o-transcribe-diarize"],
  ]) {
    useSettingsStore.getState().switchCloudTranscriptionProvider("meeting", provider);
    assert.equal(useSettingsStore.getState().meetingCloudTranscriptionProvider, provider);
    assert.equal(useSettingsStore.getState().meetingCloudTranscriptionModel, model);
  }
});
