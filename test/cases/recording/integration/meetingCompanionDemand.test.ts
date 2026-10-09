import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { createRoot } from "react-dom/client";
import { createMeetingCompanionBridge } from "../../../../src/preload/meetingCompanionBridge.ts";
import { meetingCompanionChannels, meetingCompanionEventChannels } from "../../../../src/contracts/meetingCompanion.ts";
import { createRendererServer, installBrowserGlobals, installHookDom } from "../../../lib/rendererTestHarness.ts";

test("level demand bridge subscribes before requesting the snapshot and rejects invalid events", () => {
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>();
  const received: boolean[] = [];
  const bridge = createMeetingCompanionBridge({
    invoke: async () => undefined,
    on: (channel, listener) => listeners.set(channel, listener),
    removeListener: (channel) => listeners.delete(channel),
    send: (channel) => {
      assert.equal(channel, meetingCompanionChannels.watchLevelDemand);
      listeners.get(meetingCompanionEventChannels.levelDemand)!(null, true);
    },
  });
  const unsubscribe = bridge.onMeetingCompanionLevelDemand((needed) => received.push(needed));
  const listener = listeners.get(meetingCompanionEventChannels.levelDemand)!;
  for (const value of [null, 1, "true", {}, false]) listener(null, value);
  assert.deepEqual(received, [true, false]);
  unsubscribe();
  assert.equal(listeners.size, 0);
});

test("companion polls only while visible and releases its timer on hide and unmount", async (t) => {
  let demand: (needed: boolean) => void = () => {};
  let unsubscribed = false;
  const levels: number[] = [];
  installBrowserGlobals(t, { window: { electronAPI: {
    onMeetingCompanionLevelDemand: (callback: typeof demand) => {
      demand = callback;
      return () => { unsubscribed = true; };
    },
    sendMeetingCompanionLevel: (level: number) => levels.push(level),
  } } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { mockModules: {
    "stores/settingsStore": "export const useSettingsStore = s => s({meetingCompanionEnabled:true});",
    "stores/meetingRecordingStore": `
      export const useMeetingRecordingStore = s => s({isRecording:true,capturePhase:'recording'});
      export const getMicAnalyser = () => null;
      export const getSystemAudioLevel = () => 0.1;
      export const setManualMicMuted = async () => {};`,
  } });
  const { useMeetingCompanionSync } = await vite.ssrLoadModule("/hooks/useMeetingCompanionSync.ts");
  const timers = new Map<number, () => void>();
  let next = 0;
  t.mock.method(globalThis, "setInterval", (callback: () => void, ms: number) => {
    assert.equal(ms, 100);
    timers.set(++next, callback);
    return next;
  });
  t.mock.method(globalThis, "clearInterval", (id: number) => timers.delete(id));
  function Harness() { useMeetingCompanionSync(); return null; }
  const root = createRoot(container as unknown as HTMLElement);
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    assert.equal(timers.size, 0);
    await React.act(async () => demand(true));
    assert.equal(timers.size, 1);
    for (const tick of timers.values()) tick();
    assert.ok(levels.at(-1)! > 0);
    await React.act(async () => demand(false));
    assert.equal(timers.size, 0);
    assert.equal(levels.at(-1), 0);
    await React.act(async () => demand(true));
    assert.equal(timers.size, 1);
  } finally { await React.act(async () => root.unmount()); }
  assert.equal(timers.size, 0);
  assert.equal(unsubscribed, true);
});
