const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const Module = require("node:module");

const recoveryModulePath = require.resolve("../../src/helpers/micSelectionRecovery.ts");
const originalLoad = Module._load;
let currentSettings: unknown = null;

async function loadRecovery() {
  delete require.cache[recoveryModulePath];
  const settings = {
    setSelectedMicDevice(deviceId: string, label: string) {
      settings.saved = { deviceId, label };
    },
    saved: null as { deviceId: string; label: string } | null,
  };
  currentSettings = settings;
  Module._load = function loadWithMocks(request: string, parent: unknown, isMain: boolean) {
    if (request === "../stores/settingsStore" || request === "../stores/settingsStore.js") {
      return { getSettings: () => currentSettings };
    }
    if (request === "../utils/logger" || request === "../utils/logger.js") {
      return { info() {} };
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    const module = await import("../../src/helpers/micSelectionRecovery.ts");
    return { module, settings };
  } finally {
    Module._load = originalLoad;
  }
}

test("keeps explicit system/default preference semantics", async () => {
  const { module } = await loadRecovery();
  assert.equal(module.followsSystemDefaultMic({ microphoneSelectionMode: "system" }), true);
  assert.equal(module.followsSystemDefaultMic({ microphoneSelectionMode: "specific" }), false);
  assert.equal(module.followsSystemDefaultMic({ selectedMicDeviceId: "default" }), true);
  assert.equal(module.followsSystemDefaultMic({ preferBuiltInMic: true }), false);
});

test("remaps a rotated device ID only when its label is unique", async (t: import("node:test").TestContext) => {
  const { module, settings } = await loadRecovery();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        enumerateDevices: async () => [
          { kind: "audioinput", deviceId: "rotated", groupId: "g1", label: "USB Mic" },
        ],
      },
    },
  });

  const result = await module.reconcileSavedMicSelection("stale", "USB Mic");
  assert.deepEqual(result, { deviceId: "rotated", resolved: true, labelsAvailable: true });
  assert.deepEqual(settings.saved, { deviceId: "rotated", label: "USB Mic" });
});
