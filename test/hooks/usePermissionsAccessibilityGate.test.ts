const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test") = require("node:test");
const React = require("react") as typeof import("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
  installMicCaptureGlobals,
}: typeof import("../lib/rendererTestHarness.ts") = require("../lib/rendererTestHarness.ts");

test("macOS accessibility checks follow the onboarding feature gate", async (t: import("node:test").TestContext) => {
  let root: ReturnType<typeof createRoot> | null = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  let accessibilityChecks = 0;
  const requests: string[] = [];
  let micStatus = "not-determined";
  let onFocus: (() => void) | undefined;
  installBrowserGlobals(t, {
    window: {
      addEventListener: (name: string, listener: () => void) => {
        if (name === "focus") onFocus = listener;
      },
      electronAPI: {
        getPlatform: () => "darwin",
        checkAccessibilityPermission: async () => {
          accessibilityChecks += 1;
          return false;
        },
        checkMicrophoneAccess: async () => ({ granted: micStatus === "granted", status: micStatus }),
        requestMicrophoneAccess: async () => { requests.push("mic prompt"); return { granted: true }; },
        openMicrophoneSettings: async () => { requests.push("mic settings"); return { success: true }; },
        promptAccessibilityPermission: async () => { requests.push("prompt"); return false; },
        openAccessibilitySettings: async () => { requests.push("settings"); return { success: true }; },
        checkPasteTools: async () => ({
          platform: "darwin",
          available: true,
          method: "cgevent",
          requiresPermission: true,
          tools: [],
        }),
      },
    },
  });
  const container = installHookDom(t);
  installMicCaptureGlobals(t);

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const activeIntervals = new Set<number>();
  let nextIntervalId = 1;
  globalThis.setInterval = ((_handler: Parameters<typeof globalThis.setInterval>[0]) => {
    const id = nextIntervalId++;
    activeIntervals.add(id);
    return id;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((id?: number) => {
    activeIntervals.delete(id as number);
  }) as typeof globalThis.clearInterval;
  t.after(() => {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-permissions-accessibility-gate-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export const initReactI18next = { type: "3rdParty", init() {} };
        export function useTranslation() { return { t }; }
      `,
    },
  });
  const { usePermissions: usePermissionsApi } = (await vite.ssrLoadModule("/hooks/usePermissions.ts") as typeof import("../../src/hooks/usePermissions.ts"));

  let macAccessibilityChecksEnabled = false;
  let permissions: ReturnType<typeof usePermissionsApi> | undefined;
  function Harness() {
    permissions = usePermissionsApi(undefined, { macAccessibilityChecksEnabled });
    return null;
  }

  root = createRoot(container as unknown as Element);
  const render = async () => {
    await React.act(async () => {
      root!.render(React.createElement(Harness));
      await Promise.resolve();
    });
  };

  await render();
  assert.equal(accessibilityChecks, 0);
  assert.equal(activeIntervals.size, 0);
  assert.equal(permissions!.accessibilityTroubleshooting, false);
  await React.act(async () => { await permissions!.requestAccessibilityPermission(); });
  assert.deepEqual(requests, ["prompt"], "the native prompt opens Settings itself");
  assert.equal(permissions!.accessibilityTroubleshooting, true);
  assert.equal(permissions!.accessibilityPromptRequested, true);
  await React.act(async () => { await permissions!.requestAccessibilityPermission(); });
  assert.deepEqual(requests, ["prompt", "settings"], "a later click opens Settings directly");
  assert.equal(permissions!.accessibilityTroubleshooting, true);

  await React.act(async () => { await permissions!.requestMicPermission(); });
  assert.equal(permissions!.micPermissionGranted, true);
  assert.deepEqual(requests, ["prompt", "settings", "mic prompt"]);
  micStatus = "denied";
  await React.act(async () => { onFocus?.(); await Promise.resolve(); });
  assert.equal(permissions!.micPermissionGranted, false);
  await React.act(async () => { await permissions!.requestMicPermission(); });
  assert.deepEqual(requests, ["prompt", "settings", "mic prompt", "mic settings"]);

  macAccessibilityChecksEnabled = true;
  await render();
  assert.equal(accessibilityChecks, 3);
  assert.equal(activeIntervals.size, 1);

  macAccessibilityChecksEnabled = false;
  await render();
  assert.equal(accessibilityChecks, 3);
  assert.equal(activeIntervals.size, 0);
});
