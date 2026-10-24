const { createRequire }: typeof import("node:module") = require("node:module");

const requireRepo = createRequire(require("node:path").resolve(__dirname, "../../package.json"));

const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const React = requireRepo("react");

const { createRoot } = requireRepo("react-dom/client");

const { createRendererServer, installBrowserGlobals, installHookDom, installMicCaptureGlobals } =
  requireRepo(
    "./test/lib/rendererTestHarness.ts"
  ) as typeof import("../lib/rendererTestHarness.js");

type TestContext = import("node:test").TestContext;

interface MeetingStoreModule {
  useMeetingRecordingStore: {
    getState(): { isRecording: boolean };
  };
  startRecording(args: Record<string, unknown>): Promise<boolean>;
  stopRecording(): Promise<{ stopped: boolean }>;
  getMicAnalyser(): unknown;
  getActiveRecordingSessionId(): string | null;
}

type GlobalWithMocks = typeof globalThis & {
  __interruptionToasts?: Array<Record<string, unknown>>;
  __interruptionDismissals?: string[];
};

const mocks = globalThis as GlobalWithMocks;

type FakeDocument = typeof globalThis.document & {
  visibilityState: string;
  hidden: boolean;
  hasFocus(): boolean;
};

const fakeDoc = () => globalThis.document as FakeDocument;

let vitePromise: Promise<import("vite").ViteDevServer> | undefined;

const cleanup: Array<() => Promise<void>> = [];

test.after(async () => {
  for (const close of cleanup) await close();
});

function getVite() {
  return (vitePromise ??= createRendererServer(
    { after: (close: () => Promise<void>) => cleanup.push(close) } as unknown as TestContext,
    {
      cachePrefix: "pr2040-renderer-warning-review-",
      mockModules: {
        "/ui/useToast": `const toast = (props) => { globalThis.__interruptionToasts.push({ ...props, visibility: globalThis.document.visibilityState }); return String(globalThis.__interruptionToasts.length); }; const dismiss = (id) => globalThis.__interruptionDismissals.push(id); export const useToast = () => ({ toast, dismiss });`,
      },
    }
  ));
}

interface InterruptionListeners {
  interrupted: ((details: Record<string, unknown>) => void) | null;
  resumed: (() => void) | null;
}

async function setup(t: TestContext) {
  let root: ReturnType<typeof createRoot> | undefined;
  let store: MeetingStoreModule | undefined;
  t.after(async () => {
    if (store) await React.act(async () => store!.stopRecording());

    if (root) await React.act(async () => root.unmount());
    delete (mocks as { __interruptionToasts?: unknown }).__interruptionToasts;
    delete (mocks as { __interruptionDismissals?: unknown }).__interruptionDismissals;
  });
  const listeners: InterruptionListeners = { interrupted: null, resumed: null };
  const noop = () => () => {};

  const api = {
    checkSystemAudioAccess: async () => ({
      granted: true,
      status: "granted",
      mode: "native",
      strategy: "native",
    }),
    onMeetManualMute: () => () => {},
    onMeetPlatformMute: () => () => {},
    getActions: async () => [],
    meetingTranscriptionStart: async () => ({
      success: true,
      recordingId: "00000000-0000-4000-8000-000000000001",
      originAt: new Date().toISOString(),
      systemAudioMode: "native",
      systemAudioStrategy: "native",
    }),
    meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
    meetingTranscriptionStop: async () => ({ success: true }),
    meetingTranscriptionSend() {},
    onMeetingTranscriptionSegment: noop,
    onMeetingSpeakerIdentified: noop,
    onMeetingSpeakersMerged: noop,
    onMeetingSessionSpeakerConfigUpdated: noop,
    onMeetingTranscriptionError: noop,
    onMeetingTranscriptionFatalError: noop,
    onMeetingSystemAudioSilent: noop,
    onMeetingSystemAudioInterrupted(callback: (details: Record<string, unknown>) => void) {
      listeners.interrupted = callback;

      return () => {
        if (listeners.interrupted === callback) listeners.interrupted = null;
      };
    },
    onMeetingSystemAudioResumed(callback: () => void) {
      listeners.resumed = callback;

      return () => {
        if (listeners.resumed === callback) listeners.resumed = null;
      };
    },
  };

  installBrowserGlobals(t, { window: { electronAPI: api } });
  installMicCaptureGlobals(t);
  const container = installHookDom(t);
  fakeDoc().visibilityState = "visible";
  fakeDoc().hidden = false;
  let focused = true;
  fakeDoc().hasFocus = () => focused;
  const events = new Map<string, () => void>();

  for (const target of [globalThis.window, globalThis.document] as Array<{
    addEventListener: (n: string, cb: () => void) => void;
    removeEventListener: (n: string, cb: () => void) => void;
  }>) {
    target.addEventListener = (name: string, callback: () => void) => events.set(name, callback);
    target.removeEventListener = (name: string, callback: () => void) => {
      if (events.get(name) === callback) events.delete(name);
    };
  }

  const focus = async (value: boolean) => {
    focused = value;
    await React.act(async () => events.get("focus")?.());
  };

  const reveal = async () => {
    fakeDoc().hidden = false;
    fakeDoc().visibilityState = "visible";
    await React.act(async () => events.get("visibilitychange")?.());
  };

  mocks.__interruptionToasts! = [];
  mocks.__interruptionDismissals! = [];
  const vite = await getVite();

  for (const url of [
    "/components/MeetingRecordingMount.tsx",
    "/stores/meetingRecordingStore.ts",
    "/i18n.ts",
  ]) {
    const module = await vite.moduleGraph.getModuleByUrl(url);

    if (module) vite.moduleGraph.invalidateModule(module);
  }

  const { default: Mount } = (await vite.ssrLoadModule(
    "/components/MeetingRecordingMount.tsx"
  )) as { default: import("react").ComponentType };

  store = (await vite.ssrLoadModule("/stores/meetingRecordingStore.ts")) as MeetingStoreModule;
  root = createRoot(container as unknown as Element);

  const render = async (visible: boolean, strict = false) =>
    React.act(async () =>
      root.render(
        visible
          ? strict
            ? React.createElement(React.StrictMode, null, React.createElement(Mount))
            : React.createElement(Mount)
          : null
      )
    );

  await render(true);
  await React.act(async () =>
    store.startRecording({ noteId: null, noteTitle: null, folderId: null, autoEndEligible: false })
  );
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, true);

  const interrupt = async (details: Record<string, unknown> = {}) =>
    React.act(async () =>
      listeners.interrupted!({
        systemAudioStrategy: "native",
        reason: "no_audio_delivered",
        recovering: false,
        ...details,
      })
    );

  const { default: i18n } = (await vite.ssrLoadModule("/i18n.ts")) as {
    default: { changeLanguage(lang: string): Promise<unknown> };
  };

  const resume = async () => React.act(async () => listeners.resumed!());

  return { store, render, interrupt, resume, focus, reveal, i18n };
}

test("audio resuming while hidden discards the quiet warning before focus", async (t: TestContext) => {
  const { interrupt, resume, focus, reveal } = await setup(t);
  fakeDoc().visibilityState = "hidden";
  await focus(false);
  await interrupt({ reason: "gone_quiet" });
  await resume();
  await reveal();
  await focus(true);
  assert.equal(mocks.__interruptionToasts!.length, 0);
});

test("audio resuming with Mount absent clears its pending quiet warning", async (t: TestContext) => {
  const { render, interrupt, resume } = await setup(t);
  await render(false);
  await interrupt({ reason: "gone_quiet" });
  await resume();
  await render(true);
  assert.equal(mocks.__interruptionToasts!.length, 0);
});

test("audio resuming dismisses a visible quiet warning even after unmount", async (t: TestContext) => {
  const { render, interrupt, resume } = await setup(t);
  await interrupt({ reason: "gone_quiet" });
  assert.equal(mocks.__interruptionToasts!.length, 1);
  await render(false);
  await resume();
  assert.deepEqual(mocks.__interruptionDismissals!, ["1"]);
  await render(true);
  assert.equal(mocks.__interruptionToasts!.length, 1);
});

test("hidden and covered warnings wait for a focused visible window", async (t: TestContext) => {
  const { interrupt, focus, reveal } = await setup(t);
  fakeDoc().hidden = true;
  fakeDoc().visibilityState = "hidden";
  await interrupt();
  assert.equal(mocks.__interruptionToasts!.length, 0);
  await focus(false);
  await reveal();
  assert.equal(mocks.__interruptionToasts!.length, 0);
  await focus(true);
  assert.equal(mocks.__interruptionToasts!.length, 1);
  assert.equal(mocks.__interruptionToasts![0].duration, 0);
});

test("unmounted events deliver once on remount and repeated events replace the warning", async (t: TestContext) => {
  const { store, render, interrupt } = await setup(t);
  const analyser = store.getMicAnalyser();
  const sessionId = store.getActiveRecordingSessionId();
  assert.ok(analyser);
  await render(false);
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, true);
  assert.equal(store.getMicAnalyser(), analyser, "unmount keeps the recording-owned graph alive");
  await interrupt();
  await render(true);
  assert.equal(store.getActiveRecordingSessionId(), sessionId);
  assert.equal(store.getMicAnalyser(), analyser, "remount uses the same microphone graph");
  assert.equal(mocks.__interruptionToasts!.length, 1);
  await render(true);
  assert.equal(mocks.__interruptionToasts!.length, 1);
  await render(false);
  assert.equal(mocks.__interruptionDismissals!.length, 0);
  await render(true);
  assert.equal(mocks.__interruptionToasts!.length, 1);
  await interrupt();
  assert.equal(mocks.__interruptionToasts!.length, 2);
});

test("persistent warning offers a scoped stop and does not leak into the next session", async (t: TestContext) => {
  const { store, interrupt, render } = await setup(t);
  await interrupt();

  const warning = mocks.__interruptionToasts![0] as {
    duration: number;
    action: { props: { onClick(): void } };
  };

  assert.equal(warning.duration, 0);
  assert.ok(warning.action);
  await React.act(async () => warning.action.props.onClick());
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
  await React.act(async () =>
    store.startRecording({ noteId: null, noteTitle: null, folderId: null, autoEndEligible: false })
  );
  await React.act(async () => warning.action.props.onClick());
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, true);
  await render(false);
  await render(true);
  assert.equal(mocks.__interruptionToasts!.length, 1);
});

test("stop before returning discards an unseen interruption", async (t: TestContext) => {
  const { store, interrupt, focus, render } = await setup(t);
  await focus(false);
  await interrupt();
  await React.act(async () => store.stopRecording());
  await focus(true);
  await render(false);
  await render(true);
  assert.equal(mocks.__interruptionToasts!.length, 0);
});

test("latest pending event delivers once and cautious warnings do not offer stop", async (t: TestContext) => {
  const { interrupt, focus } = await setup(t);
  await focus(false);
  await interrupt();
  await interrupt({ reason: "gone_quiet" });
  await focus(true);
  assert.equal(mocks.__interruptionToasts!.length, 1);
  assert.equal(mocks.__interruptionToasts![0].title, "Meeting audio has gone quiet");
  assert.equal(mocks.__interruptionToasts![0].action, undefined);
  await interrupt({ recovering: true });
  assert.deepEqual(mocks.__interruptionDismissals!, ["1"]);
  assert.equal(mocks.__interruptionToasts![1]!.title, "Meeting audio interrupted");
  assert.equal(mocks.__interruptionToasts![1]!.action, undefined);
  assert.equal(mocks.__interruptionToasts![1]!.duration, 8000);
});

test("locale changes do not replay delivered interruptions", async (t: TestContext) => {
  const { interrupt, i18n } = await setup(t);
  await interrupt();

  try {
    await React.act(async () => i18n.changeLanguage("es"));
    assert.equal(mocks.__interruptionToasts!.length, 1);
  } finally {
    await React.act(async () => i18n.changeLanguage("en"));
  }
});

test("StrictMode does not replay or dismiss a delivered persistent warning", async (t: TestContext) => {
  const { interrupt, render } = await setup(t);
  await interrupt();
  await render(false);
  await render(true, true);
  assert.equal(mocks.__interruptionToasts!.length, 1);
  assert.equal(mocks.__interruptionDismissals!.length, 0);
});

test("replacement while hidden dismisses the old warning and remains pending", async (t: TestContext) => {
  const { interrupt, focus } = await setup(t);
  await interrupt();
  await focus(false);
  await interrupt();
  assert.deepEqual(mocks.__interruptionDismissals!, ["1"]);
  assert.equal(mocks.__interruptionToasts!.length, 1);
  await focus(true);
  assert.equal(mocks.__interruptionToasts!.length, 2);
});

test("stopping with Mount absent removes its persistent warning", async (t: TestContext) => {
  const { store, interrupt, render } = await setup(t);
  await interrupt();
  await render(false);
  await React.act(async () => store.stopRecording());
  assert.deepEqual(mocks.__interruptionDismissals!, ["1"]);
});
