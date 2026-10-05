import test from "node:test";
import assert from "node:assert/strict";
import { createControlPanelActionSubscriptions } from "../../../../src/preload/controlPanelActions.ts";

test("preload retains each action before subscription and across handler disposal", () => {
  const listeners = new Map<string, (event: unknown, data?: unknown) => void>();

  const api = createControlPanelActionSubscriptions({
    on: (channel, listener) => listeners.set(channel, listener),
  });

  const results: unknown[] = [];
  const emit = (channel: string, value?: unknown) => listeners.get(channel)!(null, value);
  emit("tray-new-note");
  emit("tray-new-note");
  emit("tray-open-event", { id: "early" });
  emit("show-settings");
  const offNote = api.onTrayNewNote(() => results.push("note"));
  const offEvent = api.onTrayOpenEvent((event) => results.push(event));
  const offSettings = api.onShowSettings(() => results.push("settings"));
  assert.deepEqual(results, ["note", "note", { id: "early" }, "settings"]);
  offNote();
  offEvent();
  offSettings();
  emit("tray-open-event", { id: "remount" });
  const later: unknown[] = [];
  const staleDispose = api.onTrayOpenEvent((event) => later.push(event));
  const currentDispose = api.onTrayOpenEvent((event) => later.push(event));
  staleDispose();
  emit("tray-open-event", { id: "current" });
  assert.deepEqual(later, [{ id: "remount" }, { id: "current" }]);
  currentDispose();
  assert.equal(listeners.size, 3, "one lifetime IPC listener per command");
});
