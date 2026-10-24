const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const React: typeof import("react") = require("react");
const { createRoot }: typeof import("react-dom/client") = require("react-dom/client");
const {
  createRendererServer, installBrowserGlobals, installHookDom,
}: typeof import("../../../../lib/rendererTestHarness.ts") = require("../../../../lib/rendererTestHarness.ts");
const {
  loadBundledPreload,
}: typeof import("../../../../helpers/harness/bundledPreload.ts") = require("../../../../helpers/harness/bundledPreload.ts");
import type { LocalLlmModelsApi } from "../../../../../src/contracts/localLlmModels.ts";
import type { LocalModelInventory } from "../../../../../src/components/settings/models/inventoryContext.ts";
const catalog: typeof import("../../../../../src/models/modelRegistryData.json") = require("../../../../../src/models/modelRegistryData.json");

test("downloaded LLMs can be selected and reconciliation preserves them across failures", async (t) => {
  const provider = catalog.localProviders[0];
  const model = provider.models[0];
  let raw: unknown = [{
    ...model, providerId: provider.id, providerName: provider.name,
    isDownloaded: true, isDownloading: false, downloadProgress: 0,
    downloadedSize: 0, totalSize: 0, path: `/synthetic-models/${model.fileName}`,
  }];
  let failTransport = false;
  const bridge = loadBundledPreload<LocalLlmModelsApi>({
    invoke: async (channel) => {
      if (channel === "model-get-all" && !failTransport) return raw;
      if (channel === "model-get-active-downloads") return [{
        modelType: "llm", modelId: model.id, phase: "downloading", progress: 42,
        downloadedBytes: 420, totalBytes: 1000, sequence: 1,
      }];
      throw new Error("Synthetic IPC failure");
    },
  });
  installBrowserGlobals(t, { window: { electronAPI: {
    modelGetAll: bridge.modelGetAll,
    modelGetActiveDownloads: bridge.modelGetActiveDownloads,
    listWhisperModels: async () => ({ success: true, models: [] }),
    listParakeetModels: async () => ({ success: true, models: [] }),
    checkParakeetInstallation: async () => ({ supported: true }),
    onModelDownloadProgress: () => () => {},
    onWhisperDownloadProgress: () => () => {},
    onParakeetDownloadProgress: () => () => {},
  } } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "gristmill-local-llm-inventory-",
    mockModules: { "react-i18next": `export function useTranslation() { return { t: (key) => key }; }` },
  });
  const { LocalModelInventoryProvider } = await vite.ssrLoadModule("/components/settings/models/LocalModelInventory.tsx");
  const { ToastContext } = await vite.ssrLoadModule("/components/ui/useToast.ts");
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts") as typeof import("../../../../../src/stores/settingsStore.ts");
  const { selectLocalModel } = await vite.ssrLoadModule("/components/settings/models/taskModels.ts") as typeof import("../../../../../src/components/settings/models/taskModels.ts");
  let inventory!: LocalModelInventory;
  function Harness() {
    inventory = LocalModelInventoryProvider({ children: null }).props.value;
    return null;
  }
  const root = createRoot(container as unknown as Element);
  // Unmount before the harness restores browser globals.
  try {
    await React.act(async () => root.render(React.createElement(ToastContext.Provider,
      { value: { toast() {} } }, React.createElement(Harness))));
    const entry = inventory.language.find((item) => item.id === model.id);
    assert.ok(entry?.downloaded, "the picker must see the downloaded model");
    assert.equal(inventory.downloadState(entry)?.progress, 42, "active downloads pass through preload to the inventory");
    selectLocalModel("noteFormatting", entry);
    assert.equal(settings.getSettings().noteFormattingMode, "local");
    assert.equal(settings.getSettings().noteFormattingModel, model.id);
    await settings.reconcileLocalModelSelections();
    assert.equal(settings.getSettings().noteFormattingModel, model.id);

    raw = [{}];
    await assert.rejects(settings.reconcileLocalModelSelections(), /model-get-all/);
    assert.equal(settings.getSettings().noteFormattingModel, model.id, "malformed inventory cannot clear the selection");
    failTransport = true;
    await assert.rejects(settings.reconcileLocalModelSelections(), /Synthetic IPC failure/);
    assert.equal(settings.getSettings().noteFormattingModel, model.id, "transport failures cannot clear the selection");
    failTransport = false;
    raw = [];
    await settings.reconcileLocalModelSelections();
    assert.equal(settings.getSettings().noteFormattingModel, "", "a valid empty catalog clears a missing model");
  } finally {
    await React.act(async () => root.unmount());
  }
});
