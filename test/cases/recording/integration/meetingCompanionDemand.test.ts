import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { createRoot } from "react-dom/client";
import { createMeetingCompanionBridge } from "../../../../src/preload/meetingCompanionBridge.ts";
import { meetingCompanionChannels, meetingCompanionEventChannels } from "../../../../src/contracts/meetingCompanion.ts";
import { createRendererServer, installBrowserGlobals, installHookDom } from "../../../lib/rendererTestHarness.ts";

test("main reports demand through ready, focus, pause, close and stop", async (t) => {
  const vite = await createRendererServer(t, { noExternal: ["electron"], mockModules: {
    electron: `
      import {EventEmitter} from 'node:events';
      export const app = new EventEmitter();
      const display = () => ({workArea:{x:0,y:0,width:1000,height:800}});
      export const screen = {getPrimaryDisplay: display, getDisplayNearestPoint: display};
      export const windows = [];
      export class BrowserWindow extends EventEmitter {
        visible = false; destroyed = false;
        webContents = {send() {}};
        constructor() {super(); windows.push(this);}
        isVisible() {return this.visible;}
        isDestroyed() {return this.destroyed;}
        showInactive() {this.visible = true;}
        hide() {this.visible = false;}
        destroy() {this.destroyed = true; this.visible = false; this.emit('closed');}
        setContentProtection() {}
        async loadFile() {}
        async loadURL() {}
      }`,
    "./debugLogger.js": "export default {warn() {}};",
    "./devServerManager.js": "export const DevServerManager = {waitForDevServer: async () => {}, DEV_SERVER_URL:'http://synthetic.invalid', getAppFilePath: () => ({path:'synthetic.html',query:{}})};",
    "./windowConfig.js": "export const NOTIFICATION_WINDOW_CONFIG = {}; export const WindowPositionUtil = {setupAlwaysOnTop() {}};",
  } });
  const { MeetingCompanionWindow } = await vite.ssrLoadModule("/helpers/meetingCompanionWindow.ts");
  const { app, windows } = await vite.ssrLoadModule("electron");
  const received: boolean[] = [];
  let focused = false;
  const panel = {
    isDestroyed: () => false, isVisible: () => true, isFocused: () => focused,
    webContents: { send: (channel: string, value: boolean) => {
      assert.equal(channel, meetingCompanionEventChannels.levelDemand);
      received.push(value);
    } },
  };
  const companion = new MeetingCompanionWindow({getControlPanelWindow: () => panel, openNote: async () => {}});
  t.after(() => { companion.destroy(); app.removeAllListeners(); });
  const state = {active:true,paused:false,noteId:1,folderId:null,micMuted:false};
  companion.update(state);
  assert.equal(received.at(-1), false, "wait for the window to load");
  companion.handleReady();
  assert.equal(received.at(-1), true);
  focused = true;
  app.emit("browser-window-focus");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(received.at(-1), false);
  focused = false;
  app.emit("browser-window-blur");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(received.at(-1), true);
  companion.update({...state,paused:true});
  assert.equal(received.at(-1), false);
  companion.update(state);
  assert.equal(received.at(-1), true);
  companion.reportLevelDemand();
  assert.equal(received.at(-1), true, "snapshot after panel reload");
  windows.at(-1).destroy();
  assert.equal(received.at(-1), false);
  companion.update(state);
  companion.handleReady();
  assert.equal(received.at(-1), true);
  companion.update({...state,active:false});
  assert.equal(received.at(-1), false);
});

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
