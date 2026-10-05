const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test") = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
  reloadSettingsStore,
} = require("../lib/rendererTestHarness.ts");

let vitePromise;
const cleanup: Array<() => Promise<void>> = [];
test.after(async () => {
  for (const close of cleanup) await close();
});

// The onboarding session is plain-text localStorage, while every one of these is a
// safeStorage secret. Named literally so a leak shows up as the value, not just as
// an unexpected key.
const SECRETS = {
  openaiApiKey: "sk-leaked-openai-key",
  cortiClientId: "leaked-corti-client-id",
  cortiClientSecret: "leaked-corti-client-secret",
  customTranscriptionApiKey: "leaked-custom-transcription-key",
  chatAgentCustomApiKey: "leaked-chat-agent-key",
};

const ALLOWED_DRAFT_KEYS = ["baseUrl", "customModel", "selectedModel", "selectedProvider"];

interface ResumeState { selectedProvider: string; selectedModel: string; baseUrl: string; customModel: string; }
type DraftOptions = { selfHostedRequested: boolean; resumeState?: ResumeState };

const capturedConfigs: Array<Record<string, unknown>> = [];
const capturedDrafts: Array<Record<string, unknown>> = [];

function captureConnectionConfig(config: Record<string, unknown>) {
  capturedConfigs.push(config);
}

async function setupByokStep(t: import("node:test").TestContext, { selfHostedRequested, resumeState }: DraftOptions, storeOverrides: Record<string, unknown> = {}) {
  capturedConfigs.length = 0;
  capturedDrafts.length = 0;
  installBrowserGlobals(t, {
    window: { electronAPI: { getPlatform: () => "linux" } },
  });
  const vite = await (vitePromise ??= createRendererServer({ after: (close: () => Promise<void>) => cleanup.push(close) } as unknown as import("node:test").TestContext, {
    cachePrefix: "openwhispr-byok-resume-draft-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export function useTranslation() { return { t }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
      "/ProviderConnectionTest": `
        export default function ProviderConnectionTest({ config }) {
          globalThis.__gristmillTestCaptureConnectionConfig(config);
          return null;
        }
      `,
      "/OnboardingShell": `export function BrandMark() { return null; }`,
      "/ui/ProviderIcon": `export function ProviderIcon() { return null; }`,
      "/ui/SelectField": `export function SelectField() { return null; }`,
      // The step's child resolves here: render the REAL connection test while
      // recording its props, so the run-test click is drivable and the
      // parent+child pair is the production one.
      "./ProviderConnectionTest": `
        import React from "react";
        let lastSuccess = null;
        export default function ProviderConnectionTest(props) {
          globalThis.__realPairChildProps = props;
          if (lastSuccess !== null && lastSuccess !== props.onSuccessChange) {
          }
          lastSuccess = props.onSuccessChange;
          const Real = globalThis.__RealConnectionTest;
          return Real ? React.createElement(Real, props) : null;
        }
      `,
      // The connection-test button is drivable through this capture: every
      // Button's onClick lands here.
      "../ui/button": `
        import React from "react";
        export function Button({ children, onClick, disabled, ...rest }) {
          globalThis.__realPairButtons = globalThis.__realPairButtons || [];
          const handlers = globalThis.__realPairButtons;
          const index = handlers.length;
          handlers.push({ children, onClick, disabled });
          return React.createElement("button", {
            onClick: () => { if (!disabled) handlers[index].onClick?.(); },
            ...rest,
          }, children);
        }
      `,
    },
  }));
  (globalThis as Record<string, unknown>).__gristmillTestCaptureConnectionConfig = captureConnectionConfig;
  const { useSettingsStore } = await reloadSettingsStore(vite);
  useSettingsStore.setState({ ...SECRETS, ...storeOverrides });
  const { ByokProviderStep } = await vite.ssrLoadModule(
    "/components/onboarding/ProviderSetupStep.tsx"
  );

  function Harness() {
    // Render the real tree into installHookDom's inert fake DOM: the mock
    // ProviderConnectionTest captures its config, and the draft callback fires
    // on unmount. Everything rendering is either mocked above or a plain DOM
    // element; nothing native runs.
    return ByokProviderStep({
      selfHostedRequested,
      resumeState,
      onSelfHostedChange() {},
      onConnectionChange() {},
      onProceed() {},
      onResumeStateChange: (draft: Record<string, unknown>) => capturedDrafts.push(draft),
    });
  }
  const root = createRoot(installHookDom(t) as unknown as Element);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });
  return {
    drafts: capturedDrafts,
    unmount: async () => {
      // Unmounting flushes the latest draft — the same path the step takes when
      // onboarding advances past it.
      await React.act(async () => root.unmount());
    },
  };
}

// Self-hosted onboarding (issue #181): the connection-test payload must carry
// the drafted key instead of the pre-fix hardcoded "", and an empty draft must
// stay a valid anonymous config. The initial draft key comes from the store's
// provider credential, so the captured payload asserts on it directly.
test("the self-hosted connection test payload carries the drafted API key", async (t: import("node:test").TestContext) => {
  const ui = await setupByokStep(t, { selfHostedRequested: true });
  try {
    assert.ok(capturedConfigs.length > 0, "the connection test receives a config");
    const latest = capturedConfigs[capturedConfigs.length - 1];
    assert.equal(latest.provider, "custom", "self-hosted tests probe the custom route");
    assert.equal(latest.apiKey, SECRETS.openaiApiKey, "the drafted key reaches the IPC payload");
    assert.equal(typeof latest.baseUrl, "string");
  } finally {
    await ui.unmount();
  }
});

test("an empty key keeps the self-hosted payload anonymous-compatible", async (t: import("node:test").TestContext) => {
  const ui = await setupByokStep(t, { selfHostedRequested: true }, { openaiApiKey: "" });
  try {
    const latest = capturedConfigs[capturedConfigs.length - 1];
    assert.equal(latest.apiKey, "", "an empty key is passed through, not dropped");
  } finally {
    await ui.unmount();
  }
});

// Each case exercises the draft boundary without exposing any credential value.
for (const [name, options] of [
  [
    "a hosted provider",
    {
      selfHostedRequested: false,
      resumeState: { selectedProvider: "openai", selectedModel: "", baseUrl: "", customModel: "" },
    },
  ],
  ["a self-hosted endpoint", { selfHostedRequested: true }],
]) {
  test(`the resume draft for ${name} carries no credential`, async (t: import("node:test").TestContext) => {
    const ui = await setupByokStep(t, options as DraftOptions);
    try {
      assert.ok(capturedConfigs.length > 0, "the connection test receives a config");
    } finally {
      await ui.unmount();
    }

    const drafts = ui.drafts;
    assert.ok(drafts.length > 0, "the step persists a draft so the session can restore it");
    for (const draft of drafts) {
      assert.deepEqual(
        Object.keys(draft).sort(),
        ALLOWED_DRAFT_KEYS,
        "a draft may only carry the four fields the session schema declares"
      );
      const serialized = JSON.stringify(draft);
      for (const [field, secret] of Object.entries(SECRETS)) {
        assert.doesNotMatch(serialized, new RegExp(secret), `${field} reached the draft`);
      }
    }
  });
}

// The real parent+child pair: ByokProviderStep renders the REAL
// ProviderConnectionTest (mock testProviderConnection IPC instead), the
// OnboardingFlow-style footer holds the step's commit via the render-time
// handoff, and captures Proceed/save calls for the assertions.
async function setupRealPair(
  t: import("node:test").TestContext,
  { testResult, captured = false, saveFailsAfter: _saveFailsAfter, saveResult, selfHosted = true }: {
    testResult: Record<string, unknown> | undefined;
    captured?: boolean;
    saveFailsAfter?: number;
    saveResult?: Promise<{ success: boolean }>;
    selfHosted?: boolean;
  }
) {
  // A fresh server: the earlier tests' cached one maps /ProviderConnectionTest
  // to a config-capture stub, and module graphs can't be re-mapped.
  const vite = await createRendererServer({ after: (close: () => Promise<void>) => cleanup.push(close) } as unknown as import("node:test").TestContext, {
    cachePrefix: "openwhispr-byok-real-pair-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export function useTranslation() { return { t }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
      "/OnboardingShell": `export function BrandMark() { return null; }`,
      "/ui/ProviderIcon": `export function ProviderIcon() { return null; }`,
      "/ui/SelectField": `export function SelectField() { return null; }`,
      // The step's child resolves here: render the REAL connection test while
      // recording its props, so the run-test click is drivable and the
      // parent+child pair is the production one.
      "./ProviderConnectionTest": `
        import React from "react";
        let lastSuccess = null;
        export default function ProviderConnectionTest(props) {
          globalThis.__realPairChildProps = props;
          if (lastSuccess !== null && lastSuccess !== props.onSuccessChange) {
          }
          lastSuccess = props.onSuccessChange;
          const Real = globalThis.__RealConnectionTest;
          return Real ? React.createElement(Real, props) : null;
        }
      `,
      // The connection-test button is drivable through this capture: every
      // Button's onClick lands here.
      "../ui/button": `
        import React from "react";
        export function Button({ children, onClick, disabled, ...rest }) {
          globalThis.__realPairButtons = globalThis.__realPairButtons || [];
          const handlers = globalThis.__realPairButtons;
          const index = handlers.length;
          handlers.push({ children, onClick, disabled });
          return React.createElement("button", {
            onClick: () => { if (!disabled) handlers[index].onClick?.(); },
            ...rest,
          }, children);
        }
      `,
    },
  });
  const { useSettingsStore } = await reloadSettingsStore(vite);
  useSettingsStore.setState({
    ...SECRETS,
    // Confirmed secure save (the step's Proceed/footer both require it).
    setCustomTranscriptionApiKey: async (key: string) => {
      savedKeys.push("custom");
      void key;
      if (saveResult) return await saveResult;
      if (_saveFailsAfter != null && savedKeys.length > _saveFailsAfter) {
        return { success: false };
      }
      return { success: true };
    },
    setOpenaiApiKey: async () => { savedKeys.push("openai"); return saveResult ? await saveResult : { success: true }; },
    cloudTranscriptionProvider: "openai",
    setCloudTranscriptionBaseUrl: (value: unknown) => { routeChanges.push(value); },
    setCloudTranscriptionModel: (value: unknown) => { routeChanges.push(value); },
    setCloudTranscriptionProvider: (value: unknown) => { routeChanges.push(value); },
    setCloudTranscriptionMode: (value: unknown) => { routeChanges.push(value); },
  });
  const { default: RealConnectionTest } = await vite.ssrLoadModule(
    "/components/onboarding/ProviderConnectionTest.tsx"
  ) as { default: (props: Record<string, unknown>) => unknown };
  (globalThis as Record<string, unknown>).__RealConnectionTest = RealConnectionTest;
  const { ByokProviderStep } = await vite.ssrLoadModule(
    "/components/onboarding/ProviderSetupStep.tsx"
  );

  let releaseTest: ((value: Record<string, unknown>) => void) | undefined;
  let pendingTest: Promise<Record<string, unknown>> | null = null;
  const routeChanges: unknown[] = [];
  const proceeds: string[] = [];
  const savedKeys: unknown[] = [];
  let footerCommit: (() => Promise<void>) | null = null;
  const state = { connected: false, saveError: false };
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPlatform: () => "linux",
        testProviderConnection: async (config: Record<string, unknown>) => {
          if (captured) captureConnectionConfig(config);
          if (testResult) return testResult;
          if (!pendingTest) {
            pendingTest = new Promise((resolve) => { releaseTest = resolve; });
          }
          return pendingTest;
        },
        saveCustomTranscriptionKey: async () => {
            savedKeys.push("custom");
          return { success: true };
        },
      },
    },
  });

  const capturedTree: { tree: unknown } = { tree: null };
  let rerender: (() => void) | undefined;
  const root = createRoot(installHookDom(t) as unknown as Element);
  await React.act(async () => {
    function Harness() {
      const [, force] = React.useState(0);
      rerender = () => force((value: number) => value + 1);
      // Stable identity, like OnboardingFlow's setProviderConnected: an
      // unstable onConnectionChange would itself reset the child (issue #180).
      const onConnectionChange = React.useCallback((connected: boolean) => {
        state.connected = connected;
      }, []);
      // The tree is built against a re-mapped module graph: ProviderConnectionTest
      // resolves to the capture wrapper (below), not the plain import.
      capturedTree.tree = ByokProviderStep({
        selfHostedRequested: selfHosted,
        resumeState: selfHosted ? { selectedProvider: "", selectedModel: "", baseUrl: "https://example.invalid", customModel: "model" } : { selectedProvider: "openai", selectedModel: "whisper-1", baseUrl: "", customModel: "" },
        onSelfHostedChange() {},
        onConnectionChange: onConnectionChange,
        onProceed() { proceeds.push("proceed"); },
        onFooterContinue(commit: () => Promise<void>) {
          footerCommit = commit;
        },
        onResumeStateChange() {},
      });
      return capturedTree.tree;
    }
    root.render(React.createElement(Harness));
    await Promise.resolve();
  });

  const findNodes = (node: unknown, predicate: (n: { props?: Record<string, unknown> }) => boolean, depth = 0): Array<{ props?: Record<string, unknown> }> => {
    if (Array.isArray(node)) return node.flatMap((item) => findNodes(item, predicate, depth));
    if (!node || typeof node !== "object") return [];
    const n = node as { props?: Record<string, unknown>; type?: unknown };
    const found = predicate(n) ? [n] : [];
    // Unwrap one function-component level (e.g. the connection-test child).
    if (typeof n.type === "function" && depth < 2) {
      try {
        return [...found, ...findNodes((n.type as (props: unknown) => unknown)(n.props), predicate, depth + 1)];
      } catch {
        // Hooks-only component: leave it unexpanded.
      }
    }
    return [ ...found, ...Object.values(n.props ?? {}).flatMap((value) => findNodes(value, predicate, depth)) ];
  };
  const textOf = (value: unknown): string => {
    if (Array.isArray(value)) return value.map(textOf).join("");
    if (!value || typeof value !== "object") return typeof value === "string" || typeof value === "number" ? String(value) : "";
    const props = (value as { props?: { children?: unknown } }).props;
    return textOf(props?.children);
  };

  // The real child renders its own host nodes into the fake DOM (the wrapper
  // above maps the step's child to the real component). Walk the host tree.
  const walkDom = (node: unknown, visit: (n: { textContent: string; props: { onClick?: () => void } }) => void): void => {
    const n = node as { childNodes?: unknown[]; __fakeNode?: { textContent: string; onClick?: () => void; childNodes?: unknown[] } };
    void n;
  };
  // The real child's status flows through the captured Button labels (the
  // button is the only place the child renders its state).
  // The real child's status flows through the captured Button children (the
  // button label is where the child renders its state). The registry is
  // rebuilt on every render, so read the latest entries.
  const globals = globalThis as Record<string, unknown>;
  const buttonsNow = () => (globals.__realPairButtons as Array<{ children: unknown; onClick?: () => void; disabled?: boolean }> | undefined) ?? [];
  const statusFromDom = () => {
    // The registry is append-per-render: only the newest child button carries
    // the child's current status.
    const candidates = buttonsNow().map((b) => textOf(b.children));
    // The child's button label is exactly its status word; the step's Proceed
    // also carries the prefix, so match the status labels specifically.
    const newest = [...candidates].reverse().find((label) =>
      label === "onboarding.rehaul.provider.testing" ||
      label === "onboarding.rehaul.provider.connected" ||
      label === "onboarding.rehaul.provider.runTest"
    );
    const label = newest ?? "";
    if (label.includes("onboarding.rehaul.provider.testing")) return "testing";
    if (label.includes("onboarding.rehaul.provider.connected")) return "success";
    return "idle";
  };
  const findButton = (label: string) => {
    const node = findNodes(capturedTree.tree, (n) => typeof n.props?.onClick === "function" && textOf(n.props?.children).includes(label))[0];
    if (node) return { click: () => (node.props!.onClick as () => void)() };
    const match = buttonsNow().find((b) => textOf(b.children).includes(label));
    return match && !match.disabled ? { click: () => match.onClick?.() } : null;
  };

  return {
    routeChanges: () => routeChanges,
    beginSave: () => footerCommit!(),
    changeField: async (field: "provider" | "model" | "key" | "url" | "custom-model") => {
      const select = field === "provider" || field === "model";
      const label = field === "provider" ? "providerLabel" : "modelLabel";
      const candidates = findNodes(capturedTree.tree, n => typeof n.props?.onChange === "function");
      const node = select
        ? candidates.find(n => n.props?.ariaLabel === `onboarding.rehaul.provider.${label}`)
        : candidates.filter(n => !("ariaLabel" in (n.props ?? {})))[field === "url" ? 0 : field === "custom-model" ? 1 : selfHosted ? 2 : 0];
      assert.ok(node);
      await React.act(async () => { (node!.props!.onChange as (value: unknown) => void)(select ? field === "provider" ? "deepgram" : "different-model" : { target: { value: "changed" } }); });
    },
    connected: () => state.connected,
    status: statusFromDom,
    proceeds: () => proceeds,
    savedKeys: () => savedKeys,
    saveErrorShown: () => textOf(capturedTree.tree).includes("apiKeyInput.saveError"),
    runTest: async () => {
      const runButton = findButton("onboarding.rehaul.provider.runTest");
      assert.ok(runButton, "the run-test button is rendered");
      console.log("DEBUGM clicking runTest:", JSON.stringify(runButton));
      await React.act(async () => { runButton.click(); await Promise.resolve(); });
      console.log("DEBUGM after click, status:", statusFromDom());
    },
    resolveTest: async (result: Record<string, unknown>) => {
      await React.act(async () => {
        releaseTest?.(result);
        await Promise.resolve();
        rerender?.();
        await Promise.resolve();
      });
    },
    changeModel: async (model: string) => {
      const input = findNodes(capturedTree.tree, (n) => typeof n.props?.onChange === "function" && typeof n.props?.value === "string")[0];
      assert.ok(input, "the model input is rendered");
      await React.act(async () => {
        (input.props!.onChange as (event: { target: { value: string } }) => void)({ target: { value: model } });
        await Promise.resolve();
      });
    },
    clickStepProceed: async () => {
      const proceed = findButton("onboarding.rehaul.provider.proceed");
      assert.ok(proceed, "the step Proceed button is rendered");
      await React.act(async () => { proceed.click(); await Promise.resolve(); await Promise.resolve(); });
    },
    clickFooterContinue: async () => {
      assert.ok(footerCommit, "the footer holds the step's commit");
      await React.act(async () => { await footerCommit!(); rerender?.(); await Promise.resolve(); await Promise.resolve(); });
    },
    unmount: async () => {
      await React.act(async () => root.unmount());
    },
  };
}

// Issue #180: ProviderConnectionTest resets on onSuccessChange identity. The
// step used to pass a fresh inline callback per render, so the success the
// test reported cancelled itself: setConnected(true) → parent re-render → new
// callback → reset effect → status idle + onSuccessChange(false). These tests
// mount the REAL parent+child pair with a deferred IPC so the interleaving is
// exact, and check both Continue buttons run the confirmed save→proceed.
test("connection success survives parent re-renders; config change and failed save behave", async (t: import("node:test").TestContext) => {
  const ui = await setupRealPair(t, {
    testResult: undefined, // IPC hangs until released
    captured: true,
    saveFailsAfter: 1, // the second save attempt fails (failed-save case)
  });
  try {
    assert.equal(ui.connected(), false, "starts unconnected");

    // Run the test; the IPC result is still pending.
    await ui.runTest();
    assert.equal(ui.connected(), false, "still pending");
    assert.equal(ui.status(), "testing");

    // The success lands: the parent re-renders with the new callback identity.
    await ui.resolveTest({ success: true });
    assert.equal(ui.status(), "success", "the success state is kept");
    assert.equal(ui.connected(), true, "the parent stays connected after the re-render");

    // Both Continue buttons run the same confirmed transition (save → proceed).
    assert.deepEqual(ui.proceeds(), [], "nothing advanced before the user acts");
    await ui.clickFooterContinue();
    assert.deepEqual(ui.proceeds(), ["proceed"], "the footer Continue saved and advanced");
    assert.equal(ui.savedKeys().length, 1, "the secure save ran before proceeding");

    // A config change invalidates the previous success.
    await ui.changeModel("whisper-large");
    assert.equal(ui.connected(), false, "the config change resets the connection");
    assert.equal(ui.status(), "idle");

    // A late response of the old request must not confirm the new config.
    await ui.resolveTest({ success: true });
    assert.equal(ui.connected(), false, "the stale success is dropped");
    assert.equal(ui.status(), "idle");

    // Re-run and confirm: the second secure save fails, and the step stays
    // put with the error surfaced (secure-save failure never advances).
    await ui.runTest();
    await ui.resolveTest({ success: true });
    assert.equal(ui.connected(), true, "re-connected after the config change");

    await ui.clickStepProceed();
    assert.deepEqual(ui.proceeds(), ["proceed"], "only the first confirmed save advanced");
    assert.equal(ui.saveErrorShown(), true, "the failed second save surfaces the error");
  } finally {
    await ui.unmount();
  }
});

for (const field of ["provider", "model", "key", "url", "custom-model"] as const) {
  test(`late secure save after ${field} change cannot apply the old transcription route`, async t => {
    let resolve!: (value: { success: boolean }) => void;
    const saveResult = new Promise<{ success: boolean }>(done => { resolve = done; });
    const ui = await setupRealPair(t, { testResult: { success: true }, saveResult, selfHosted: field === "url" || field === "custom-model" });
    try {
      await ui.runTest();
      assert.equal(ui.connected(), true);
      let saving!: Promise<void>;
      await React.act(async () => { saving = ui.beginSave(); });
      await ui.changeField(field);
      await React.act(async () => { resolve({ success: true }); await saving; });
      assert.deepEqual(ui.routeChanges(), []);
      assert.deepEqual(ui.proceeds(), []);
    } finally { await ui.unmount(); }
  });
}

test("late secure save after leaving the provider step cannot apply route or proceed", async t => {
  let resolve!: (value: { success: boolean }) => void;
  const saveResult = new Promise<{ success: boolean }>(done => { resolve = done; });
  const ui = await setupRealPair(t, { testResult: { success: true }, saveResult });
  await ui.runTest();
  assert.equal(ui.connected(), true);
  let saving!: Promise<void>;
  await React.act(async () => { saving = ui.beginSave(); });
  await ui.unmount();
  await React.act(async () => { resolve({ success: true }); await saving; });
  assert.deepEqual(ui.routeChanges(), []);
  assert.deepEqual(ui.proceeds(), []);
});
