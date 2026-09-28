const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const { localLlmChannels }: typeof import("../../src/contracts/localLlmModels.ts") = require("../../src/contracts/localLlmModels.ts");
const {
  registerLocalLlmModelHandlers,
} = require("../../src/helpers/localLlmModelIpcHandlers.ts");
const LocalModelDownloadStatus: typeof import("../../src/helpers/localModelDownloadStatus.ts").LocalModelDownloadStatus = require("../../src/helpers/localModelDownloadStatus.ts");

function createHarness(overrides: {
  modelManager?: Record<string, unknown>;
  llamaCppInstaller?: Record<string, unknown>;
  deps?: Record<string, unknown>;
} = {}) {
  const handlers = new Map<string, (...args: unknown[]) => any>();
  const sent: [string, any][] = [];
  const calls = { persist: 0, stopServer: 0 };
  const active = new Map<string, any>();

  const deps: unknown = {
    modelManager: {
      getModelsWithStatus: async () => [],
      isModelDownloaded: async () => false,
      downloadModel: async (modelId: string, onProgress: (progress: number, downloaded: number, total: number) => void) => {
        onProgress(50, 5, 10);
        return `/models/${modelId}.gguf`;
      },
      deleteModel: async () => {},
      deleteAllModels: async () => {},
      cancelDownload: () => false,
      ensureLlamaCpp: async () => true,
      findModelById: () => ({ model: { fileName: "model.gguf" }, provider: { id: "p" } }),
      modelsDir: "/models",
      serverStartOptions: async () => ({ contextSize: 4096, threads: 4, gpuLayers: 99 }),
      serverManager: { start: async () => {}, port: 8221 },
      currentServerModelId: null,
      stopServer: async () => {
        calls.stopServer += 1;
      },
      getServerStatus: () => ({
        available: false,
        running: false,
        port: null,
        modelPath: null,
        modelName: null,
        backend: null,
      }),
      ensureInitialized() {},
      ...overrides.modelManager,
    },
    llamaCppInstaller: {
      isInstalled: async () => false,
      install: async () => ({ success: false, message: "manual" }),
      uninstall: async () => ({ success: true }),
      ...overrides.llamaCppInstaller,
    },
    downloadStatus: {
      has: (type: string, id: unknown) => active.has(`${type}:${id}`),
      start: (type: string, id: unknown) => {
        active.set(`${type}:${id}`, true);
      },
      update: (type: string, id: unknown, updates: Record<string, unknown>) => {
        const current : any = { progress: 0, downloadedBytes: 0, totalBytes: 0, ...active.get(`${type}:${id}`), ...updates };
        active.set(`${type}:${id}`, current);
        return { modelType: type, modelId: id, phase: "downloading", sequence: 3, ...current };
      },
      finish: (type: string, id: unknown) => {
        if (!active.has(`${type}:${id}`)) return null;
        const current = active.get(`${type}:${id}`);
        active.delete(`${type}:${id}`);
        return { modelType: type, modelId: id, phase: "downloading", sequence: 7, ...current };
      },
      getActiveDownloads: () => [],
    },
    progressSender: { sendToControlPanel: (channel: string, payload: unknown) => sent.push([channel, payload]) },
    joinPath: (...segments: string[]) => segments.join("/"),
    persistEnvAfterServerStart: () => {
      calls.persist += 1;
    },
    logError: () => {},
    ...overrides.deps,
  };

  registerLocalLlmModelHandlers({ handle: (c: string, fn: (...args: unknown[]) => unknown) => handlers.set(c, fn) }, deps);
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler registered for ${channel}`);
    return handler({}, ...args);
  };
  return { handlers, invoke, sent, calls };
}

test("download success emits sequence-stamped progress then a complete event", async () => {
  const h = createHarness();
  const result = await h.invoke(localLlmChannels.modelDownload, "qwen");

  assert.deepEqual(result, { success: true, path: "/models/qwen.gguf" });
  assert.equal(h.sent.length, 2);
  const [channel, progress] = h.sent[0];
  assert.equal(channel, localLlmChannels.modelDownloadProgress);
  assert.deepEqual(progress, {
    modelId: "qwen",
    type: "progress",
    progress: 50,
    downloadedSize: 5,
    totalSize: 10,
    sequence: 3,
  });
  const [, complete] = h.sent[1];
  assert.equal(complete.type, "complete");
  assert.equal(complete.progress, 100);
  assert.equal(complete.sequence, 7);
});

test("download failure surfaces the manager error code and an error event", async () => {
  const h = createHarness({
    modelManager: {
      downloadModel: async () => {
        const err = Object.assign(new Error("connection lost"), { code: "NETWORK_ERROR" });
        throw err;
      },
    },
  });
  const result = await h.invoke(localLlmChannels.modelDownload, "qwen");

  assert.equal(result.success, false);
  assert.equal(result.code, "NETWORK_ERROR");
  const [, errorEvent] = h.sent[h.sent.length - 1];
  assert.equal(errorEvent.type, "error");
  assert.equal(errorEvent.code, "NETWORK_ERROR");
  assert.equal(errorEvent.sequence, 7);
});

test("a tracker-held download short-circuits before the manager", async () => {
  const h = createHarness({
    modelManager: {
      downloadModel: async () => {
        throw new Error("must not be called");
      },
    },
    deps: {
      downloadStatus: {
        has: () => true,
        start() {},
        update() {},
        finish: () => null,
        getActiveDownloads: () => [],
      },
    },
  });
  const result = await h.invoke(localLlmChannels.modelDownload, "qwen");
  assert.deepEqual(result.code, "DOWNLOAD_IN_PROGRESS");
  assert.equal(result.success, false);
  assert.equal(h.sent.length, 0);
});

test("a manager DOWNLOAD_IN_PROGRESS failure emits no error event", async () => {
  const h = createHarness({
    modelManager: {
      downloadModel: async () => {
        const err = Object.assign(new Error("already running"), { code: "DOWNLOAD_IN_PROGRESS" });
        throw err;
      },
    },
  });
  const result = await h.invoke(localLlmChannels.modelDownload, "qwen");
  assert.equal(result.code, "DOWNLOAD_IN_PROGRESS");
  assert.equal(h.sent.length, 0);
});

test("llama-cpp-check reports an installed binary without requiring a version API", async () => {
  const h = createHarness({ llamaCppInstaller: { isInstalled: async () => true } });
  const result = await h.invoke(localLlmChannels.llamaCppCheck);
  assert.deepEqual(result, { isInstalled: true, version: null });

  const absent = await createHarness().invoke(localLlmChannels.llamaCppCheck);
  assert.deepEqual(absent, { isInstalled: false, version: null });
});

test("llama-server start reports the port and persists env only on success", async () => {
  const h = createHarness();
  const result = await h.invoke(localLlmChannels.llamaServerStart, "qwen");
  assert.deepEqual(result, { success: true, port: 8221 });
  assert.equal(h.calls.persist, 1);

  const missing = createHarness({
    modelManager: { findModelById: () => null },
  });
  const failed = await missing.invoke(localLlmChannels.llamaServerStart, "nope");
  assert.equal(failed.success, false);
  assert.equal(missing.calls.persist, 0);
});

test("llama-server stop delegates to the manager", async () => {
  const h = createHarness();
  assert.deepEqual(await h.invoke(localLlmChannels.llamaServerStop), { success: true });
  assert.equal(h.calls.stopServer, 1);
});

test("model-check passes the raw id through to the manager", async () => {
  const h = createHarness({
    modelManager: { isModelDownloaded: async (modelId: unknown) => modelId === "qwen" },
  });
  assert.equal(await h.invoke(localLlmChannels.modelCheck, "qwen"), true);
  assert.equal(await h.invoke(localLlmChannels.modelCheck, "other"), false);
});

test("active downloads come straight from the tracker", async () => {
  const row = {
    modelType: "llm",
    modelId: "qwen",
    phase: "downloading",
    progress: 5,
    downloadedBytes: 5,
    totalBytes: 10,
    sequence: 2,
  };
  const h = createHarness({
    deps: {
      downloadStatus: {
        has: () => false,
        start() {},
        update() {},
        finish: () => null,
        getActiveDownloads: () => [row],
      },
    },
  });
  assert.deepEqual(await h.invoke(localLlmChannels.modelGetActiveDownloads), [row]);
});

// Pins the real registration against the real tracker class: the sequence
// handed to the renderer must come from the tracker, not the handler.
test("progress sequences come from the shared tracker", async () => {
  const status = new LocalModelDownloadStatus();
  const sent: { sequence: number }[] = [];
  const handlers = new Map<string, (...args: unknown[]) => any>();
  registerLocalLlmModelHandlers(
    { handle: (c: string, fn: (...args: unknown[]) => unknown) => handlers.set(c, fn) },
    {
      modelManager: {
        getModelsWithStatus: async () => [],
        isModelDownloaded: async () => false,
        downloadModel: async (modelId: string, onProgress: (progress: number, downloaded: number, total: number) => void) => {
          onProgress(10, 1, 10);
          return "/models/x.gguf";
        },
        deleteModel: async () => {},
        deleteAllModels: async () => {},
        cancelDownload: () => false,
        ensureLlamaCpp: async () => true,
        findModelById: () => null,
        modelsDir: "/models",
        serverStartOptions: async () => ({}),
        serverManager: { start: async () => {}, port: null },
        currentServerModelId: null,
        stopServer: async () => {},
        getServerStatus: () => ({}),
        ensureInitialized() {},
      },
      llamaCppInstaller: {},
      downloadStatus: status,
      progressSender: { sendToControlPanel: (channel: string, payload: any) => sent.push(payload) },
      joinPath: (...s: string[]) => s.join("/"),
      persistEnvAfterServerStart: () => {},
      logError: () => {},
    }
  );
  const download = handlers.get(localLlmChannels.modelDownload);
  if (!download) throw new Error("Download handler was not registered");
  const result = await download({}, "qwen");
  assert.equal(result.success, true);
  assert.ok(sent[0].sequence < sent[1].sequence);
  assert.equal(status.getActiveDownloads().length, 0);
});
