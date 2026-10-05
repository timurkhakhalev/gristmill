import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRendererServer, installMicCaptureGlobals, installBrowserGlobals, installHookDom } from "../../../lib/rendererTestHarness.ts";

function cleanupOwner(t: TestContext) {
  const hooks: Array<() => Promise<void>> = [];
  return { owner: { after: (fn: (t: TestContext) => unknown) => { hooks.push(async () => { await fn(t); }); } },
    cleanup: async () => { for (const hook of hooks.splice(0)) await hook(); } };
}

for (const failure of ["setup", "close"] as const) test(`renderer cache is removed after ${failure} failure`, async (t) => {
  const { owner, cleanup } = cleanupOwner(t);
  t.after(cleanup);
  let cacheDir = "";
  const factory: typeof import("vite").createServer = async config => {
    cacheDir = config?.cacheDir ?? "";
    assert.ok(fs.existsSync(cacheDir));
    if (failure === "setup") throw new Error("setup failed");
    const vite = await (await import("vite")).createServer(config);
    const close = vite.close.bind(vite);
    t.mock.method(vite, "close", async () => { await close(); throw new Error("close failed"); });
    return vite;
  };
  if (failure === "setup") {
    await assert.rejects(createRendererServer(owner, {}, factory), /setup failed/);
    await cleanup();
  } else {
    await createRendererServer(owner, {}, factory);
    await assert.rejects(cleanup(), /close failed/);
  }
  assert.equal(fs.existsSync(cacheDir), false);
});

test("mic globals restore original descriptors, including accessors, and remove absent globals", async (t) => {
  const names = ["navigator", "AudioContext", "AudioWorkletNode"] as const;
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  t.after(() => names.forEach((name, i) => {
    if (originals[i]) Object.defineProperty(globalThis, name, originals[i]!);
    else delete (globalThis as Record<string, unknown>)[name];
  }));
  const getter = () => "original";
  for (const existing of [true, false]) {
    for (const name of names) {
      if (existing) Object.defineProperty(globalThis, name, { get: getter, enumerable: true, configurable: true });
      else delete (globalThis as Record<string, unknown>)[name];
    }
    const { owner, cleanup } = cleanupOwner(t);
    t.after(cleanup);
    installMicCaptureGlobals(owner);
    assert.equal(typeof (globalThis as Record<string, unknown>).AudioContext, "function");
    // Test cleanup also runs when the consuming assertion throws.
    try { assert.fail("consumer failed"); }
    catch { await cleanup(); }
    for (const name of names) assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, name),
      existing ? { get: getter, set: undefined, enumerable: true, configurable: true } : undefined);
  }
});

test("DOM constructors restore exact absent, value and accessor descriptors after failure", async t => {
  const names = ["Element", "HTMLElement", "HTMLIFrameElement", "SVGElement"] as const;
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  t.after(() => names.forEach((name, index) => {
    if (originals[index]) Object.defineProperty(globalThis, name, originals[index]!);
    else delete (globalThis as Record<string, unknown>)[name];
  }));
  const value = function Original() {};
  const getter = () => value;
  for (const kind of ["absent", "value", "accessor"] as const) {
    for (const name of names) {
      delete (globalThis as Record<string, unknown>)[name];
      if (kind === "value") Object.defineProperty(globalThis, name, { value, writable: false, enumerable: false, configurable: true });
      if (kind === "accessor") Object.defineProperty(globalThis, name, { get: getter, enumerable: false, configurable: true });
    }
    const expected = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
    const { owner, cleanup } = cleanupOwner(t);
    t.after(cleanup);
    installBrowserGlobals(owner);
    installHookDom(owner);
    for (const name of names) assert.notEqual((globalThis as Record<string, unknown>)[name], value);
    try { assert.fail("consumer failed"); } catch { await cleanup(); }
    assert.deepEqual(names.map(name => Object.getOwnPropertyDescriptor(globalThis, name)), expected);
    const failed = cleanupOwner(t);
    t.after(failed.cleanup);
    installBrowserGlobals(failed.owner);
    const define = Object.defineProperty;
    let inject = true;
    const mock = t.mock.method(Object, "defineProperty", (target: object, name: PropertyKey, descriptor: PropertyDescriptor) => {
      if (inject && target === globalThis && name === "HTMLElement") {
        inject = false;
        throw new Error("setup failed after Element installation");
      }
      return define(target, name, descriptor);
    });
    try { assert.throws(() => installHookDom(failed.owner), /setup failed/); }
    finally { mock.mock.restore(); await failed.cleanup(); }
    assert.deepEqual(names.map(name => Object.getOwnPropertyDescriptor(globalThis, name)), expected);
  }
});
