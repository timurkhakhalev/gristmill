const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("macOS accessibility checks follow the onboarding feature gate", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  let accessibilityChecks = 0;
  const requests = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPlatform: () => "darwin",
        checkAccessibilityPermission: async () => {
          accessibilityChecks += 1;
          return false;
        },
        checkMicrophoneAccess: async () => ({ granted: false }),
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

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const activeIntervals = new Set();
  let nextIntervalId = 1;
  globalThis.setInterval = () => {
    const id = nextIntervalId++;
    activeIntervals.add(id);
    return id;
  };
  globalThis.clearInterval = (id) => activeIntervals.delete(id);
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
        export function useTranslation() { return { t }; }
      `,
    },
  });
  const { usePermissions } = await vite.ssrLoadModule("/hooks/usePermissions.ts");

  let macAccessibilityChecksEnabled = false;
  let permissions;
  function Harness() {
    permissions = usePermissions(undefined, { macAccessibilityChecksEnabled });
    return null;
  }

  root = createRoot(container);
  const render = async () => {
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });
  };

  await render();
  assert.equal(accessibilityChecks, 0);
  assert.equal(activeIntervals.size, 0);
  await React.act(async () => { await permissions.requestAccessibilityPermission(); });
  assert.deepEqual(requests, ["prompt", "settings"], "register the app before opening Settings");

  macAccessibilityChecksEnabled = true;
  await render();
  assert.equal(accessibilityChecks, 2);
  assert.equal(activeIntervals.size, 1);

  macAccessibilityChecksEnabled = false;
  await render();
  assert.equal(accessibilityChecks, 2);
  assert.equal(activeIntervals.size, 0);
});
