const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
import type { ComponentType } from "react";
const React = require("react") as typeof import("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
}: typeof import("../lib/rendererTestHarness.ts") = require("../lib/rendererTestHarness.ts");

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = unknown>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface DownloadState {
  modelType: string;
  modelId: string;
  phase: string;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  sequence: number;
}

type DownloadApi = {
  modelGetActiveDownloads?: () => Promise<DownloadState[]>;
  onModelDownloadProgress?: (listener: (event: Record<string, unknown>) => void) => () => void;
  onWhisperDownloadProgress?: (listener: unknown) => () => void;
  onParakeetDownloadProgress?: (listener: unknown) => () => void;
  modelCancelDownload?: (modelId: string) => Promise<{ success: boolean }>;
  modelDownload?: (modelId: string, onSelected?: () => void) => Promise<unknown>;
  downloadWhisperModel?: (modelId: string) => Promise<unknown>;
  downloadParakeetModel?: (modelId: string) => Promise<unknown>;
};

async function createDownloadRenderer(t: import("node:test").TestContext, electronAPI: DownloadApi) {
  let root: ReturnType<typeof createRoot> | null = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, {
    window: { electronAPI, dispatchEvent() {} },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-model-download-errors-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export function useTranslation() { return { t }; }
      `,
      "/components/ui/useToast": `
        const context = { toast() {} };
        export function useToast() { return context; }
      `,
      "/stores/settingsStore": `
        export function clearMissingLocalModelSelections() {}
        export function isCloudCleanupMode() { return false; }
        export function getSettings() { return {}; }
      `,
      "/ProviderSetupStep": `export const SETUP_CARD_CLASS = "";`,
      "/ui/ProviderIcon": `export function ProviderIcon() { return null; }`,
    },
  });
  return {
    vite,
    async render(Component: ComponentType) {
      root ??= createRoot(container as unknown as Element);
      await React.act(async () => root.render(React.createElement(Component)));
    },
    async unmount() {
      await React.act(async () => root.unmount());
      root = null;
    },
  };
}

test("remount restores concurrent LLM downloads and cancellation settles only its model", async (t: import("node:test").TestContext) => {
  let activeDownloads: DownloadState[] = [
    {
      modelType: "llm",
      modelId: "model-a",
      phase: "downloading",
      progress: 20,
      downloadedBytes: 200,
      totalBytes: 1000,
      sequence: 1,
    },
    {
      modelType: "llm",
      modelId: "model-b",
      phase: "downloading",
      progress: 30,
      downloadedBytes: 300,
      totalBytes: 1000,
      sequence: 2,
    },
  ];
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  const cancellations: string[] = [];
  let refreshes = 0;
  const renderer = await createDownloadRenderer(t, {
    modelGetActiveDownloads: async () => activeDownloads,
    onModelDownloadProgress(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async modelCancelDownload(modelId) {
      cancellations.push(modelId);
      return { success: true };
    },
  });
  const { useModelDownload } = (await renderer.vite.ssrLoadModule("/hooks/useModelDownload.ts") as typeof import("../../src/hooks/useModelDownload.ts"));
  let download: ReturnType<typeof useModelDownload> | undefined;
  function Harness() {
    download = useModelDownload({
      modelType: "llm",
      onDownloadComplete() {
        refreshes += 1;
      },
    });
    return null;
  }

  await renderer.render(Harness);
  assert.deepEqual(Object.keys(download!.downloads), ["model-a", "model-b"]);
  await renderer.unmount();
  assert.equal(listeners.size, 0);

  activeDownloads = [
    { ...activeDownloads[0], progress: 40, downloadedBytes: 400, sequence: 3 },
    { ...activeDownloads[1], progress: 50, downloadedBytes: 500, sequence: 4 },
  ];
  await renderer.render(Harness);
  assert.equal(download!.downloads["model-a"].progress, 40);
  assert.equal(download!.downloads["model-b"].progress, 50);

  await React.act(async () => download!.cancelDownload("model-a"));
  assert.deepEqual(cancellations, ["model-a"]);
  assert.equal(download!.isCancellingModel("model-a"), true);
  assert.equal(download!.isCancellingModel("model-b"), false);

  await React.act(async () => {
    for (const listener of listeners) {
      listener({
        type: "error",
        modelId: "model-a",
        error: "Download cancelled by user",
        code: "DOWNLOAD_CANCELLED",
        sequence: 5,
      });
    }
  });
  assert.deepEqual(Object.keys(download!.downloads), ["model-b"]);
  assert.equal(download!.isCancellingModel("model-a"), false);
  assert.deepEqual(download!.downloadErrors, {});

  await React.act(async () => {
    for (const listener of listeners) {
      listener({ type: "complete", modelId: "model-b", progress: 100, sequence: 6 });
    }
  });
  assert.equal(download!.isDownloading, false);
  assert.equal(refreshes, 2);
});

for (const outcome of ["error", "complete", "cancel"]) {
  test(`LLM duplicate recovery preserves ${outcome} before an empty snapshot`, async (t: import("node:test").TestContext) => {
    const duplicateResponse = deferred();
    const recoverySnapshot = deferred();
    let snapshotCalls = 0;
    let progressListener!: (event: Record<string, unknown>) => void;
    let refreshes = 0;
    const renderer = await createDownloadRenderer(t, {
      onModelDownloadProgress(listener) {
        progressListener = listener;
        return () => {};
      },
      modelGetActiveDownloads: () =>
        ++snapshotCalls === 1 ? Promise.resolve([]) : recoverySnapshot.promise as Promise<DownloadState[]>,
      modelDownload: () => duplicateResponse.promise,
    });
    const { useModelDownload } = (await renderer.vite.ssrLoadModule("/hooks/useModelDownload.ts") as typeof import("../../src/hooks/useModelDownload.ts"));
    let download: ReturnType<typeof useModelDownload> | undefined;
    function Harness() {
      download = useModelDownload({
        modelType: "llm",
        onDownloadComplete() {
          refreshes += 1;
        },
      });
      return null;
    }
    await renderer.render(Harness);
    let request!: Promise<unknown>;
    await React.act(async () => {
      request = download!.downloadModel("model-a");
    });
    await React.act(async () =>
      duplicateResponse.resolve({ success: false, code: "DOWNLOAD_IN_PROGRESS" })
    );
    assert.equal(snapshotCalls, 2);
    await React.act(async () => {
      progressListener(
        outcome === "complete"
          ? { modelId: "model-a", type: "complete", progress: 100, sequence: 2 }
          : {
              modelId: "model-a",
              type: "error",
              error: outcome === "cancel" ? "Download cancelled by user" : "ENOTFOUND",
              code: outcome === "cancel" ? "DOWNLOAD_CANCELLED" : "ENOTFOUND",
              sequence: 2,
            }
      );
    });
    await React.act(async () => {
      recoverySnapshot.resolve([]);
      await request;
    });
    assert.equal(download!.isDownloading, false);
    assert.equal(
      download!.downloadError,
      outcome === "error" ? "hooks.modelDownload.errors.notFound" : null
    );
    assert.equal(refreshes, 1);
  });
}

for (const modelType of ["whisper", "parakeet", "llm"]) {
  test(`${modelType} duplicate recovery ${modelType === "llm" ? "keeps exact model ownership" : "restores the active family model"}`, async (t: import("node:test").TestContext) => {
    let snapshotCalls = 0;
    const subscribe = () => () => {};
    const refuseDownload = async () => ({ success: false, code: "DOWNLOAD_IN_PROGRESS" });
    const active = {
      modelType,
      modelId: "active-model",
      phase: "downloading",
      progress: 42,
      downloadedBytes: 420,
      totalBytes: 1000,
      sequence: 2,
    };
    const renderer = await createDownloadRenderer(t, {
      onWhisperDownloadProgress: subscribe,
      onParakeetDownloadProgress: subscribe,
      onModelDownloadProgress: subscribe,
      modelGetActiveDownloads: async (): Promise<DownloadState[]> => (++snapshotCalls === 1 ? [] : [active]),
      downloadWhisperModel: refuseDownload,
      downloadParakeetModel: refuseDownload,
      modelDownload: refuseDownload,
    });
    const { useModelDownload } = await renderer.vite.ssrLoadModule("/hooks/useModelDownload.ts");
    let download: ReturnType<typeof useModelDownload> | undefined;
    function Harness() {
      download = useModelDownload({ modelType });
      return null;
    }
    await renderer.render(Harness);
    await React.act(async () => download!.downloadModel("requested-model"));
    assert.equal(download!.isDownloadingModel("requested-model"), false);
    assert.equal(download!.downloadingModel, modelType === "llm" ? null : "active-model");
    if (modelType !== "llm") assert.equal(download!.downloadProgress.percentage, 42);
  });
}

// Issue #182: a completed download must only land the model and refresh the
// inventory — it must never change the task's selected route. The deferred
// success arrives after the user has moved on, so any auto-select would override
// a newer choice. This pins the download callback to inventory-only.
test("a successful download refreshes the inventory and never applies a route selection", async (t: import("node:test").TestContext) => {
  const request = deferred();
  let refreshes = 0;
  const renderer = await createDownloadRenderer(t, {
    onModelDownloadProgress: () => () => {},
    modelGetActiveDownloads: async () => [],
    modelDownload: () => request.promise as Promise<unknown>,
  });
  const { useModelDownload } = await renderer.vite.ssrLoadModule("/hooks/useModelDownload.ts");
  let download: ReturnType<typeof useModelDownload> | undefined;
  function Harness() {
    download = useModelDownload({
      modelType: "llm",
      onDownloadComplete() {
        refreshes += 1;
      },
    });
    return null;
  }
  await renderer.render(Harness);

  let pending!: Promise<unknown>;
  await React.act(async () => {
    pending = download!.downloadModel("model-a");
  });
  // Main resolves with success only after the user has chosen another route.
  await React.act(async () => {
    request.resolve({ success: true });
    await pending;
  });
  assert.equal(refreshes, 1, "the inventory refresh runs exactly once");
  assert.equal(download!.isDownloading, false);
});

// Issue #182: a rejected download reports the error and does not select.
test("a rejected download reports the error and leaves selection untouched", async (t: import("node:test").TestContext) => {
  const renderer = await createDownloadRenderer(t, {
    onModelDownloadProgress: () => () => {},
    modelGetActiveDownloads: async () => [],
    modelDownload: async () => ({ success: false, error: "ENOTFOUND", code: "ENOTFOUND" }),
  });
  const { useModelDownload } = await renderer.vite.ssrLoadModule("/hooks/useModelDownload.ts");
  let download: ReturnType<typeof useModelDownload> | undefined;
  function Harness() {
    download = useModelDownload({ modelType: "llm" });
    return null;
  }
  await renderer.render(Harness);
  await React.act(async () => download!.downloadModel("model-a"));
  assert.equal(download!.downloadError, "hooks.modelDownload.errors.notFound");
  assert.equal(download!.isDownloading, false);
});

// Issue #182: unmounting during a download must not apply a late selection
// intent — there is none to apply, and the settled download must be a no-op.
test("unmounting before the download settles applies no stale selection", async (t: import("node:test").TestContext) => {
  const request = deferred();
  let refreshes = 0;
  const renderer = await createDownloadRenderer(t, {
    onModelDownloadProgress: () => () => {},
    modelGetActiveDownloads: async () => [],
    modelDownload: () => request.promise as Promise<unknown>,
  });
  const { useModelDownload } = await renderer.vite.ssrLoadModule("/hooks/useModelDownload.ts");
  function Harness() {
    useModelDownload({
      modelType: "llm",
      onDownloadComplete() {
        refreshes += 1;
      },
    });
    return null;
  }
  await renderer.render(Harness);
  await renderer.unmount();
  // The download completes after the surface is gone; resolving must not throw
  // and must not resurrect any selection.
  await React.act(async () => {
    request.resolve({ success: true });
    await Promise.resolve();
  });
  assert.equal(refreshes, 0, "an unmounted surface does not refresh");
});
