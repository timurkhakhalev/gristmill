const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const test: typeof import("node:test") = require("node:test");

const React = require("react") as typeof import("react");

const { createRoot } = require("react-dom/client");

const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
}: typeof import("../../../lib/rendererTestHarness.ts") = require("../../../lib/rendererTestHarness.ts");

test("system audio prompts once, then opens Settings and rechecks on return", async (t: import("node:test").TestContext) => {
  let root: ReturnType<typeof createRoot> | null = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const calls: string[] = [];
  let onFocus: (() => void) | undefined;
  let granted = false;
  installBrowserGlobals(t, {
    window: {
      addEventListener: (name: string, listener: () => void) => {
        if (name === "focus") onFocus = listener;
      },
      electronAPI: {
        checkSystemAudioAccess: async () => {
          calls.push("check");

          return { granted: false, status: "unknown", mode: "native" };
        },
        requestSystemAudioAccess: async () => {
          calls.push("request");

          return { granted, status: granted ? "granted" : "denied", mode: "native" };
        },
        openSystemAudioSettings: async () => {
          calls.push("settings");

          return { success: true };
        },
      },
    },
  });
  const container = installHookDom(t);

  const vite = await createRendererServer(t, {
    cachePrefix: "gristmill-system-audio-permission-",
    mockModules: {
      "/utils/platform": `export function getCachedPlatform() { return "darwin"; }`,
    },
  });

  const { useSystemAudioPermission } = (await vite.ssrLoadModule(
    "/hooks/useSystemAudioPermission.ts"
  )) as typeof import("../../../../src/hooks/useSystemAudioPermission.ts");

  let permission: ReturnType<typeof useSystemAudioPermission> | undefined;

  function Harness() {
    permission = useSystemAudioPermission();

    return null;
  }

  root = createRoot(container as unknown as Element);
  await React.act(async () => {
    root.render(React.createElement(Harness));
    await Promise.resolve();
  });
  assert.deepEqual(calls, ["check"]);

  await React.act(async () => {
    await permission!.request();
  });
  assert.deepEqual(
    calls,
    ["check", "request"],
    "the native prompt must not be covered by Settings"
  );
  assert.equal(permission!.status, "denied");

  await React.act(async () => {
    await permission!.request();
  });
  assert.deepEqual(calls, ["check", "request", "request", "settings"]);

  granted = true;
  await React.act(async () => {
    onFocus?.();
    await Promise.resolve();
  });
  assert.deepEqual(calls, ["check", "request", "request", "settings", "request"]);
  assert.equal(permission!.granted, true);
});
