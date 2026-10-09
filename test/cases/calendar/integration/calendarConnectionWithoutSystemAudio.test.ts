import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { createRoot } from "react-dom/client";
import {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} from "../../../lib/rendererTestHarness.ts";

test("Settings connects each calendar without System Audio permission", async (t) => {
  let root: ReturnType<typeof createRoot> | undefined;
  t.after(async () => {
    const mountedRoot = root;
    if (mountedRoot) await React.act(async () => mountedRoot.unmount());
  });

  const calls: string[] = [];
  const buttons: Record<string, { onClick: () => void }> = {};
  const globals = globalThis as typeof globalThis & {
    __calendarConnectionButtons?: typeof buttons;
    __calendarConnectionStore?: Record<string, unknown>;
  };

  globals.__calendarConnectionButtons = buttons;
  globals.__calendarConnectionStore = {
    gcalAccounts: [],
    setGcalAccounts() {},
    gcalPrimaryOnly: true,
    setGcalPrimaryOnly() {},
    mcalAccounts: [],
    setMcalAccounts() {},
    mcalPrimaryOnly: true,
    setMcalPrimaryOnly() {},
    appleCalendarConnected: false,
    setAppleCalendarConnected() {},
  };
  t.after(() => {
    delete globals.__calendarConnectionButtons;
    delete globals.__calendarConnectionStore;
  });

  const noOpSubscription = () => () => {};
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPlatform: () => "darwin",
        checkSystemAudioAccess: async () => {
          calls.push("check-system-audio");

          return { granted: false, status: "denied", mode: "native" };
        },
        requestSystemAudioAccess: async () => {
          calls.push("request-system-audio");

          return { granted: false, status: "denied", mode: "native" };
        },
        gcalGetConnectionStatus: async () => ({ configured: true, sync: { state: "pending", requiresReconnect: false } }),
        mcalGetConnectionStatus: async () => ({ configured: true, sync: { state: "pending", requiresReconnect: false } }),
        acalGetConnectionStatus: async () => ({ connected: false, sourceNames: [] }),
        onGcalEventsSynced: noOpSubscription,
        onMcalEventsSynced: noOpSubscription,
        onGcalConnectionChanged: noOpSubscription,
        onMcalConnectionChanged: noOpSubscription,
        onAcalConnectionChanged: noOpSubscription,
        gcalStartOAuth: async () => {
          calls.push("google");

          return { success: false, error: "access_denied" };
        },
        mcalStartOAuth: async () => {
          calls.push("microsoft");

          return { success: false, error: "access_denied" };
        },
        acalConnect: async () => {
          calls.push("apple");

          return { success: true };
        },
      },
    },
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "gristmill-calendar-connection-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": 'export function useTranslation(){return {t:key=>key};}',
      "/stores/settingsStore":
        "export function useSettingsStore(){return globalThis.__calendarConnectionStore;} useSettingsStore.getState=()=>globalThis.__calendarConnectionStore;",
      "/stores/noteStore": "export function runInBackground(promise){void promise;}",
      "/ui/SettingsSection":
        'import React from "react"; export function SettingsPanel({children}){return React.createElement("div",null,children);} export const SettingsPanelRow=SettingsPanel; export const SettingsRow=SettingsPanel;',
      "/ui/button":
        'export function Button(props){const text=Array.isArray(props.children)?props.children.find(x=>typeof x==="string"):props.children;if(typeof text==="string")globalThis.__calendarConnectionButtons[text]=props;return null;}',
      "/ui/toggle": "export function Toggle(){return null;}",
      "/ui/dialog": "export function AlertDialog(){return null;} export function ConfirmDialog(){return null;}",
      "/ui/BidiInterpolatedText":
        'export const BIDI_VALUE_TOKEN="{email}"; export function BidiInterpolatedText(){return null;}',
      "@heroui/react": "export function Chip(){return null;}",
    },
  });

  const { default: IntegrationsView } = await vite.ssrLoadModule("/components/IntegrationsView.tsx");
  const container = installHookDom(t);
  root = createRoot(container as unknown as Element);
  await React.act(async () => {
    root!.render(React.createElement(IntegrationsView));
    await Promise.resolve();
  });

  for (const [label, provider] of [
    ["integrations.googleCalendar.connect", "google"],
    ["integrations.microsoftCalendar.connect", "microsoft"],
    ["integrations.appleCalendar.connect", "apple"],
  ]) {
    assert.ok(buttons[label], `${provider} connect button is available`);
    await React.act(async () => buttons[label].onClick());
  }

  assert.deepEqual(calls, ["google", "microsoft", "apple"]);
});
