import assert from "node:assert/strict";
import test from "node:test";
import { createRendererServer, installBrowserGlobals } from "../../../lib/rendererTestHarness";

test("profile name persists, restores, and can be cleared without changing other settings", async (t) => {
  const { storage } = installBrowserGlobals(t, { initialStorage: { profileName: "Timur" } });
  const vite = await createRendererServer(t, { cachePrefix: "profile-settings-" });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  assert.equal(useSettingsStore.getState().profileName, "Timur");
  useSettingsStore.getState().setProfileName("Тимур Хахалев");
  assert.equal(storage.getItem("profileName"), "Тимур Хахалев");
  assert.equal(useSettingsStore.getState().profileName, "Тимур Хахалев");
  useSettingsStore.getState().setProfileName("");
  assert.equal(storage.getItem("profileName"), "");
  assert.equal(useSettingsStore.getState().profileName, "");
});
