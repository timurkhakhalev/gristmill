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
import {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} from "../../../lib/rendererTestHarness";
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

async function renderProvider(
  vite: ViteDevServer,
  container: unknown
): Promise<{ root: Root; store: { getState(): Record<string, unknown> } }> {
  const { SettingsProvider } = await vite.ssrLoadModule("/hooks/useSettings.ts");

  const { useSettingsStore, initializeSettings } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );

  // The store registers its cross-window storage listener at the tail of
  // initializeSettings. Awaited here so the listener exists before any
  // synthetic storage event is dispatched — an un-awaited call leaves
  // hydration suspended and the event is dropped.
  await initializeSettings();
  let root: Root | undefined;
  await React.act(async () => {
    root = createRoot(container as unknown as Element);
    root.render(React.createElement(SettingsProvider, null, React.createElement("div")));
    await Promise.resolve();
  });

  return { root: root!, store: useSettingsStore as { getState(): Record<string, unknown> } };
}

const last = (calls: Prefs[]): Prefs => calls[calls.length - 1]!;

// Flushes microtasks until the predicate holds, so the test waits for the real
// async hydration / effect instead of racing it. Fails with the label if the
// expected state never arrives within the budget.
async function waitFor(predicate: () => boolean, label: string, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.fail(label);
}

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
      (
        store.getState() as { setNotificationsEnabled(value: boolean): void }
      ).setNotificationsEnabled(false);
      await Promise.resolve();
    });
    assert.equal(last(calls).notificationsEnabled, false, "disable must reach main");

    await React.act(async () => {
      (
        store.getState() as { setNotifyCalendarReminders(value: boolean): void }
      ).setNotifyCalendarReminders(false);
      await Promise.resolve();
    });
    assert.equal(last(calls).notifyCalendarReminders, false);

    await React.act(async () => {
      (
        store.getState() as { setNotificationsEnabled(value: boolean): void }
      ).setNotificationsEnabled(true);
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
// value to main in this window too. The assertion requires a *new* main call,
// so it cannot pass on inherited state or echo the mount payload.
test("a change arriving from another window reaches main", async (t) => {
  const { calls, container, vite, storageEvents } = await mountProvider(t);
  const { root } = await renderProvider(vite, container);

  try {
    // Wait until the storage listener is actually registered: initializeSettings
    // registers it at its tail, and a dispatch before then is silently dropped.
    await waitFor(() => storageEvents.length >= 1, "the store subscribed to storage");
    assert.equal(calls.length, 1, "only the mount-time sync has run");

    // The inherited state has notifyMeetingDetection on, so reaching `false`
    // proves the storage path rather than a pre-existing value.
    await React.act(async () => {
      storageEvents[0]({
        key: "notifyMeetingDetection",
        newValue: "false",
        storageArea: (globalThis as { localStorage: Storage }).localStorage,
      } as unknown as StorageEvent);
      await Promise.resolve();
    });
    await waitFor(() => calls.length >= 2, "the other-window change reached main");
    assert.equal(calls.length, 2, "exactly one extra main call");
    assert.equal(last(calls).notifyMeetingDetection, false, "other-window change must reach main");
    assert.equal(last(calls).notificationsEnabled, true, "the untouched prefs stay as they were");
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
      (
        store.getState() as { setNotificationsEnabled(value: boolean): void }
      ).setNotificationsEnabled(true);
      await Promise.resolve();
    });
    assert.equal(calls.length, 1, "unchanged values must not resend");
  } finally {
    React.act(() => root.unmount());
  }
});
