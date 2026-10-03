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
  const container = installHookDom(t);
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
    },
  }));
  (globalThis as Record<string, unknown>).__gristmillTestCaptureConnectionConfig = captureConnectionConfig;
  const { useSettingsStore } = await reloadSettingsStore(vite);
  useSettingsStore.setState({ ...SECRETS, ...storeOverrides });
  const { ByokProviderStep } = await vite.ssrLoadModule(
    "/components/onboarding/ProviderSetupStep.tsx"
  );

  function Harness() {
    // Execute the real component and hooks with React lifecycle, while leaving
    // native controls unmounted: the persisted draft is the test boundary.
    ByokProviderStep({
      selfHostedRequested,
      resumeState,
      onSelfHostedChange() {},
      onConnectionChange() {},
      onProceed() {},
      onResumeStateChange: (draft: Record<string, unknown>) => capturedDrafts.push(draft),
    });
    return null;
  }
  const root = createRoot(container);
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
