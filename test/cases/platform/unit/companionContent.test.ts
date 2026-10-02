import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";

test("content releases observers and timer when extension reload invalidates messaging", async () => {
  const bundle = await build({ entryPoints: ["extension/src/content.ts"], bundle: true, platform: "browser", write: false });
  let activeObservers = 0;
  let sends = 0;
  let timerActive = false;
  let scan: (() => void) | undefined;
  vm.runInNewContext(bundle.outputFiles[0].text, {
    document: { visibilityState: "visible", documentElement: {}, querySelector: () => null,
      addEventListener() {}, removeEventListener() {} },
    window: { addEventListener() {} },
    MutationObserver: class { observe() { activeObservers++; } disconnect() { activeObservers--; } },
    performance: { now: () => 100 }, crypto: { randomUUID: () => "123" },
    setInterval: (callback: () => void) => { scan = callback; timerActive = true; return 1; },
    clearInterval: () => { timerActive = false; }, setTimeout() {},
    chrome: { runtime: { onMessage: { addListener() {} },
      sendMessage() { sends++; throw new Error("Extension context invalidated."); } } },
  });
  assert.equal(sends, 1);
  assert.equal(timerActive, false);
  assert.equal(activeObservers, 0);
  scan!();
  assert.equal(sends, 1, "scheduled old scans cannot send or reinstall observers");
  assert.equal(activeObservers, 0);
});
