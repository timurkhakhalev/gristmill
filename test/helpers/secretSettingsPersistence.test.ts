import assert from "node:assert/strict";
import test from "node:test";

import { createRendererServer, installBrowserGlobals } from "../lib/rendererTestHarness.ts";

// The canonical runner loads these files through tsx in CJS mode, so top-level
// await is unavailable; node:test awaits every root registration itself, and
// this wrapper only keeps the registration promise observed.
const it = (name: string, fn: (t: import("node:test").TestContext) => Promise<void>): void => {
  test(name, fn).catch((error: Error) => {
    throw error;
  });
};

it("secret settings expose values only after encrypted persistence succeeds", async (t: import("node:test").TestContext) => {
  const { storage } = installBrowserGlobals(t, {
    window: {
      dispatchEvent(): boolean {
        return true;
      },
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

  // SAFETY: the URL above loads this repo's own settings store; the assertion
  // names its module surface for the assertions below.
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
