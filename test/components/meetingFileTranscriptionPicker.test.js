const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const path = require("node:path");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const noop = () => {};

test("meeting picker offers only models the post-Stop file worker can process", async (t) => {
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
  const { default: Picker } = await vite.ssrLoadModule("/components/TranscriptionModelPicker.tsx");
  const { ToastProvider } = await vite.ssrLoadModule("/components/ui/Toast.tsx");

  const providers = getMeetingFileTranscriptionProviders();
  assert.deepEqual(
    providers.map((provider) => provider.id),
    ["openai", "gemini", "deepgram", "elevenlabs"]
  );
  assert.deepEqual(
    Object.fromEntries(
      providers.map((provider) => [provider.id, provider.models.map((model) => model.id)])
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

      const html = renderToStaticMarkup(
        React.createElement(
          ToastProvider,
          null,
          React.createElement(Picker, {
            transcriptionContext: "meeting",
            mode: "cloud",
            selectedCloudProvider: provider.id,
            selectedCloudModel: model.id,
            selectedLocalModel: "base",
            useLocalWhisper: false,
            onCloudProviderSelect: noop,
            onCloudModelSelect: noop,
            onLocalModelSelect: noop,
            onModeChange: noop,
          })
        )
      );
      assert.match(html, new RegExp(model.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(
        html,
        /Gemini 3\.5 Transcribe Live|GPT-4o Mini Transcribe|Universal Streaming/
      );
    }
  }
});

test("switching meeting providers selects a file model, including ElevenLabs and Gemini", async (t) => {
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
