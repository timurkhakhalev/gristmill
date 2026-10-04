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
  let accessibilityGranted = false;
  const requests: string[] = [];
  let micStatus = "not-determined";
  const focusListeners: Array<() => void> = [];
  const onFocus = () => focusListeners.forEach((listener) => listener());
  installBrowserGlobals(t, {
    window: {
      addEventListener: (name: string, listener: () => void) => {
        if (name === "focus") focusListeners.push(listener);
      },
      electronAPI: {
        getPlatform: () => "darwin",
        checkAccessibilityPermission: async () => {
          accessibilityChecks += 1;
          return accessibilityGranted;
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
  const activeIntervals = new Map<number, () => void>();
  let nextIntervalId = 1;
  globalThis.setInterval = ((_handler: Parameters<typeof globalThis.setInterval>[0]) => {
    const id = nextIntervalId++;
    if (typeof _handler === "function") activeIntervals.set(id, _handler as () => void);
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
  assert.deepEqual(requests, ["prompt", "settings"], "Settings opens even if macOS suppresses the prompt");
  assert.equal(permissions!.accessibilityTroubleshooting, true);
  assert.equal(permissions!.accessibilityPromptRequested, true);
  await React.act(async () => { await permissions!.requestAccessibilityPermission(); });
  assert.deepEqual(requests, ["prompt", "settings", "settings"], "a later click opens Settings directly");
  assert.equal(permissions!.accessibilityTroubleshooting, true);

  await React.act(async () => { await permissions!.requestMicPermission(); });
  assert.equal(permissions!.micPermissionGranted, true);
  assert.deepEqual(requests, ["prompt", "settings", "settings", "mic prompt"]);
  micStatus = "denied";
  await React.act(async () => { onFocus?.(); await Promise.resolve(); });
  assert.equal(permissions!.micPermissionGranted, false);
  await React.act(async () => { await permissions!.requestMicPermission(); });
  assert.deepEqual(requests, ["prompt", "settings", "settings", "mic prompt", "mic settings"]);

  macAccessibilityChecksEnabled = true;
  await render();
  assert.equal(accessibilityChecks, 3);
  assert.equal(activeIntervals.size, 1);

  // Granting in macOS Settings must update the onboarding row without another
  // prompt or a restart, and stop polling once the permission is confirmed.
  accessibilityGranted = true;
  await React.act(async () => {
    activeIntervals.values().next().value!();
    await Promise.resolve();
  });
  assert.equal(permissions!.accessibilityPermissionGranted, true);
  assert.equal(permissions!.accessibilityTroubleshooting, false);
  assert.equal(activeIntervals.size, 0);
  assert.equal(accessibilityChecks, 4);
  assert.equal(requests.filter((request) => request === "prompt").length, 1);

  macAccessibilityChecksEnabled = false;
  await render();
  assert.equal(accessibilityChecks, 4);
  assert.equal(activeIntervals.size, 0);
});

// Issue #179: an Accessibility grant can be revoked in System Settings while
// the screen stays open. A window focus must re-check (like mic), flipping
// the stored granted state back to missing — without ever prompting.
test("focus re-checks a revoked Accessibility permission without prompting", async (t: import("node:test").TestContext) => {
  let root: ReturnType<typeof createRoot> | null = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  let accessibilityGranted = true;
  const requests: string[] = [];
  const focusListeners: Array<() => void> = [];
  const onFocus = () => focusListeners.forEach((listener) => listener());
  installBrowserGlobals(t, {
    window: {
      addEventListener: (name: string, listener: () => void) => {
        if (name === "focus") focusListeners.push(listener);
      },
      electronAPI: {
        getPlatform: () => "darwin",
        checkAccessibilityPermission: async (prompt?: boolean) => {
          if (prompt) requests.push("check(prompt)");
          return accessibilityGranted;
        },
        checkMicrophoneAccess: async () => ({ granted: true, status: "granted" }),
        promptAccessibilityPermission: async () => { requests.push("prompt"); return false; },
        openAccessibilitySettings: async () => { requests.push("settings"); return { success: true }; },
      },
    },
  });
  const container = installHookDom(t);

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-permissions-accessibility-revoke-",
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

  let permissions: ReturnType<typeof usePermissionsApi> | undefined;
  function Harness() {
    permissions = usePermissionsApi();
    return null;
  }
  root = createRoot(container as unknown as Element);
  await React.act(async () => {
    root!.render(React.createElement(Harness));
    await Promise.resolve();
  });

  // Granted at mount; no prompt was ever requested.
  assert.equal(permissions!.accessibilityPermissionGranted, true);
  assert.deepEqual(requests, ["check(prompt)"]);

  // Revoked in System Settings while the screen stayed open: returning to the
  // window (focus) re-checks and flips the state back to missing.
  accessibilityGranted = false;
  await React.act(async () => { onFocus(); await Promise.resolve(); });
  assert.equal(permissions!.accessibilityPermissionGranted, false, "the revocation is picked up on focus");
  assert.deepEqual(requests, ["check(prompt)", "check(prompt)"], "only re-checks ran — no prompt, no Settings");

  // Re-granting is picked up the same way.
  accessibilityGranted = true;
  await React.act(async () => { onFocus(); await Promise.resolve(); });
  assert.equal(permissions!.accessibilityPermissionGranted, true);
  assert.deepEqual(requests, ["check(prompt)", "check(prompt)", "check(prompt)"]);
});

// The gate still protects the focus re-check: with macAccessibilityChecks
// disabled (closed onboarding gate), a focus fires no protected check.
test("focus re-check respects the macAccessibilityChecksEnabled gate", async (t: import("node:test").TestContext) => {
  let root: ReturnType<typeof createRoot> | null = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  let accessibilityChecks = 0;
  const focusListeners: Array<() => void> = [];
  const onFocus = () => focusListeners.forEach((listener) => listener());
  installBrowserGlobals(t, {
    window: {
      addEventListener: (name: string, listener: () => void) => {
        if (name === "focus") focusListeners.push(listener);
      },
      electronAPI: {
        getPlatform: () => "darwin",
        checkAccessibilityPermission: async () => {
          accessibilityChecks += 1;
          return false;
        },
        checkMicrophoneAccess: async () => ({ granted: false, status: "denied" }),
      },
    },
  });
  const container = installHookDom(t);

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-permissions-accessibility-gate-focus-",
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
  function Harness() {
    usePermissionsApi(undefined, { macAccessibilityChecksEnabled });
    return null;
  }
  root = createRoot(container as unknown as Element);
  await React.act(async () => {
    root!.render(React.createElement(Harness));
    await Promise.resolve();
  });

  await React.act(async () => { onFocus(); await Promise.resolve(); });
  assert.equal(accessibilityChecks, 0, "the closed gate keeps focus from touching the protected check");
});
