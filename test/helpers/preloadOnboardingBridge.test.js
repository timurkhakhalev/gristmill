const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadPreloadApi() {
  let exposedApi;
  const invocations = [];
  const sends = [];
  const listeners = new Map();
  const ipcRenderer = {
    invoke: async (channel, ...args) => {
      invocations.push([channel, ...args]);
      return true;
    },
    on: (channel, listener) => listeners.set(channel, listener),
    removeListener: (channel, listener) => {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
    send: (channel, ...args) => sends.push([channel, ...args]),
    sendSync: () => undefined,
  };
  const electron = {
    contextBridge: {
      exposeInMainWorld: (_name, api) => {
        exposedApi = api;
      },
    },
    ipcRenderer,
    webUtils: {},
  };
  const source = fs.readFileSync(path.join(__dirname, "../../dist-main/preload.js"), "utf8");
  vm.runInNewContext(source, {
    // The bundle keeps CJS interop for hybrid manifest modules, so the
    // sandbox needs the same bindings Node's CJS loader provides.
    module: { exports: {} },
    exports: {},
    require: (specifier) => {
      if (specifier === "electron") return electron;
      throw new Error(`Unexpected preload dependency: ${specifier}`);
    },
    process,
  });
  return { api: exposedApi, invocations, listeners, sends };
}

test("onboarding active bridge invokes only its allowlisted channel", async () => {
  const { api, invocations } = loadPreloadApi();

  await api.setOnboardingActive(true);
  await api.setOnboardingActive(false);

  assert.deepEqual(invocations, [
    ["onboarding-set-active", true],
    ["onboarding-set-active", false],
  ]);
});

test("removed assistant readiness does not expose a dead IPC channel", () => {
  const { api } = loadPreloadApi();
  assert.equal(api.markMacAccessibilityFeaturesReady, undefined);
});
