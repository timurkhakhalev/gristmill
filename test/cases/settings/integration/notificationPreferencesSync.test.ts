// Issue #173: the three notification toggles used plain boolean store setters,
// so changing one updated localStorage and Zustand but never reached main —
// syncNotificationPreferences only ran during the one-time initializeSettings.
// This drives the real SettingsProvider with the real store and a fake
// electronAPI and asserts the setter reaches main without a reload, that a
// second window's change (the store's own storage listener) also reaches main,
// and that the startup-only call was removed rather than duplicated.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRendererServer, installBrowserGlobals, installHookDom } from "../../../lib/rendererTestHarness";
import type { ViteDevServer } from "vite";

type Prefs = {
  notificationsEnabled: boolean;
  notifyMeetingDetection: boolean;
  notifyCalendarReminders: boolean;
};

async function mountProvider(t: TestContext, initialStorage: Record<string, string> = {}) {
  const calls: Prefs[] = [];
  const storageEvents: Array<(event: StorageEvent) => void> = [];
  installBrowserGlobals(t, {
    initialStorage,
    window: {
      addEventListener: (name: string, listener: (event: StorageEvent) => void) => {
        if (name === "storage") storageEvents.push(listener);
      },
      removeEventListener: () => {},
      electronAPI: {
        syncNotificationPreferences: async (prefs: Prefs) => {
          calls.push(prefs);
          return { success: true };
        },
        // initializeSettings also hydrates these; empty stubs keep it from
        // throwing before it registers the cross-window storage listener.
        getDictionary: async () => [],
        applyDictionaryChanges: async () => undefined,
        getSnippets: async () => [],
        getUiLanguage: async () => undefined,
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "notification-prefs-" });
  return { calls, storageEvents, container, vite };
}

async function renderProvider(vite: ViteDevServer, container: unknown): Promise<{ root: Root; store: { getState(): Record<string, unknown> } }> {
  const { SettingsProvider } = await vite.ssrLoadModule("/hooks/useSettings.ts");
  const { useSettingsStore, initializeSettings } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  // The store registers its cross-window storage listener from
  // initializeSettings; the Provider's own effect would start it too, but the
  // test needs it registered before it dispatches a synthetic storage event.
  await initializeSettings().catch(() => {});
  let root: Root | undefined;
  await React.act(async () => {
    root = createRoot(container as unknown as Element);
    root.render(React.createElement(SettingsProvider, null, React.createElement("div")));
    await Promise.resolve();
  });
  return { root: root!, store: useSettingsStore as { getState(): Record<string, unknown> } };
}

const last = (calls: Prefs[]): Prefs => calls[calls.length - 1]!;

test("a notification setter reaches main through the provider without a reload", async (t) => {
  const { calls, container, vite } = await mountProvider(t);
  const { root, store } = await renderProvider(vite, container);

  try {
    // Mount sends the initial value once.
    assert.equal(calls.length, 1);
    assert.deepEqual(last(calls), {
      notificationsEnabled: true,
      notifyMeetingDetection: true,
      notifyCalendarReminders: true,
    });

    await React.act(async () => {
      (store.getState() as { setNotificationsEnabled(value: boolean): void }).setNotificationsEnabled(false);
      await Promise.resolve();
    });
    assert.equal(last(calls).notificationsEnabled, false, "disable must reach main");

    await React.act(async () => {
      (store.getState() as { setNotifyCalendarReminders(value: boolean): void }).setNotifyCalendarReminders(false);
      await Promise.resolve();
    });
    assert.equal(last(calls).notifyCalendarReminders, false);

    await React.act(async () => {
      (store.getState() as { setNotificationsEnabled(value: boolean): void }).setNotificationsEnabled(true);
      await Promise.resolve();
    });
    assert.equal(last(calls).notificationsEnabled, true, "enable must reach main");
    assert.equal(calls.length, 4, "one call per change, no reload");
  } finally {
    React.act(() => root.unmount());
  }
});

// The store's storage listener is the other-window path: a storage event from a
// second window updates the store, and the provider effect must carry the new
// value to main in this window too.
test("a change arriving from another window reaches main", async (t) => {
  const { calls, container, vite, storageEvents } = await mountProvider(t);
  const { root } = await renderProvider(vite, container);

  try {
    assert.equal(calls.length, 1);
    // initializeSettings is a module-level once-guard shared across tests in
    // this process, so the cross-window listener may already be registered by
    // an earlier test's initializeSettings() call. Either way it must exist.
    assert.ok(storageEvents.length >= 1, "the store subscribed to storage");
    await React.act(async () => {
      storageEvents[0]({
        key: "notifyMeetingDetection",
        newValue: "false",
        storageArea: (globalThis as { localStorage: Storage }).localStorage,
      } as unknown as StorageEvent);
      await Promise.resolve();
    });
    assert.equal(last(calls).notifyMeetingDetection, false, "other-window change must reach main");
  } finally {
    React.act(() => root.unmount());
  }
});

// Regression: a resync of the exact same values must not look like a change —
// no redundant call, so main sees no spurious detector restart. The Provider
// must not resend when the store value is unchanged.
test("re-rendering with unchanged values does not resend preferences", async (t) => {
  const { calls, container, vite } = await mountProvider(t);
  const { root, store } = await renderProvider(vite, container);

  try {
    assert.equal(calls.length, 1);

    // Setting the value it already holds is a no-op in the store; React does not
    // re-run the effect, and main is not told anything again.
    await React.act(async () => {
      (store.getState() as { setNotificationsEnabled(value: boolean): void }).setNotificationsEnabled(true);
      await Promise.resolve();
    });
    assert.equal(calls.length, 1, "unchanged values must not resend");
  } finally {
    React.act(() => root.unmount());
  }
});
