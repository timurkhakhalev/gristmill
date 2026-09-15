const test = require("node:test");
const assert = require("node:assert/strict");

const { localModelChannels } = require("../../src/contracts/localModelLifecycle.ts");
const {
  registerLocalModelLifecycleHandlers,
} = require("../../src/helpers/localModelLifecycleIpcHandlers.ts");

function createHarness(overrides = {}) {
  const handlers = new Map();
  const sent = [];
  const calls = { persist: [], clear: 0, started: [], finished: [] };
  const active = new Map();

  const downloadStatus = {
    has: (modelType, modelId) => active.has(`${modelType}:${modelId}`),
    start: (modelType, modelId) => {
      calls.started.push(`${modelType}:${modelId}`);
      active.set(`${modelType}:${modelId}`, true);
    },
    finish: (modelType, modelId) => {
      const key = `${modelType}:${modelId}`;
      calls.finished.push(key);
      if (!active.has(key)) return null;
      active.delete(key);
      return { sequence: 7 };
    },
  };

  const deps = {
    whisperManager: {
      downloadWhisperModel: async (modelName, onProgress) => {
        onProgress({ type: "progress", model: modelName, percentage: 10 });
        return { success: true, model: modelName };
      },
      ...overrides.whisperManager,
    },
    parakeetManager: {
      downloadParakeetModel: async () => ({ success: true }),
      startServer: async () => ({ success: true, port: 9000 }),
      stopServer: async () => ({ success: true }),
      ...overrides.parakeetManager,
    },
    downloadStatus,
    progressSender: { sendToControlPanel: (channel, payload) => sent.push([channel, payload]) },
    updateDownloadStatus: () => ({ sequence: 3 }),
    getWhisperVadSettings: () => ({ threshold: -22 }),
    setWhisperVadSettings: (payload) => payload,
    persistParakeetProviderSelection: async (modelName) => {
      calls.persist.push(modelName);
    },
    clearParakeetProviderSelection: async () => {
      calls.clear += 1;
    },
    ...overrides.deps,
  };

  registerLocalModelLifecycleHandlers({ handle: (c, fn) => handlers.set(c, fn) }, deps);
  const invoke = (channel, ...args) => handlers.get(channel)({}, ...args);
  return { handlers, invoke, sent, calls };
}

test("download success emits sequence-stamped progress then a complete event", async () => {
  const h = createHarness();
  const result = await h.invoke(localModelChannels.downloadWhisperModel, "base.en");

  assert.deepEqual(result, { success: true, model: "base.en" });
  assert.equal(h.sent.length, 2);
  const [progressChannel, progress] = h.sent[0];
  assert.equal(progressChannel, localModelChannels.whisperDownloadProgress);
  assert.deepEqual(progress, { type: "progress", model: "base.en", percentage: 10, sequence: 3 });
  const [, complete] = h.sent[1];
  assert.equal(complete.type, "complete");
  assert.equal(complete.percentage, 100);
  assert.equal(complete.sequence, 7);
});

test("download failure emits an error event with the manager error code", async () => {
  const h = createHarness({
    whisperManager: {
      downloadWhisperModel: async () => {
        const err = new Error("disk full");
        err.code = "DOWNLOAD_FAILED";
        throw err;
      },
    },
  });
  const result = await h.invoke(localModelChannels.downloadWhisperModel, "base.en");

  assert.deepEqual(result, {
    success: false,
    error: "disk full",
    code: "DOWNLOAD_FAILED",
  });
  const [, errorEvent] = h.sent[h.sent.length - 1];
  assert.equal(errorEvent.type, "error");
  assert.equal(errorEvent.error, "disk full");
  assert.equal(errorEvent.code, "DOWNLOAD_FAILED");
  assert.equal(errorEvent.sequence, 7);
});

test("a concurrent download (DOWNLOAD_IN_PROGRESS) keeps the tracker and emits nothing", async () => {
  const h = createHarness({
    whisperManager: {
      downloadWhisperModel: async () => {
        const err = new Error("already running");
        err.code = "DOWNLOAD_IN_PROGRESS";
        throw err;
      },
    },
  });

  const result = await h.invoke(localModelChannels.downloadWhisperModel, "base.en");

  assert.deepEqual(result, {
    success: false,
    error: "already running",
    code: "DOWNLOAD_IN_PROGRESS",
  });
  assert.equal(h.sent.length, 0);
});

test("parakeet server start persists the provider selection only on success", async () => {
  const h = createHarness({
    parakeetManager: { startServer: async () => ({ success: false, reason: "no binary" }) },
  });
  const failed = await h.invoke(localModelChannels.parakeetServerStart, "parakeet-mlx");
  assert.equal(failed.success, false);
  assert.equal(h.calls.persist.length, 0);
});

test("parakeet server stop clears the persisted provider selection", async () => {
  const h = createHarness();
  await h.invoke(localModelChannels.parakeetServerStop);
  assert.equal(h.calls.clear, 1);
});

test("invalid model names are rejected before reaching the manager", async () => {
  const h = createHarness({
    parakeetManager: {
      downloadParakeetModel: async () => {
        throw new Error("must not be called");
      },
    },
  });
  const result = await h.invoke(localModelChannels.downloadParakeetModel, "");
  assert.equal(result.success, false);
  assert.equal(result.error, "Invalid model name");
});

test("VAD config set rejects invalid payloads without touching settings", async () => {
  const h = createHarness();
  const result = await h.invoke(localModelChannels.whisperVadSetConfig, {
    threshold: "not-a-number",
  });
  assert.equal(result.success, false);
  assert.equal(result.error, "Invalid VAD configuration");
});
