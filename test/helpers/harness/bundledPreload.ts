import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

export type PreloadListener = (event: unknown, ...args: unknown[]) => void;

// Method syntax keeps listener parameters bivariant, so a test can pass a
// listener typed for its own payload shape.
export interface PreloadTransport {
  invoke?(channel: string, ...args: unknown[]): Promise<unknown>;
  send?(channel: string, ...args: unknown[]): void;
  on?(channel: string, listener: PreloadListener): void;
  removeListener?(channel: string, listener: PreloadListener): void;
}

const bundledPreload = path.join(__dirname, "../../../dist-main/preload.js");

// Runs the emitted preload bundle in a sandbox, as Electron does, and returns
// the API that it exposes through contextBridge. Missing transport methods
// are no-ops. The preload must require only electron.
export function loadBundledPreload<Api>(transport: PreloadTransport = {}): Api {
  assert.ok(fs.existsSync(bundledPreload), "Run pnpm run build:main first");
  let api: unknown;
  vm.runInNewContext(fs.readFileSync(bundledPreload, "utf8"), {
    // The bundle keeps CJS interop for hybrid manifest modules, so the
    // sandbox needs the same bindings Node's CJS loader provides.
    module: { exports: {} },
    exports: {},
    require(name: string) {
      assert.equal(name, "electron", "the bundled preload must only require electron");

      return {
        contextBridge: {
          exposeInMainWorld: (_name: string, value: unknown) => {
            api = value;
          },
        },
        ipcRenderer: {
          invoke: (channel: string, ...args: unknown[]) =>
            transport.invoke ? transport.invoke(channel, ...args) : Promise.resolve(undefined),
          send: (channel: string, ...args: unknown[]) => transport.send?.(channel, ...args),
          on: (channel: string, listener: PreloadListener) => transport.on?.(channel, listener),
          removeListener: (channel: string, listener: PreloadListener) =>
            transport.removeListener?.(channel, listener),
        },
        webUtils: { getPathForFile: () => "" },
      };
    },
    process: { platform: "darwin", versions: {} },
    console,
  });
  assert.ok(api && typeof api === "object", "Bundled preload did not expose its API");

  // SAFETY: the bundle exposes one API object; each test names the part it calls.
  return api as Api;
}

// Records ipcRenderer listeners per channel, so a test can emit main-process
// events and check unsubscribe.
export function createListenerRegistry() {
  const listeners = new Map<string, PreloadListener[]>();

  return {
    listeners,
    on(channel: string, listener: PreloadListener) {
      const list = listeners.get(channel) || [];
      list.push(listener);
      listeners.set(channel, list);
    },
    removeListener(channel: string, listener: PreloadListener) {
      const list = listeners.get(channel) || [];
      const index = list.indexOf(listener);
      if (index !== -1) list.splice(index, 1);
    },
  };
}

// Objects from vm.runInNewContext have a different prototype; compare by JSON.
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
