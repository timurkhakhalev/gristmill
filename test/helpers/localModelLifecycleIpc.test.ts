const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const { localModelChannels }: typeof import("../../src/contracts/localModelLifecycle.ts") = require("../../src/contracts/localModelLifecycle.ts");
const {
  registerLocalModelLifecycleHandlers,
} = require("../../src/helpers/localModelLifecycleIpcHandlers.ts");
const { sanitizeWhisperVadConfig }: typeof import("../../src/helpers/whisperVadConfig.ts") = require("../../src/helpers/whisperVadConfig.ts");
const vadDefaults = require("../../src/constants/whisperVad.json").DEFAULTS;

// Mirrors the production settings owner in ipcHandlers.js: allowed-key filter
// on write, sanitize/clamp on read, so set() can never surface raw garbage.
function createVadSettingsStore() {
  const allowedKeys = new Set([
    "noteRecordingSileroEnabled",
    "meetingSileroEnabled",
    ...Object.keys(vadDefaults),
  ]);
  let settings : any = {};
  return {
    get() {
      return {
        noteRecordingSileroEnabled: settings.noteRecordingSileroEnabled !== false,
        meetingSileroEnabled: settings.meetingSileroEnabled !== false,
        ...sanitizeWhisperVadConfig(settings),
      };
    },
    set(update = {}) {
      const filtered: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(update)) {
        if (allowedKeys.has(k)) filtered[k] = v;
      }
      settings = { ...this.get(), ...filtered };
      return this.get();
    },
  };
}

function createHarness(overrides: {
  vadStore?: ReturnType<typeof createVadSettingsStore>;
  whisperManager?: Record<string, unknown>;
  parakeetManager?: Record<string, unknown>;
  deps?: Record<string, unknown>;
} = {}) {
  const handlers = new Map<string, (...args: unknown[]) => any>();
  const sent: [string, any][] = [];
  const calls : any = { persist: [], clear: 0, started: [], finished: [] };
  const active = new Map();

  const downloadStatus: unknown = {
    has: (modelType: string, modelId: string) => active.has(`${modelType}:${modelId}`),
    start: (modelType: string, modelId: string) => {
      calls.started.push(`${modelType}:${modelId}`);
      active.set(`${modelType}:${modelId}`, true);
    },
    finish: (modelType: string, modelId: string) => {
      const key = `${modelType}:${modelId}`;
      calls.finished.push(key);
      if (!active.has(key)) return null;
      active.delete(key);
      return { sequence: 7 };
    },
  };

  const vadStore = overrides.vadStore || createVadSettingsStore();

  const deps: unknown = {
    whisperManager: {
      downloadWhisperModel: async (modelName: string, onProgress: (event: { type: string; model: string; percentage: number }) => void) => {
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
    progressSender: { sendToControlPanel: (channel: string, payload: unknown) => sent.push([channel, payload]) },
    updateDownloadStatus: () => ({ sequence: 3 }),
    getWhisperVadSettings: () => vadStore.get(),
    setWhisperVadSettings: (payload: any) => vadStore.set(payload),
    persistParakeetProviderSelection: async (modelName: unknown) => {
      calls.persist.push(modelName);
    },
    clearParakeetProviderSelection: async () => {
      calls.clear += 1;
    },
    ...overrides.deps,
  };

  registerLocalModelLifecycleHandlers({ handle: (c: string, fn: (...args: unknown[]) => unknown) => handlers.set(c, fn) }, deps);
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler registered for ${channel}`);
    return handler({}, ...args);
  };
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
        const err = Object.assign(new Error("disk full"), { code: "DOWNLOAD_FAILED" });
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
        const err = Object.assign(new Error("already running"), { code: "DOWNLOAD_IN_PROGRESS" });
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

test("VAD config set never rejects: garbage is filtered/clamped into a valid config", async () => {
  const h = createHarness();
  const result = await h.invoke(localModelChannels.whisperVadSetConfig, {
    threshold: "not-a-number",
    unknownKey: "dropped",
  });

  // Pre-cutover contract: set always succeeds; the settings owner filters
  // unknown keys on write and the returned config is the clamped read-back.
  assert.equal(result.success, true);
  assert.equal(result.config.unknownKey, undefined);
  assert.equal(typeof result.config.threshold, "number");
  assert.ok(result.config.threshold >= 0.1 && result.config.threshold <= 0.95);

  // The read channel mirrors the same sanitized view.
  const read = await h.invoke(localModelChannels.whisperVadGetConfig);
  assert.equal(read.success, true);
  assert.equal(read.config.threshold, result.config.threshold);
});

test("VAD config set without a payload merges onto defaults", async () => {
  const h = createHarness();
  const result = await h.invoke(localModelChannels.whisperVadSetConfig);
  assert.equal(result.success, true);
  assert.equal(result.config.noteRecordingSileroEnabled, true);
  assert.equal(result.config.meetingSileroEnabled, true);
});
