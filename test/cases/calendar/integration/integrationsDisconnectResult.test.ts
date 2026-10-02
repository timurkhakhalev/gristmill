import test from "node:test";
import assert from "node:assert/strict";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { createRendererServer, installBrowserGlobals, installHookDom } from "../../../lib/rendererTestHarness.ts";

type UiNode = { props?: { children?: unknown; onClick?: () => unknown; [key: string]: unknown } };
function findUiNode(value: unknown, predicate: (node: UiNode) => boolean): UiNode | undefined {
  if (Array.isArray(value)) { for (const child of value) { const found = findUiNode(child, predicate); if (found) return found; } return; }
  if (!value || typeof value !== "object" || !("props" in value)) return;
  const node = value as UiNode;
  return predicate(node) ? node : findUiNode(node.props?.children, predicate);
}

const heroMock = `
  import React from "react";
  const capture = (name) => ({ children, onPress, onClick, ...rest }) => {
    if (onPress) rest.onClick = onPress;
    globalThis.__heroCapture(name, rest, children);
    return React.createElement(onPress || onClick ? "button" : "div", rest, children);
  };
  export const Button = capture("Button");
  export const Chip = ({ children }) => React.createElement("span", null, children);
  export const Switch = Object.assign(({ children }) => React.createElement("div", null, children), { Content: ({ children }) => React.createElement("div", null, children), Control: ({ children }) => React.createElement("div", null, children), Thumb: () => React.createElement("span", null) });
  export const Modal = Object.assign(({ isOpen, children }) => (isOpen ? React.createElement("div", null, children) : null), { Backdrop: ({ children }) => React.createElement("div", null, children), Container: ({ children }) => React.createElement("div", null, children), Dialog: ({ children }) => React.createElement("div", null, children), CloseTrigger: () => null, Heading: ({ children }) => React.createElement("h2", null, children) });
`;

interface HarnessApi {
  gcalDisconnect: (email?: string) => Promise<{ success: boolean; error?: string }>;
  mcalDisconnect: (email?: string) => Promise<{ success: boolean; error?: string }>;
  acalDisconnect: () => Promise<{ success: boolean; error?: string }>;
  [key: string]: unknown;
}

interface MountResult {
  clickDisconnect: (ariaLabel: string) => Promise<void>;
  text: () => string;
  store: {
    getState: () => {
      gcalAccounts: Array<{ email: string }>;
      mcalAccounts: Array<{ email: string }>;
      appleCalendarConnected: boolean;
    };
  };
}

async function mount(t: import("node:test").TestContext, api: HarnessApi): Promise<MountResult> {
  let root: ReturnType<typeof createRoot> | null = null;
  t.after(async () => { if (root) await act(async () => root!.unmount()); });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPlatform: () => "darwin",
        gcalGetConnectionStatus: async () => ({
          connected: true,
          configured: true,
          accounts: [{ email: "g@x.io" }],
          email: "g@x.io",
          peopleAccessMissing: [],
        }),
        mcalGetConnectionStatus: async () => ({ connected: true, configured: true, accounts: [{ email: "m@x.io" }] }),
        acalGetConnectionStatus: async () => ({ connected: true, sourceNames: ["iCloud"] }),
        onGcalConnectionChanged: () => () => {},
        onMcalConnectionChanged: () => () => {},
        onAcalConnectionChanged: () => () => {},
        ...api,
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "integrations-disconnect-result-",
    noExternal: ["@heroui/react"],
    mockModules: {
      "@heroui/react": heroMock,
      "react-i18next": `export const useTranslation = () => ({ t: (key: string) => key });`,
    },
  });
  const { useSettingsStore } = (await vite.ssrLoadModule("/stores/settingsStore.ts")) as typeof import("../../../../src/stores/settingsStore.js");
  await act(async () => {
    useSettingsStore.setState({
      gcalAccounts: [{ email: "g@x.io" }],
      mcalAccounts: [{ email: "m@x.io" }],
      appleCalendarConnected: true,
    });
  });
  const { default: IntegrationsView } = (await vite.ssrLoadModule("/components/IntegrationsView.tsx")) as { default: () => unknown };
  root = createRoot(container as unknown as Element);
  let tree: unknown;
  function Harness() { tree = IntegrationsView(); return tree as never; }
  await act(async () => { root!.render(createElement(Harness)); await Promise.resolve(); });
  return {
    text: () => container.textContent ?? "",
    clickDisconnect: async (ariaLabel: string) => {
      const button = findUiNode(tree, (node) => node.props?.["aria-label"] === ariaLabel);
      assert.ok(button, `disconnect button ${ariaLabel} rendered`);
      await act(async () => { await button.props!.onClick!(); });
    },
    store: useSettingsStore as unknown as MountResult["store"],
  };
}

test("a resolved google disconnect failure keeps the account and shows an error", async (t) => {
  const ui = await mount(t, {
    gcalDisconnect: async () => ({ success: false, error: "db locked" }),
    mcalDisconnect: async () => ({ success: true }),
    acalDisconnect: async () => ({ success: true }),
  });
  await ui.clickDisconnect("integrations.googleCalendar.disconnect");
  assert.deepEqual(ui.store.getState().gcalAccounts, [{ email: "g@x.io" }], "the account stays in the store");
  assert.match(ui.text(), /integrations\.disconnectFailed/, "the failure surfaces through the error dialog");
});

test("a thrown google disconnect failure keeps the account and shows an error", async (t) => {
  const ui = await mount(t, {
    gcalDisconnect: async () => { throw new Error("ipc gone"); },
    mcalDisconnect: async () => ({ success: true }),
    acalDisconnect: async () => ({ success: true }),
  });
  await ui.clickDisconnect("integrations.googleCalendar.disconnect");
  assert.deepEqual(ui.store.getState().gcalAccounts, [{ email: "g@x.io" }]);
  assert.match(ui.text(), /integrations\.disconnectFailed/);
});

test("a successful google disconnect removes the account without an error", async (t) => {
  const ui = await mount(t, {
    gcalDisconnect: async () => ({ success: true }),
    mcalDisconnect: async () => ({ success: true }),
    acalDisconnect: async () => ({ success: true }),
  });
  await ui.clickDisconnect("integrations.googleCalendar.disconnect");
  assert.deepEqual(ui.store.getState().gcalAccounts, []);
  assert.doesNotMatch(ui.text(), /integrations\.disconnectFailed/);
});

test("a resolved microsoft disconnect failure keeps the account and shows an error", async (t) => {
  const ui = await mount(t, {
    gcalDisconnect: async () => ({ success: true }),
    mcalDisconnect: async () => ({ success: false, error: "db locked" }),
    acalDisconnect: async () => ({ success: true }),
  });
  await ui.clickDisconnect("integrations.microsoftCalendar.disconnect");
  assert.deepEqual(ui.store.getState().mcalAccounts, [{ email: "m@x.io" }]);
  assert.match(ui.text(), /integrations\.disconnectFailed/);
});

test("a thrown microsoft disconnect failure keeps the account and shows an error", async (t) => {
  const ui = await mount(t, {
    gcalDisconnect: async () => ({ success: true }),
    mcalDisconnect: async () => { throw new Error("ipc gone"); },
    acalDisconnect: async () => ({ success: true }),
  });
  await ui.clickDisconnect("integrations.microsoftCalendar.disconnect");
  assert.deepEqual(ui.store.getState().mcalAccounts, [{ email: "m@x.io" }]);
  assert.match(ui.text(), /integrations\.disconnectFailed/);
});

test("a successful microsoft disconnect removes the account without an error", async (t) => {
  const ui = await mount(t, {
    gcalDisconnect: async () => ({ success: true }),
    mcalDisconnect: async () => ({ success: true }),
    acalDisconnect: async () => ({ success: true }),
  });
  await ui.clickDisconnect("integrations.microsoftCalendar.disconnect");
  assert.deepEqual(ui.store.getState().mcalAccounts, []);
  assert.doesNotMatch(ui.text(), /integrations\.disconnectFailed/);
});

test("a resolved apple disconnect failure keeps the connection and shows an error", async (t) => {
  const ui = await mount(t, {
    gcalDisconnect: async () => ({ success: true }),
    mcalDisconnect: async () => ({ success: true }),
    acalDisconnect: async () => ({ success: false, error: "db locked" }),
  });
  await ui.clickDisconnect("integrations.appleCalendar.disconnect");
  assert.equal(ui.store.getState().appleCalendarConnected, true);
  assert.match(ui.text(), /integrations\.disconnectFailed/);
});

test("a thrown apple disconnect failure keeps the connection and shows an error", async (t) => {
  const ui = await mount(t, {
    gcalDisconnect: async () => ({ success: true }),
    mcalDisconnect: async () => ({ success: true }),
    acalDisconnect: async () => { throw new Error("ipc gone"); },
  });
  await ui.clickDisconnect("integrations.appleCalendar.disconnect");
  assert.equal(ui.store.getState().appleCalendarConnected, true);
  assert.match(ui.text(), /integrations\.disconnectFailed/);
});

test("a successful apple disconnect clears the connection without an error", async (t) => {
  const ui = await mount(t, {
    gcalDisconnect: async () => ({ success: true }),
    mcalDisconnect: async () => ({ success: true }),
    acalDisconnect: async () => ({ success: true }),
  });
  await ui.clickDisconnect("integrations.appleCalendar.disconnect");
  assert.equal(ui.store.getState().appleCalendarConnected, false);
  assert.doesNotMatch(ui.text(), /integrations\.disconnectFailed/);
});
