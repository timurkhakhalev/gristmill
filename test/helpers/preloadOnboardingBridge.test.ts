const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");
const vm: typeof import("node:vm") = require("node:vm");

function loadPreloadApi() {
  let exposedApi: { setOnboardingActive(active: boolean): Promise<unknown>; markMacAccessibilityFeaturesReady?: unknown } | undefined;
  const invocations: unknown[] = [];
  const sends: unknown[] = [];
  const listeners = new Map();
  const ipcRenderer = {
    invoke: async (channel: string, ...args: unknown[]) => {
      invocations.push([channel, ...args]);
      return true;
    },
    on: (channel: string, listener: unknown) => listeners.set(channel, listener),
    removeListener: (channel: string, listener: unknown) => {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
    send: (channel: string, ...args: unknown[]) => sends.push([channel, ...args]),
    sendSync: () => undefined,
  };
  const electron = {
    contextBridge: {
      exposeInMainWorld: (_name: string, api: typeof exposedApi) => {
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
    require: (specifier: unknown) => {
      if (specifier === "electron") return electron;
      throw new Error(`Unexpected preload dependency: ${specifier}`);
    },
    process,
  });
  assert.ok(exposedApi, "preload must expose its API");
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
