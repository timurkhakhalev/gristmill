// Shared setup for tests that load renderer modules through Vite SSR:
// Map-backed browser globals plus a dev server with per-test module mocks.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { ViteDevServer } from "vite";

type FakeWindow = typeof globalThis & {
  electronAPI?: Record<string, unknown>;
};

export function installBrowserGlobals(
  t: TestContext,
  { initialStorage = {}, window: windowProps = {} }: { initialStorage?: Record<string, string>; window?: Record<string, unknown> } = {}
) {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
  const values = new Map(Object.entries(initialStorage));
  const storage = {
    getItem: (key: string) => (values.has(key) ? values.get(key)! : null),
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  };
  (globalThis as Record<string, unknown>).localStorage = storage;
  const originalCSS = (globalThis as { CSS?: unknown }).CSS;
  if (originalCSS === undefined) {
    // react-aria's getNonce reads global CSS; harmless stub for the fake DOM.
    (globalThis as Record<string, unknown>).CSS = { escape: (value: string) => value };
  }
  (globalThis as Record<string, unknown>).window = {
    innerWidth: 1200,
    localStorage: storage,
    addEventListener() {},
    removeEventListener() {},
    setTimeout(...args: Parameters<typeof setTimeout>) {
      return globalThis.setTimeout(...args);
    },
    clearTimeout(timeoutId: ReturnType<typeof setTimeout>) {
      globalThis.clearTimeout(timeoutId);
    },
    setInterval() {
      return 1;
    },
    electronAPI: {},
    ...windowProps,
  };
  t.after(() => {
    const globals = globalThis as Record<string, unknown>;
    if (originalWindow === undefined) delete globals.window;
    else globals.window = originalWindow;
    if (originalLocalStorage === undefined) delete globals.localStorage;
    else globals.localStorage = originalLocalStorage;
    if (originalCSS === undefined) delete globals.CSS;
  });
  return { window: (globalThis as unknown as { window: FakeWindow }).window, storage };
}

interface FakeNode {
  nodeType: number;
  nodeName: string;
  tagName?: string;
  namespaceURI: string | null;
  ownerDocument: FakeDocument | null;
  parentNode: FakeNode | null;
  childNodes: FakeNode[];
  attributes: Map<string, string>;
  style: Record<string, string>;
  nodeValue?: string;
  data?: string;
  appendChild(child: FakeNode): FakeNode;
  insertBefore(child: FakeNode, before: FakeNode | null): FakeNode;
  removeChild(child: FakeNode): FakeNode;
  setAttribute(name: string, value: unknown): void;
  removeAttribute(name: string): void;
  addEventListener(): void;
  removeEventListener(): void;
  contains(candidate: FakeNode | null): boolean;
  prepend(...nodes: FakeNode[]): void;
  append(...nodes: FakeNode[]): void;
  readonly firstChild: FakeNode | null;
  readonly lastChild: FakeNode | null;
  readonly options: FakeNode[];
  readonly nextSibling: FakeNode | null;
  textContent: string;
}

interface FakeDocument {
  nodeType: 9;
  activeElement: FakeNode | null;
  addEventListener(): void;
  removeEventListener(): void;
  createElement(name: string): FakeNode;
  createElementNS(namespaceURI: string, name: string): FakeNode;
  createTextNode(value: unknown): FakeNode;
  createComment(value: unknown): FakeNode;
  createDocumentFragment(): FakeNode;
  querySelector(): null;
  getElementById(id: string): FakeNode | null;
  querySelectorAll(): never[];
  createRange(): { setStart(): void; setEnd(): void; createContextualFragment(): FakeNode };
  documentElement: FakeNode;
  head: FakeNode;
  body: FakeNode;
  defaultView: unknown;
}

// Minimal fake DOM for mounting hook harnesses with react-dom's createRoot:
// just enough node structure for React to attach a root — no layout, no real
// events. Call installBrowserGlobals first; this assigns onto globalThis.window.
export function installHookDom(t: TestContext): FakeNode {
  const originalDocument = (globalThis as { document?: unknown }).document;
  const originalActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  const originalRequestAnimationFrame = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  const originalCancelAnimationFrame = (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
  const noop = () => {};

  class Element {}
  class HTMLElement extends Element {}
  class HTMLIFrameElement extends HTMLElement {}
  class SVGElement extends Element {}

  function makeNode(nodeType: number, nodeName: string, namespaceURI = "http://www.w3.org/1999/xhtml"): FakeNode {
    const node: FakeNode = {
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
      prepend(...nodes: FakeNode[]) {
        for (const node of [...nodes].reverse()) this.insertBefore(node, this.firstChild);
      },
      append(...nodes: FakeNode[]) {
        for (const node of nodes) this.appendChild(node);
      },
      get options() { return this.childNodes.filter((child) => child.tagName === "OPTION"); },
      get nextSibling() {
        if (!this.parentNode) return null;
        const siblings = this.parentNode.childNodes;
        return siblings[siblings.indexOf(this) + 1] ?? null;
      },
      get textContent() {
        return nodeType === 3 ? this.nodeValue ?? "" : this.childNodes.map((child) => child.textContent ?? "").join("");
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

  const document: FakeDocument = {
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
    getElementById(id: string): FakeNode | null {
      const visit = (node: FakeNode): FakeNode | null => {
        for (const child of node.childNodes ?? []) {
          if (child.attributes?.get("id") === id) return child;
          const found = visit(child);
          if (found) return found;
        }
        return null;
      };
      return visit(document as unknown as FakeNode);
    },
    createRange: () => ({
      setStart() {},
      setEnd() {},
      createContextualFragment: () => document.createDocumentFragment(),
    }),
    documentElement: null as unknown as FakeNode,
    head: null as unknown as FakeNode,
    body: null as unknown as FakeNode,
    defaultView: null,
  };
  const container = document.createElement("div");
  document.documentElement = document.createElement("html");
  document.head = document.createElement("head");
  document.body = document.createElement("body");
  document.documentElement.appendChild(document.head);
  document.documentElement.appendChild(document.body);
  const originalElementClasses = (globalThis as { Element?: unknown; HTMLElement?: unknown; HTMLIFrameElement?: unknown; SVGElement?: unknown });
  Object.assign(globalThis.window as object, {
    Element,
    HTMLElement,
    HTMLIFrameElement,
    SVGElement,
    document,
    getSelection: () => null,
  });
  // react-aria's press cleanup reads bare global element constructors on unmount.
  (globalThis as Record<string, unknown>).Element = Element;
  (globalThis as Record<string, unknown>).HTMLElement = HTMLElement;
  (globalThis as Record<string, unknown>).HTMLIFrameElement = HTMLIFrameElement;
  (globalThis as Record<string, unknown>).SVGElement = SVGElement;
  document.defaultView = globalThis.window;
  document.documentElement = container;
  (globalThis as Record<string, unknown>).document = document;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as Record<string, unknown>).requestAnimationFrame = () => 1;
  (globalThis as Record<string, unknown>).cancelAnimationFrame = noop;

  t.after(() => {
    const globals = globalThis as Record<string, unknown>;
    if (originalDocument === undefined) delete globals.document;
    else globals.document = originalDocument;
    if (originalActEnvironment === undefined) delete globals.IS_REACT_ACT_ENVIRONMENT;
    else globals.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    if (originalRequestAnimationFrame === undefined) delete globals.requestAnimationFrame;
    else globals.requestAnimationFrame = originalRequestAnimationFrame;
    if (originalCancelAnimationFrame === undefined) delete globals.cancelAnimationFrame;
    else globals.cancelAnimationFrame = originalCancelAnimationFrame;
    if (originalElementClasses.Element === undefined) delete globals.Element;
    else globals.Element = originalElementClasses.Element;
    if (originalElementClasses.HTMLElement === undefined) delete globals.HTMLElement;
    else globals.HTMLElement = originalElementClasses.HTMLElement;
    if (originalElementClasses.HTMLIFrameElement === undefined) delete globals.HTMLIFrameElement;
    else globals.HTMLIFrameElement = originalElementClasses.HTMLIFrameElement;
    if (originalElementClasses.SVGElement === undefined) delete globals.SVGElement;
    else globals.SVGElement = originalElementClasses.SVGElement;
  });

  return container;
}

export interface RendererServerOptions {
  cachePrefix?: string;
  mockModules?: Record<string, string>;
  noExternal?: boolean | string[] | RegExp;
  resolveAlias?: Record<string, string>;
}

// mockModules maps an import-path suffix (e.g. "/utils/logger") to the ESM
// source served in its place.
export async function createRendererServer(t: Pick<TestContext, "after">, { cachePrefix = "openwhispr-renderer-test-", mockModules = {}, noExternal = false, resolveAlias = {} }: RendererServerOptions = {}, createServer?: typeof import("vite").createServer): Promise<ViteDevServer> {
  createServer ??= (await import("vite")).createServer;
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), cachePrefix));
  let vite: ViteDevServer | undefined;
  t.after(async () => {
    try { await vite?.close(); }
    finally { fs.rmSync(cacheDir, { recursive: true, force: true }); }
  });
  const suffixes = Object.keys(mockModules);
  vite = await createServer({
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
        resolveId(source: string) {
          const suffix = suffixes.find((candidate) => source.endsWith(candidate));
          if (suffix) return `\0mock:${suffix}`;
          return null;
        },
        load(id: string) {
          if (!id.startsWith("\0mock:")) return null;
          return mockModules[id.slice("\0mock:".length)];
        },
      },
    ],
    server: { middlewareMode: true },
  });
  return vite;
}

export async function reloadSettingsStore(vite: ViteDevServer): Promise<unknown> {
  const url = "/stores/settingsStore.ts";
  const module = await vite.moduleGraph.getModuleByUrl(url);
  // Vite invalidates this module and its importers; shared dependencies stay cached.
  if (module) vite.moduleGraph.invalidateModule(module);
  return vite.ssrLoadModule(url);
}

// Minimal Web Audio + capture stubs so the mic pipeline can run under Node.
export function installMicCaptureGlobals(t: Pick<TestContext, "after">): void {
  const track = {
    readyState: "live",
    label: "Fake Mic",
    stop() {},
    getSettings: () => ({}) as Record<string, unknown>,
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
    getVideoTracks: () => [] as typeof track[],
  };
  const mediaDevices = {
    getUserMedia: async () => stream,
    enumerateDevices: async () => [] as Array<Record<string, unknown>>,
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
    state = "running";
    currentTime = 0;
    sampleRate: number;
    audioWorklet = { addModule: async () => {} };
    destination = {};
    constructor({ sampleRate = 48_000 }: { sampleRate?: number } = {}) {
      this.sampleRate = sampleRate;
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
    port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (message: unknown) => void };
    constructor(
      _context?: unknown,
      _name?: string,
      options?: { processorOptions?: { sourceGeneration?: number } }
    ) {
      this.port = {
        onmessage: null,
        postMessage: (message) => {
          const request = message as {
            type?: string;
            commandId?: string;
            sourceGeneration?: number;
            effectiveMuted?: boolean;
          };
          if (request?.type === "flush") {
            queueMicrotask(() =>
              this.port.onmessage?.({ data: { type: "flush-complete", lastSequence: -1 } })
            );
          } else if (request?.type === "set-gate") {
            queueMicrotask(() => this.port.onmessage?.({ data: {
              type: "gate-ack",
              commandId: request.commandId,
              sourceGeneration: request.sourceGeneration ?? options?.processorOptions?.sourceGeneration ?? 1,
              effectiveMuted: request.effectiveMuted,
              boundaryRenderFrame: 0,
              lastSequence: -1,
            } }));
          }
        },
      };
    }
    connect() {}
    disconnect() {}
  }

  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  const originalAudioWorkletNode = Object.getOwnPropertyDescriptor(globalThis, "AudioWorkletNode");
  t.after(() => {
    for (const [name, descriptor] of [["navigator", originalNavigator], ["AudioContext", originalAudioContext], ["AudioWorkletNode", originalAudioWorkletNode]] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  });
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "AudioContext", { value: FakeAudioContext, configurable: true, writable: true });
  Object.defineProperty(globalThis, "AudioWorkletNode", { value: FakeAudioWorkletNode, configurable: true, writable: true });
}
