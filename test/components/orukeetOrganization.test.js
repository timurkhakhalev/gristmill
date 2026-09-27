const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const path = require("node:path");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

let vitePromise;
const cleanup = [];
test.after(async () => {
  for (const close of cleanup) await close();
});

const noop = () => {};
async function renderer(t, electronAPI = {}) {
  installBrowserGlobals(t, {
    window: { location: { search: "" }, electronAPI: { getPlatform: () => "darwin", ...electronAPI } },
  });
  const vite = await (vitePromise ??= createRendererServer({ after: (close) => cleanup.push(close) }, {
    cachePrefix: "openwhispr-oruk-organization-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    mockModules: {
      "react-i18next": `export function useTranslation() { return {t(key, options) {return options?.version ? key + ":" + options.version : key;}}; }`,
    },
  }));
  for (const url of ["/stores/settingsStore.ts", "/components/settings/models/LocalModelInventory.tsx"]) {
    const module = await vite.moduleGraph.getModuleByUrl(url);
    if (module) vite.moduleGraph.invalidateModule(module);
  }
  return vite;
}

const sherpaModels = (downloaded) => async () => ({
  success: true,
  models: downloaded.map((model) => ({ model, downloaded: true })),
});

/** Runs a hook body inside a real React root and returns what it last produced. */
async function runHooks(t, vite, body) {
  const container = installHookDom(t);
  const { ToastContext } = await vite.ssrLoadModule("/components/ui/useToast.ts");
  let result;
  function Harness() {
    result = body();
    return null;
  }
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(ToastContext.Provider, { value: { toast: noop } }, React.createElement(Harness)));
  });
  await React.act(async () => {});
  // Unmount inside the test: t.after runs once the browser globals are gone.
  mounted.push(root);
  return () => result;
}

const mounted = [];
async function unmountAll() {
  while (mounted.length) {
    const root = mounted.pop();
    await React.act(async () => root.unmount());
  }
}

const inventoryApi = (overrides = {}) => ({
  listWhisperModels: async () => ({ success: true, models: [] }),
  listParakeetModels: sherpaModels([]),
  modelGetAll: async () => [],
  modelGetActiveDownloads: async () => [],
  checkParakeetInstallation: async () => ({ installed: true, working: true, supported: true }),
  onWhisperDownloadProgress: () => noop,
  onParakeetDownloadProgress: () => noop,
  onModelDownloadProgress: () => noop,
  ...overrides,
});

async function inventory(t, vite) {
  const { LocalModelInventoryProvider } = await vite.ssrLoadModule("/components/settings/models/LocalModelInventory.tsx");
  // The provider's value is the inventory; calling it as a hook body exposes it without a DOM for its dialog.
  const read = await runHooks(t, vite, () => LocalModelInventoryProvider({ children: null }).props.value);
  return read;
}

test("Orukeet is listed under Oruk and selecting it keeps the NVIDIA (sherpa) backend", async (t) => {
  const vite = await renderer(t, inventoryApi({ listParakeetModels: sherpaModels(["orukeet-v0.1.0"]) }));
  const read = await inventory(t, vite);
  const { localGroups } = await vite.ssrLoadModule("/components/settings/models/taskCatalog.ts");
  const { selectLocalModel } = await vite.ssrLoadModule("/components/settings/models/taskModels.ts");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const state = useSettingsStore.getState();
  t.after(() => useSettingsStore.setState(state));

  const groups = localGroups("speech", read().speech);
  assert.equal(groups[0].id, "oruk", "Oruk leads the local speech list");
  const orukeet = groups.find((group) => group.id === "oruk").entries.find((entry) => entry.id === "orukeet-v0.1.0");
  assert.ok(orukeet?.downloaded);
  assert.ok(groups.find((group) => group.id === "nvidia").entries.some((entry) => entry.id === "parakeet-tdt-0.6b-v3"));

  for (const task of ["meeting", "upload"]) {
    selectLocalModel(task, orukeet);
    const prefix = task === "meeting" ? "meeting" : "upload";
    const next = useSettingsStore.getState();
    assert.equal(next[`${prefix}TranscriptionMode`], "local");
    assert.equal(next[`${prefix}LocalTranscriptionProvider`], "nvidia");
    assert.equal(next[`${prefix}ParakeetModel`], "orukeet-v0.1.0");
  }
  await unmountAll();
});

test("adding Orukeet preserves fresh-install transcription modes and existing backend defaults", async (t) => {
  const vite = await renderer(t);
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const state = useSettingsStore.getState();
  for (const prefix of ["", "meeting", "upload"]) {
    const key = (name) => (prefix ? prefix + name[0].toUpperCase() + name.slice(1) : name);
    assert.equal(state[key("useLocalWhisper")], false);
    assert.equal(state[key("localTranscriptionProvider")], "whisper");
    assert.equal(state[key("parakeetModel")], "");
  }
});

test("on a Mac without the sherpa runtime, Oruk, NVIDIA and Cohere are unavailable and tasks fall back to Whisper", async (t) => {
  const vite = await renderer(t, inventoryApi({
    checkParakeetInstallation: async () => ({ installed: false, working: false, supported: false, minimumMacOSVersion: "15.5" }),
  }));
  const read = await inventory(t, vite);
  for (const entry of read().speech) {
    const sherpa = entry.organization !== "whisper";
    assert.equal(!!entry.unavailableReason, sherpa, entry.id);
  }
  assert.equal(read().sherpaSupported, false);

  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { useTranscriptionPolicies } = await vite.ssrLoadModule("/components/settings/models/transcriptionPolicies.ts");
  const state = useSettingsStore.getState();
  t.after(() => useSettingsStore.setState(state));
  useSettingsStore.getState().setMeetingLocalTranscriptionProvider("nvidia");
  useSettingsStore.getState().setUploadLocalTranscriptionProvider("cohere");
  await runHooks(t, vite, () => useTranscriptionPolicies(false));
  assert.equal(useSettingsStore.getState().meetingLocalTranscriptionProvider, "whisper");
  assert.equal(useSettingsStore.getState().uploadLocalTranscriptionProvider, "whisper");
  await unmountAll();
});
