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

async function collectByokDrafts(t: import("node:test").TestContext, { selfHostedRequested, resumeState }: DraftOptions) {
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
      "/ProviderConnectionTest": `export default function ProviderConnectionTest() { return null; }`,
      "/OnboardingShell": `export function BrandMark() { return null; }`,
      "/ui/ProviderIcon": `export function ProviderIcon() { return null; }`,
    },
  }));
  const { useSettingsStore } = await reloadSettingsStore(vite);
  useSettingsStore.setState(SECRETS);
  const { ByokProviderStep } = await vite.ssrLoadModule(
    "/components/onboarding/ProviderSetupStep.tsx"
  );

  const drafts: Array<Record<string, unknown>> = [];
  function Harness() {
    // Execute the real component and hooks with React lifecycle, while leaving
    // native controls unmounted: the persisted draft is the test boundary.
    ByokProviderStep({
      selfHostedRequested,
      resumeState,
      onSelfHostedChange() {},
      onConnectionChange() {},
      onProceed() {},
      onResumeStateChange: (draft: Record<string, unknown>) => drafts.push(draft),
    });
    return null;
  }
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });
  // Unmounting flushes the latest draft — the same path the step takes when
  // onboarding advances past it.
  await React.act(async () => root.unmount());
  return drafts;
}

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
    const drafts = await collectByokDrafts(t, options as DraftOptions);

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
