import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { createRoot } from "react-dom/client";
import type { CalendarSyncStatus } from "../../../../src/contracts/calendar.ts";
import { createRendererServer, installBrowserGlobals, installHookDom } from "../../../lib/rendererTestHarness.ts";

test("failed calendar sync replaces Connected and warns on Home until successful recovery", async (t) => {
  const buttons: Record<string, { onClick: () => void }> = {};
  const globals = globalThis as typeof globalThis & {
    __calendarConnectionButtons?: typeof buttons;
    __calendarConnectionStore?: Record<string, unknown>;
  };
  globals.__calendarConnectionButtons = buttons;
  globals.__calendarConnectionStore = {
    gcalAccounts: [{ email: "test@example.com" }], mcalAccounts: [],
    gcalPrimaryOnly: true, mcalPrimaryOnly: true, appleCalendarConnected: false,
    setGcalAccounts(accounts: Array<{ email: string }>) { globals.__calendarConnectionStore!.gcalAccounts = accounts; },
    setMcalAccounts(accounts: Array<{ email: string }>) { globals.__calendarConnectionStore!.mcalAccounts = accounts; },
    setGcalPrimaryOnly() {},
    setMcalPrimaryOnly() {}, setAppleCalendarConnected() {},
  };
  t.after(() => {
    delete globals.__calendarConnectionButtons;
    delete globals.__calendarConnectionStore;
  });
  let connected = true;
  let sync: CalendarSyncStatus = { state: "pending", requiresReconnect: false };
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const subscribe = (callback: () => void) => {
    listeners.add(callback);
    return () => { listeners.delete(callback); };
  };
  const emitSync = () => listeners.forEach((callback) => callback());
  const noopSubscription = () => () => {};
  installBrowserGlobals(t, { window: { electronAPI: {
    getPlatform: () => "linux",
    gcalGetConnectionStatus: async () => ({ connected, configured: connected, sync,
      accounts: connected ? [{ email: "test@example.com" }] : [], peopleAccessMissing: connected ? ["test@example.com"] : [] }),
    mcalGetConnectionStatus: async () => ({ connected: false, configured: false,
      accounts: [], sync: { state: "pending", requiresReconnect: false } }),
    gcalGetUpcomingEvents: async () => ({ success: true, events: [] }),
    onGcalEventsSynced: subscribe, onGcalConnectionChanged: noopSubscription,
    onMcalEventsSynced: noopSubscription, onMcalConnectionChanged: noopSubscription,
    onAcalEventsSynced: noopSubscription,
    gcalStartOAuth: async () => {
      calls.push("reconnect");
      sync = { state: "synced", requiresReconnect: false };
      emitSync();
      return { success: true, email: "test@example.com" };
    },
    gcalSyncEvents: async () => {
      calls.push("retry");
      sync = { state: "synced", requiresReconnect: false };
      emitSync();
      return { success: true };
    },
  } } });
  const vite = await createRendererServer(t, {
    cachePrefix: "gristmill-calendar-sync-",
    noExternal: ["react-i18next"],
    mockModules: {
      "/hooks/useSystemAudioPermission": 'export function useSystemAudioPermission(){return {granted:true,mode:"native"};}',
      "/hooks/useUiLocale": 'export function useUiLocale(){return "en-US";}',
      "/hooks/useDateTimePreferences": 'export function useDateTimePreferences(){return {timeFormat:"24h"};}',
      "/ui/EmptyStateCard": 'export default function EmptyStateCard(){return null;}',
      "/ui/PersonAvatar": 'export default function PersonAvatar(){return null;}',
      "/ui/PersonName": 'export default function PersonName(){return null;}',
      "/ui/popover": 'export function Popover(){return null;} export const PopoverContent=Popover; export const PopoverTrigger=Popover;',
      "/ui/Skeleton": 'export const CONTENT_ENTER_CLASS="";',
      "HomeSkeleton": 'export function ComingUpSkeleton(){return null;}',

      "react-i18next": 'export function useTranslation(){return {t:key=>key};}',
      "/stores/settingsStore":
        "export function useSettingsStore(selector){const store=globalThis.__calendarConnectionStore;return selector?selector(store):store;} useSettingsStore.getState=()=>globalThis.__calendarConnectionStore;",
      "/stores/noteStore": "export function runInBackground(promise){void promise;}",
      "/ui/SettingsSection":
        'import React from "react"; export function SettingsPanel({children}){return React.createElement("div",null,children);} export const SettingsPanelRow=SettingsPanel; export const SettingsRow=SettingsPanel;',
      "/ui/button":
        'import React from "react"; export function Button(props){const text=Array.isArray(props.children)?props.children.find(x=>typeof x==="string"):props.children;if(typeof text==="string")globalThis.__calendarConnectionButtons[text]=props;return React.createElement("button",null,props.children);}',
      "/ui/toggle": "export function Toggle(){return null;}",
      "/ui/dialog": "export function AlertDialog(){return null;} export function ConfirmDialog(){return null;}",
      "/ui/BidiInterpolatedText":
        'export const BIDI_VALUE_TOKEN="{email}"; export function BidiInterpolatedText(){return React.createElement("button",null,props.children);}',
      "@heroui/react": 'import React from "react"; export function Chip({children}){return React.createElement("span",null,children);}',
    },
  });

  const { default: IntegrationsView } = await vite.ssrLoadModule("/components/IntegrationsView.tsx");
  const { default: ComingUp } = await vite.ssrLoadModule("/components/home/ComingUp.tsx");
  const { useUpcomingEvents } = await vite.ssrLoadModule("/hooks/useUpcomingEvents.ts");
  let settingsOpened = 0;
  function HomeCalendar() {
    const upcoming = useUpcomingEvents();
    return React.createElement(ComingUp, { ...upcoming, onOpenEvent() {}, onConnectCalendar() { settingsOpened++; } });
  }
  const container = installHookDom(t);
  const root = createRoot(container as unknown as Element);
  t.after(async () => { await React.act(async () => root.unmount()); });
  await React.act(async () => root.render(React.createElement(React.Fragment, null,
    React.createElement(IntegrationsView), React.createElement(HomeCalendar))));
  assert.match(container.textContent, /integrations.sync.checking/);
  const hasSpinner = (node: typeof container): boolean =>
    String(node.attributes.get("class") ?? "").includes("animate-spin") || node.childNodes.some(hasSpinner);
  assert.ok(hasSpinner(container), "pending sync displays an animated loader");
  sync = { state: "error", requiresReconnect: true };
  await React.act(async () => emitSync());
  assert.match(container.textContent, /integrations.sync.reconnectRequired/);
  assert.doesNotMatch(container.textContent, /integrations.googleCalendar.connected/);
  assert.equal(container.textContent.split("integrations.sync.outOfSyncTitle").length - 1, 2,
    "Settings and Home both warn about the stale calendar");
  assert.doesNotMatch(container.textContent, /upcoming.noEventsToday/,
    "a failed sync cannot assert that today's calendar is empty");
  assert.doesNotMatch(container.textContent, /integrations.googleCalendar.peopleAccessMissing/,
    "calendar reauthorization is more prominent than optional Contacts access");
  buttons["integrations.sync.openSettings"].onClick();
  assert.equal(settingsOpened, 1);
  await React.act(async () => buttons["integrations.sync.reconnect"].onClick());
  assert.deepEqual(calls, ["reconnect"]);
  assert.doesNotMatch(container.textContent, /integrations.sync.outOfSyncTitle/);
  assert.match(container.textContent, /integrations.googleCalendar.connected/);
  assert.match(container.textContent, /upcoming.noEventsToday/);
  sync = { state: "error", requiresReconnect: false };
  await React.act(async () => emitSync());
  assert.match(container.textContent, /integrations.sync.outOfSync/);
  assert.match(container.textContent, /integrations.sync.failed/);
  assert.doesNotMatch(container.textContent, /integrations.googleCalendar.connected/);
  await React.act(async () => buttons["integrations.sync.retry"].onClick());
  assert.deepEqual(calls, ["reconnect", "retry"]);
  assert.doesNotMatch(container.textContent, /integrations.sync.outOfSyncTitle/);
  connected = false;
  sync = { state: "pending", requiresReconnect: false };
  await React.act(async () => emitSync());
  assert.deepEqual(globals.__calendarConnectionStore!.gcalAccounts, [],
    "authoritative disconnected status clears the old locally cached account");
  assert.doesNotMatch(container.textContent, /integrations.sync.checking/,
    "an account absent from the main process cannot remain Checking sync");
  assert.doesNotMatch(container.textContent, /test@example.com/);
  assert.match(container.textContent, /integrations.status.notConfigured/);
  await React.act(async () => root.unmount());
  assert.equal(listeners.size, 0, "unmount removes all calendar sync subscriptions");
});
