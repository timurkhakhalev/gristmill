// Shared setup for tests that load renderer modules through Vite SSR:
// Map-backed browser globals plus a dev server with per-test module mocks.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function installBrowserGlobals(t, { initialStorage = {}, window: windowProps = {} } = {}) {
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;
  const values = new Map(Object.entries(initialStorage));
  const storage = {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
  };
  globalThis.localStorage = storage;
  globalThis.window = {
    innerWidth: 1200,
    localStorage: storage,
    addEventListener() {},
    removeEventListener() {},
    setTimeout(...args) {
      return globalThis.setTimeout(...args);
    },
    clearTimeout(timeoutId) {
      globalThis.clearTimeout(timeoutId);
    },
    setInterval() {
      return 1;
    },
    electronAPI: {},
    ...windowProps,
  };
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;
  });
  return { window: globalThis.window, storage };
}

// Minimal fake DOM for mounting hook harnesses with react-dom's createRoot:
// just enough node structure for React to attach a root — no layout, no real
// events. Call installBrowserGlobals first; this assigns onto globalThis.window.
function installHookDom(t) {
  const originalDocument = globalThis.document;
  const originalActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const noop = () => {};

  class Element {}
  class HTMLElement extends Element {}
  class HTMLIFrameElement extends HTMLElement {}

  function makeNode(nodeType, nodeName, namespaceURI = "http://www.w3.org/1999/xhtml") {
    const node = {
      nodeType,
      nodeName,
      tagName: nodeType === 1 ? nodeName.toUpperCase() : undefined,
      namespaceURI: nodeType === 1 ? namespaceURI : null,
      ownerDocument: null,
      parentNode: null,
      childNodes: [],
      attributes: new Map(),
      style: {},
      appendChild(child) {
        child.parentNode?.removeChild?.(child);
        child.parentNode = this;
        this.childNodes.push(child);
        return child;
      },
      insertBefore(child, before) {
        if (!before) return this.appendChild(child);
        child.parentNode?.removeChild?.(child);
        const index = this.childNodes.indexOf(before);
        child.parentNode = this;
        this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child);
        return child;
      },
      removeChild(child) {
        const index = this.childNodes.indexOf(child);
        if (index >= 0) this.childNodes.splice(index, 1);
        child.parentNode = null;
        return child;
      },
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      removeAttribute(name) { this.attributes.delete(name); },
      addEventListener: noop,
      removeEventListener: noop,
      contains(candidate) {
        return candidate === this || this.childNodes.some((child) => child.contains?.(candidate));
      },
      get firstChild() { return this.childNodes[0] ?? null; },
      get lastChild() { return this.childNodes.at(-1) ?? null; },
      get options() { return this.childNodes.filter((child) => child.tagName === "OPTION"); },
      get nextSibling() {
        if (!this.parentNode) return null;
        const siblings = this.parentNode.childNodes;
        return siblings[siblings.indexOf(this) + 1] ?? null;
      },
      get textContent() {
        return nodeType === 3 ? this.nodeValue : this.childNodes.map((child) => child.textContent ?? "").join("");
      },
      set textContent(value) {
        this.childNodes.forEach((child) => { child.parentNode = null; });
        this.childNodes = [];
        if (value != null && String(value)) this.appendChild(document.createTextNode(String(value)));
      },
    };
    if (nodeType === 3 || nodeType === 8) {
      node.nodeValue = "";
      node.data = "";
    }
    Object.setPrototypeOf(node, nodeType === 1 ? (namespaceURI === "http://www.w3.org/1999/xhtml" ? HTMLElement.prototype : Element.prototype) : Object.prototype);
    return node;
  }

  const document = {
    nodeType: 9,
    activeElement: null,
    addEventListener: noop,
    removeEventListener: noop,
    createElement(name) {
      const element = makeNode(1, name);
      element.ownerDocument = document;
      return element;
    },
    createElementNS(namespaceURI, name) {
      const element = makeNode(1, name, namespaceURI);
      element.ownerDocument = document;
      return element;
    },
    createTextNode(value) {
      const node = makeNode(3, "#text");
      node.ownerDocument = document;
      node.nodeValue = String(value);
      node.data = String(value);
      return node;
    },
    createComment(value) {
      const node = makeNode(8, "#comment");
      node.ownerDocument = document;
      node.nodeValue = String(value);
      node.data = String(value);
      return node;
    },
    createDocumentFragment() {
      const fragment = makeNode(11, "#document-fragment");
      fragment.ownerDocument = document;
      return fragment;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  document.createRange = () => ({
    setStart() {},
    setEnd() {},
    createContextualFragment: () => document.createDocumentFragment(),
  });
  const container = document.createElement("div");
  document.documentElement = document.createElement("html");
  document.head = document.createElement("head");
  document.body = document.createElement("body");
  document.documentElement.appendChild(document.head);
  document.documentElement.appendChild(document.body);
  Object.assign(globalThis.window, {
    Element,
    HTMLElement,
    HTMLIFrameElement,
    document,
    getSelection: () => null,
  });
  document.defaultView = globalThis.window;
  document.documentElement = container;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = noop;

  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalActEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    else globalThis.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    if (originalCancelAnimationFrame === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  return container;
}

// mockModules maps an import-path suffix (e.g. "/utils/logger") to the ESM
// source served in its place.
async function createRendererServer(
  t,
  {
    cachePrefix = "openwhispr-renderer-test-",
    mockModules = {},
    noExternal = false,
    resolveAlias = {},
  } = {}
) {
  const { createServer } = await import("vite");
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), cachePrefix));
  const suffixes = Object.keys(mockModules);
  const vite = await createServer({
    root: path.resolve(__dirname, "../../src"),
    cacheDir,
    configFile: false,
    resolve: { alias: resolveAlias },
    appType: "custom",
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true },
    ssr: noExternal ? { noExternal } : undefined,
    plugins: [
      {
        name: "renderer-test-module-mocks",
        enforce: "pre",
        resolveId(source) {
          const suffix = suffixes.find((candidate) => source.endsWith(candidate));
          if (suffix) return `\0mock:${suffix}`;
          return null;
        },
        load(id) {
          if (!id.startsWith("\0mock:")) return null;
          return mockModules[id.slice("\0mock:".length)];
        },
      },
    ],
    server: { middlewareMode: true },
  });
  t.after(async () => {
    await vite.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });
  return vite;
}

// Minimal Web Audio + capture stubs so the mic pipeline can run under Node.
function installMicCaptureGlobals(t) {
  const track = {
    readyState: "live",
    label: "Fake Mic",
    stop() {},
    getSettings: () => ({}),
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
  };
  const mediaDevices = {
    getUserMedia: async () => stream,
    enumerateDevices: async () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  const node = () => ({
    connect() {},
    disconnect() {},
    gain: { value: 0 },
    fftSize: 0,
    smoothingTimeConstant: 0,
  });
  class FakeAudioContext {
    constructor({ sampleRate = 48_000 } = {}) {
      this.state = "running";
      this.sampleRate = sampleRate;
      this.audioWorklet = { addModule: async () => {} };
      this.destination = {};
    }
    createMediaStreamSource() {
      return node();
    }
    createGain() {
      return node();
    }
    createAnalyser() {
      return node();
    }
    async resume() {}
    async close() {}
  }
  class FakeAudioWorkletNode {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage: (message) => {
          if (message?.type === "flush") {
            queueMicrotask(() =>
              this.port.onmessage?.({ data: { type: "flush-complete", lastSequence: -1 } })
            );
          }
        },
      };
    }
    connect() {}
    disconnect() {}
  }

  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices },
    configurable: true,
    writable: true,
  });
  globalThis.AudioContext = FakeAudioContext;
  globalThis.AudioWorkletNode = FakeAudioWorkletNode;
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
    delete globalThis.AudioContext;
    delete globalThis.AudioWorkletNode;
  });
}

module.exports = {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
  installMicCaptureGlobals,
};
