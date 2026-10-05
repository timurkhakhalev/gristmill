const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const {
  createRendererServer,
  installBrowserGlobals,
}: typeof import("../lib/rendererTestHarness.ts") = require("../lib/rendererTestHarness.ts");

test("secret settings expose values only after encrypted persistence succeeds", async (t: import("node:test").TestContext) => {
  const { storage } = installBrowserGlobals(t, {
    window: {
      dispatchEvent() {},
      electronAPI: {
        saveOpenAIKey: async () => ({ success: false }),
        saveNoteFormattingCustomKey: async () => ({ success: false }),
      },
    },
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "gristmill-secret-settings-persistence-",
    mockModules: {
      "/services/ReasoningService":
        "export default class ReasoningService { static clearApiKeyCache() {} }",
    },
  });

  const { useSettingsStore, setResolvedLLMConfig } = (await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  )) as typeof import("../../src/stores/settingsStore.ts");

  const store = useSettingsStore.getState();

  assert.deepEqual(await store.setOpenaiApiKey("openai-secret"), { success: false });
  assert.equal(useSettingsStore.getState().openaiApiKey, "");
  assert.equal(storage.getItem("openaiApiKey"), null);

  globalThis.window.electronAPI.saveOpenAIKey = async () => ({ success: true });
  assert.deepEqual(await store.setOpenaiApiKey("openai-secret"), { success: true });
  assert.equal(useSettingsStore.getState().openaiApiKey, "openai-secret");

  assert.deepEqual(
    await setResolvedLLMConfig("noteFormatting", { customApiKey: "custom-secret" }),
    { success: false }
  );
  assert.equal(useSettingsStore.getState().noteFormattingCustomApiKey, "");

  globalThis.window.electronAPI.saveNoteFormattingCustomKey = async () => ({ success: true });
  assert.deepEqual(
    await setResolvedLLMConfig("noteFormatting", { customApiKey: "custom-secret" }),
    { success: true }
  );
  assert.equal(useSettingsStore.getState().noteFormattingCustomApiKey, "custom-secret");
  assert.equal(storage.getItem("noteFormattingCustomApiKey"), null);
});
