import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";

test("content releases observers and timer when extension reload invalidates messaging", async () => {
  const bundle = await build({
    entryPoints: ["extension/src/content.ts"],
    bundle: true,
    platform: "browser",
    write: false,
  });

  let activeObservers = 0;
  let sends = 0;
  let timerActive = false;
  let scan: (() => void) | undefined;
  vm.runInNewContext(bundle.outputFiles[0].text, {
    document: {
      visibilityState: "visible",
      documentElement: {},
      querySelector: () => null,
      addEventListener() {},
      removeEventListener() {},
    },
    window: { addEventListener() {} },
    MutationObserver: class {
      observe() {
        activeObservers++;
      }
      disconnect() {
        activeObservers--;
      }
    },
    performance: { now: () => 100 },
    crypto: { randomUUID: () => "123" },
    setInterval: (callback: () => void) => {
      scan = callback;
      timerActive = true;

      return 1;
    },
    clearInterval: () => {
      timerActive = false;
    },
    setTimeout() {},
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage() {
          sends++;
          throw new Error("Extension context invalidated.");
        },
      },
    },
  });
  assert.equal(sends, 1);
  assert.equal(timerActive, false);
  assert.equal(activeObservers, 0);
  scan!();
  assert.equal(sends, 1, "scheduled old scans cannot send or reinstall observers");
  assert.equal(activeObservers, 0);
});

test("Telemost iframe Leave requires a trusted final click and cannot cross rooms or expiry", async () => {
  const bundle = await build({
    entryPoints: ["extension/src/content.ts"],
    bundle: true,
    platform: "browser",
    write: false,
  });

  let scan: (() => void) | undefined;
  let now = 100;
  let room = "12345678901234";
  let home = false;
  let confirmation = false;
  const clicks = new Map<unknown, (event: unknown) => void>();
  const contexts: Array<{ confirmedLeave: boolean; presence: string }> = [];

  const geometry = {
    getBoundingClientRect: () => ({ width: 100, height: 40 }),
    parentElement: null,
  };

  const styles = {
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  };

  const bar = {
    ...geometry,
    querySelector: () => ({}),
    querySelectorAll: () => [],
    ownerDocument: {},
  };

  const end = { ...geometry, parentElement: bar, ownerDocument: {} };

  const frameDoc = {
    URL: "",
    visibilityState: "visible",
    documentElement: {},
    defaultView: styles,
    querySelector: (selector: string) =>
      confirmation && selector.includes("end-call-button") ? {} : null,
    querySelectorAll: (selector: string) => (selector.includes("end-call-alt-button") ? [end] : []),
    addEventListener: (type: string, callback: (event: unknown) => void) => {
      if (type === "click") clicks.set(frameDoc, callback);
    },
    removeEventListener() {},
  };

  end.ownerDocument = frameDoc;
  bar.ownerDocument = frameDoc;
  const frame = { src: "", contentDocument: frameDoc };

  const root = {
    URL: "",
    location: { hostname: "telemost.yandex.ru" },
    visibilityState: "visible",
    documentElement: {},
    querySelector: (selector: string) => (home && selector === "#home-hub-page-title" ? {} : null),
    querySelectorAll: (selector: string) =>
      !home && selector === "iframe[allowfullscreen]" ? [frame] : [],
    addEventListener: (type: string, callback: (event: unknown) => void) => {
      if (type === "click") clicks.set(root, callback);
    },
    removeEventListener() {},
  };

  const route = () => {
    root.URL = `https://telemost.yandex.ru/${home ? "chats" : `j/${room}`}`;
    frame.src = frameDoc.URL = `https://telemost.yandex.ru/private-join/${room}`;
  };

  route();
  vm.runInNewContext(bundle.outputFiles[0].text, {
    document: root,
    window: { addEventListener() {} },
    URL,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    performance: { now: () => now },
    crypto: { randomUUID: () => "123" },
    setInterval: (callback: () => void) => {
      scan = callback;

      return 1;
    },
    clearInterval() {},
    setTimeout() {},
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage(message: {
          type: string;
          context: { confirmedLeave: boolean; presence: string };
        }) {
          if (message.type === "context") contexts.push(message.context);

          return Promise.resolve();
        },
      },
    },
  });

  const click = (trusted: boolean, menu = false) =>
    clicks.get(frameDoc)!({
      isTrusted: trusted,
      target: {
        nodeType: 1,
        ownerDocument: frameDoc,
        closest: (selector: string) =>
          selector === 'button[data-testid="end-call-alt-button"]' ? (menu ? {} : null) : {},
      },
    });

  const enter = () => {
    home = false;
    route();
    scan!();
  };

  const exit = () => {
    home = true;
    route();
    scan!();

    return contexts.at(-1)!;
  };

  assert.equal(contexts.at(-1)?.presence, "in-call");
  click(false);
  assert.equal(exit().confirmedLeave, false, "page-script click has no Stop authority");
  enter();
  click(true);
  assert.equal(exit().confirmedLeave, true, "cross-realm iframe element is accepted");
  enter();
  click(true, true);
  confirmation = true;
  scan!();
  confirmation = false;
  assert.equal(exit().confirmedLeave, false, "opening the organizer confirmation is not Leave");
  enter();
  click(true, true);
  assert.equal(exit().confirmedLeave, true, "non-organizer exits directly");
  enter();
  click(true);
  room = "99999999999999";
  route();
  scan!();
  assert.equal(exit().confirmedLeave, false, "room change clears old Leave intent");
  enter();
  click(true);
  now += 10_001;
  assert.equal(exit().confirmedLeave, false, "expired click cannot Stop");
});
