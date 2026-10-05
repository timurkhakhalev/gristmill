const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const os: typeof import("node:os") = require("node:os");

const path: typeof import("node:path") = require("node:path");

const Module = require("node:module");

const {
  createRendererServer,
  installBrowserGlobals,
}: typeof import("../lib/rendererTestHarness.ts") = require("../lib/rendererTestHarness.ts");

function installNavigatorLanguage(t: import("node:test").TestContext, language: string) {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { language, languages: [language] },
  });
  t.after(() => {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    } else {
      Reflect.deleteProperty(globalThis, "navigator");
    }
  });
}

function loadEnvironmentManager(t: import("node:test").TestContext, userDataDirectory: unknown) {
  const originalLoad = Module._load;
  const environmentPath = require.resolve("../../src/helpers/environment");
  delete require.cache[environmentPath];

  Module._load = function loadWithElectronStub(request: string, parent: unknown, isMain: boolean) {
    if (request === "electron") {
      return {
        app: {
          getPath: () => userDataDirectory,
          getAppPath: () => userDataDirectory,
          isReady: () => false,
        },
        safeStorage: {
          isEncryptionAvailable: () => false,
        },
      };
    }

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("../../src/helpers/environment");
  } finally {
    Module._load = originalLoad;
    t.after(() => delete require.cache[environmentPath]);
  }
}

test("fresh Chinese browser locale survives settings hydration", async (t: import("node:test").TestContext) => {
  installNavigatorLanguage(t, "zh-Hans-CN");
  installBrowserGlobals(t, {
    initialStorage: {
      customDictionary: JSON.stringify(["OpenWhispr"]),
    },
    window: {
      electronAPI: {
        getDictionary: async () => ["OpenWhispr"],
        getUiLanguage: async () => "",
        applyDictionaryChanges: async () => ({ success: true, added: 0, removed: 0 }),
      },
    },
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-ui-language-startup-test-",
  });

  const { default: i18n } = (await vite.ssrLoadModule(
    "/i18n.ts"
  )) as typeof import("../../src/i18n.ts");

  const { initializeSettings, useSettingsStore } = (await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  )) as typeof import("../../src/stores/settingsStore.ts");

  const initialLanguage = i18n.language;
  const initialStoreLanguage = useSettingsStore.getState().uiLanguage;

  await initializeSettings();

  assert.deepEqual(
    {
      initialLanguage,
      initialStoreLanguage,
      hydratedLanguage: i18n.language,
      hydratedStoreLanguage: useSettingsStore.getState().uiLanguage,
      persistedLanguage: localStorage.getItem("uiLanguage"),
    },
    {
      initialLanguage: "zh-CN",
      initialStoreLanguage: "zh-CN",
      hydratedLanguage: "zh-CN",
      hydratedStoreLanguage: "zh-CN",
      persistedLanguage: null,
    }
  );
});

test("main locale fallback remains implicit and yields to an explicit preference", (t: import("node:test").TestContext) => {
  const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-ui-language-"));
  const originalEnvironment = { ...process.env };
  const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: userDataDirectory });
  delete process.env.UI_LANGUAGE;
  t.after(() => {
    process.env = originalEnvironment;

    if (originalResourcesPath)
      Object.defineProperty(process, "resourcesPath", originalResourcesPath);
    else Reflect.deleteProperty(process, "resourcesPath");
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
  });

  const EnvironmentManager = loadEnvironmentManager(t, userDataDirectory);
  const environmentManager = new EnvironmentManager();
  const unsetLanguage = environmentManager.getUiLanguage();
  const detectedLanguage = environmentManager.getUiLanguage("zh-Hant-TW");
  const environmentAfterDetection = process.env.UI_LANGUAGE;

  process.env.UI_LANGUAGE = "de-DE";
  const explicitLanguage = environmentManager.getUiLanguage("zh-Hant-TW");

  assert.deepEqual(
    { unsetLanguage, detectedLanguage, environmentAfterDetection, explicitLanguage },
    {
      unsetLanguage: "",
      detectedLanguage: "zh-TW",
      environmentAfterDetection: undefined,
      explicitLanguage: "de",
    }
  );
});
