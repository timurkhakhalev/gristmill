// Shared setup for tests that load renderer modules through Vite SSR:
// Map-backed browser globals plus a dev server with per-test module mocks.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { ViteDevServer } from "vite";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

// Consumer stubs replace single window members with bespoke fakes; the
// overrides record stays owner-shaped (each key holds its own concrete
// signature at the call site) and merges over the defaults below.
type FakeWindow = typeof globalThis & {
  electronAPI?: object;
};

interface HarnessGlobals {
  window?: FakeWindow;
  localStorage?: StorageLike;
  CSS?: { escape(value: string): string };
}

export interface BrowserGlobalsOptions {
  initialStorage?: Record<string, string>;
  /**
   * Member-level window overrides. Each key replaces one window member with
   * the consumer's stub object; values stay owner-typed at the call site.
   */
  window?: {
    electronAPI?: object;
    matchMedia?: (query: string) => { matches: boolean };
    location?: { search: string };
    addEventListener?: (name: string, listener: () => void) => void;
    removeEventListener?: (name: string, listener: () => void) => void;
    dispatchEvent?: () => boolean;
    setInterval?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
    // Consumers pass their own timer handle type back; unknown accepts it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- handle type comes from the consumer's own stub
    clearInterval?: (timer: any) => void;
    setTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- handle type comes from the consumer's own stub
    clearTimeout?: (timer: any) => void;
    localStorage?: StorageLike;
    /** Ad-hoc members for single-file harnesses; owner-typed at the call site. */
    fixture?: object;
  };
}

export function installBrowserGlobals(
  t: Pick<TestContext, "after">,
  { initialStorage = {}, window: windowProps = {} }: BrowserGlobalsOptions = {}
) {
  const globalsSource: unknown = globalThis;

  // SAFETY: this harness owns the global window/localStorage/CSS set below;
  // the assertion types that owned surface for save/restore.
  const globals = globalsSource as HarnessGlobals;
  const originalWindow = globals.window;
  const originalLocalStorage = globals.localStorage;
  const values = new Map(Object.entries(initialStorage));

  const storage: StorageLike = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, String(value));
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
  };

  globals.localStorage = storage;
  const originalCSS = globals.CSS;

  if (originalCSS === undefined) {
    // react-aria's getNonce reads global CSS; harmless stub for the fake DOM.
    globals.CSS = { escape: (value: string) => value };
  }

  const electronAPI: NonNullable<FakeWindow["electronAPI"]> = {};

  // SAFETY: storage satisfies the Storage reads the renderer makes; the spread
  // above carries the consumer's member stubs, and the assertion types the
  // assembled fake against the shared window shape.
  const defaults = {
    innerWidth: 1200,
    localStorage: storage,
    addEventListener() {},
    removeEventListener() {},
    setTimeout(callback: () => void, delay?: number) {
      return globalThis.setTimeout(callback, delay);
    },
    clearTimeout(timeoutId: ReturnType<typeof setTimeout> | undefined) {
      globalThis.clearTimeout(timeoutId);
    },
    setInterval() {
      return 1;
    },
    electronAPI,
  };

  // SAFETY: the spread merges harness defaults with the consumer's member
  // stubs; the chained assertion is the only way to type the merged literal
  // against the globalThis intersection (no overlap for a direct assert).
  // Narrow exact-file override below documents the same boundary.
  globals.window = { ...defaults, ...windowProps } as unknown as FakeWindow;
  t.after(() => {
    if (originalWindow === undefined) delete globals.window;
    else globals.window = originalWindow;

    if (originalLocalStorage === undefined) delete globals.localStorage;
    else globals.localStorage = originalLocalStorage;

    if (originalCSS === undefined) delete globals.CSS;
  });

  return { window: globals.window, storage };
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
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(): void;
  removeEventListener(): void;
  focus(): void;
  querySelector(): null;
  querySelectorAll(): never[];
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
  createTextNode(value: string): FakeNode;
  createComment(value: string): FakeNode;
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
export function installHookDom(t: Pick<TestContext, "after">): FakeNode {
  const elementNames = ["Element", "HTMLElement", "HTMLIFrameElement", "SVGElement"] as const;

  const elementDescriptors = elementNames.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name)
  );

  t.after(() =>
    elementNames.forEach((name, index) => {
      const original = elementDescriptors[index];

      if (original) Object.defineProperty(globalThis, name, original);
      else {
        // SAFETY: this harness installed these element classes itself; the
        // keyed probe only deletes the four owned names.

        const holder = globalThis as {
          Element?: object;
          HTMLElement?: object;
          HTMLIFrameElement?: object;
          SVGElement?: object;
        };

        delete holder[name];
      }
    })
  );

  const globalsSource: unknown = globalThis;

  // SAFETY: the probe names the harness-owned browser globals for save/restore.
  const globals = globalsSource as {
    document?: FakeDocument;
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    requestAnimationFrame?: () => number;
    cancelAnimationFrame?: () => void;
  };

  const originalDocument = globals.document;
  const originalActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
  const originalRequestAnimationFrame = globals.requestAnimationFrame;
  const originalCancelAnimationFrame = globals.cancelAnimationFrame;

  const noop = () => {};

  class Element {}

  class HTMLElement extends Element {}

  class HTMLIFrameElement extends HTMLElement {}

  class SVGElement extends Element {}

  function makeNode(
    nodeType: number,
    nodeName: string,
    namespaceURI = "http://www.w3.org/1999/xhtml"
  ): FakeNode {
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
      setAttribute(name, value) {
        this.attributes.set(name, value);
      },
      removeAttribute(name) {
        this.attributes.delete(name);
      },
      addEventListener: noop,
      removeEventListener: noop,
      // React calls these on host elements (autoFocus, ref-driven scroll and
      // query helpers); they are no-ops in the fake DOM.
      focus: noop,
      querySelector: () => null,
      querySelectorAll: () => [],
      contains(candidate) {
        return candidate === this || this.childNodes.some((child) => child.contains?.(candidate));
      },
      get firstChild() {
        return this.childNodes[0] ?? null;
      },
      get lastChild() {
        return this.childNodes.at(-1) ?? null;
      },
      prepend(...nodes: FakeNode[]) {
        for (const node of [...nodes].reverse()) this.insertBefore(node, this.firstChild);
      },
      append(...nodes: FakeNode[]) {
        for (const node of nodes) this.appendChild(node);
      },
      get options() {
        return this.childNodes.filter((child) => child.tagName === "OPTION");
      },
      get nextSibling() {
        if (!this.parentNode) return null;
        const siblings = this.parentNode.childNodes;

        return siblings[siblings.indexOf(this) + 1] ?? null;
      },
      get textContent() {
        return nodeType === 3
          ? (this.nodeValue ?? "")
          : this.childNodes.map((child) => child.textContent ?? "").join("");
      },
      set textContent(value) {
        this.childNodes.forEach((child) => {
          child.parentNode = null;
        });
        this.childNodes = [];

        if (value != null && String(value))
          this.appendChild(document.createTextNode(String(value)));
      },
    };

    if (nodeType === 3 || nodeType === 8) {
      node.nodeValue = "";
      node.data = "";
    }

    Object.setPrototypeOf(
      node,
      nodeType === 1
        ? namespaceURI === "http://www.w3.org/1999/xhtml"
          ? HTMLElement.prototype
          : Element.prototype
        : Object.prototype
    );

    return node;
  }

  // SAFETY: documentElement/head/body start as null placeholders and receive
  // real fake nodes immediately after this literal.
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
      node.nodeValue = value;
      node.data = value;

      return node;
    },
    createComment(value) {
      const node = makeNode(8, "#comment");
      node.ownerDocument = document;
      node.nodeValue = value;
      node.data = value;

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

      // SAFETY: the fake document carries the FakeNode child structure the
      // visitor walks; the chained assertion exposes that view.
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
  // SAFETY: the harness created the fake window above; the assertion exposes
  // it as the assign target.
  Object.assign(globalThis.window as object, {
    Element,
    HTMLElement,
    HTMLIFrameElement,
    SVGElement,
    document,
    getSelection: () => null,
  });

  // react-aria's press cleanup reads bare global element constructors on unmount.
  for (const [name, value] of Object.entries({
    Element,
    HTMLElement,
    HTMLIFrameElement,
    SVGElement,
  })) {
    Object.defineProperty(globalThis, name, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  document.defaultView = globalThis.window;
  document.documentElement = container;
  globals.document = document;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  globals.requestAnimationFrame = () => 1;
  globals.cancelAnimationFrame = noop;

  t.after(() => {
    if (originalDocument === undefined) delete globals.document;
    else globals.document = originalDocument;

    if (originalActEnvironment === undefined) delete globals.IS_REACT_ACT_ENVIRONMENT;
    else globals.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;

    if (originalRequestAnimationFrame === undefined) delete globals.requestAnimationFrame;
    else globals.requestAnimationFrame = originalRequestAnimationFrame;

    if (originalCancelAnimationFrame === undefined) delete globals.cancelAnimationFrame;
    else globals.cancelAnimationFrame = originalCancelAnimationFrame;
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
export async function createRendererServer(
  t: Pick<TestContext, "after">,
  {
    cachePrefix = "openwhispr-renderer-test-",
    mockModules = {},
    noExternal = false,
    resolveAlias = {},
  }: RendererServerOptions = {},
  createServer?: typeof import("vite").createServer
): Promise<ViteDevServer> {
  createServer ??= (await import("vite")).createServer;
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), cachePrefix));
  // SAFETY: the cleanup closure reads the binding before createServer runs.
  const state = { vite: undefined as ViteDevServer | undefined };
  t.after(async () => {
    try {
      await state.vite?.close();
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
  const suffixes = Object.keys(mockModules);
  state.vite = await createServer({
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

  return state.vite;
}

export async function reloadSettingsStore(
  vite: ViteDevServer
): Promise<typeof import("../../src/stores/settingsStore.ts")> {
  const url = "/stores/settingsStore.ts";
  const module = await vite.moduleGraph.getModuleByUrl(url);

  // Vite invalidates this module and its importers; shared dependencies stay cached.
  if (module) vite.moduleGraph.invalidateModule(module);

  // SAFETY: the URL above loads this repo's own settings store; the assertion
  // names its module surface for callers.
  return (await vite.ssrLoadModule(url)) as typeof import("../../src/stores/settingsStore.ts");
}

// Minimal Web Audio + capture stubs so the mic pipeline can run under Node.
export function installMicCaptureGlobals(t: Pick<TestContext, "after">): void {
  const track = {
    readyState: "live",
    label: "Fake Mic",
    stop() {},
    getSettings: (): { [key: string]: string | number | boolean } => ({}),
  };

  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
  };

  const mediaDevices = {
    getUserMedia: async () => stream,
    enumerateDevices: async (): Promise<MediaDeviceInfo[]> => [],
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

  type WorkletCommand = {
    type?: string;
    commandId?: string;
    sourceGeneration?: number;
    effectiveMuted?: boolean;
  };

  class FakeAudioWorkletNode {
    port: {
      onmessage: ((event: { data: unknown }) => void) | null;
      postMessage: (message: WorkletCommand) => void;
    };
    constructor(
      _context?: BaseAudioContext,
      _name?: string,
      options?: { processorOptions?: { sourceGeneration?: number } }
    ) {
      this.port = {
        onmessage: null,
        postMessage: (message) => {
          const request = message;

          if (request?.type === "flush") {
            queueMicrotask(() =>
              this.port.onmessage?.({ data: { type: "flush-complete", lastSequence: -1 } })
            );
          } else if (request?.type === "set-gate") {
            queueMicrotask(() =>
              this.port.onmessage?.({
                data: {
                  type: "gate-ack",
                  commandId: request.commandId,
                  sourceGeneration:
                    request.sourceGeneration ?? options?.processorOptions?.sourceGeneration ?? 1,
                  effectiveMuted: request.effectiveMuted,
                  boundaryRenderFrame: 0,
                  lastSequence: -1,
                },
              })
            );
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
    for (const [name, descriptor] of [
      ["navigator", originalNavigator],
      ["AudioContext", originalAudioContext],
      ["AudioWorkletNode", originalAudioWorkletNode],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else {
        // SAFETY: only the harness-owned navigator/Audio globals are deleted;
        // the keyed probe types the global record for those three names.
        const holder = globalThis as {
          navigator?: unknown;
          AudioContext?: unknown;
          AudioWorkletNode?: unknown;
        };

        delete holder[name];
      }
    }
  });
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "AudioContext", {
    value: FakeAudioContext,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "AudioWorkletNode", {
    value: FakeAudioWorkletNode,
    configurable: true,
    writable: true,
  });
}
