const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const noop = () => {};
const asyncNoop = async () => {};

async function createOnboardingRenderer(t, platform = "linux") {
  installBrowserGlobals(t, {
    window: { electronAPI: { getPlatform: () => platform } },
  });
  return createRendererServer(t, {
    cachePrefix: "openwhispr-onboarding-compatibility-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export function useTranslation() {
          return { t(key) { return key; } };
        }
      `,
      "onboarding-hero-dither.webp": `export default "hero-light.webp";`,
      "onboarding-hero-dither-dark.webp": `export default "hero-dark.webp";`,
      "onboarding-bg-light.svg": `export default "background-light.svg";`,
      "onboarding-bg-dark.svg": `export default "background-dark.svg";`,
      "onboarding-permission-microphone.webp": `export default "microphone.webp";`,
      "onboarding-permission-system-audio.webp": `export default "system-audio.webp";`,
      "/utils/platform": `
        export function getPlatform() { return "${platform}"; }
        export function getCachedPlatform() { return "${platform}"; }
      `,
      "/stores/settingsStore": `
        export function useSettingsStore() { return {}; }
        useSettingsStore.getState = () => ({});
      `,
      "/ui/ProviderIcon": `
        import React from "react";
        export function ProviderIcon() { return React.createElement("span"); }
      `,
    },
  });
}

function permissions(overrides = {}) {
  return {
    micPermissionGranted: false,
    micPermissionError: null,
    requestMicPermission: asyncNoop,
    openMicPrivacySettings: asyncNoop,
    openSoundInputSettings: asyncNoop,
    setMicPermissionGranted: noop,
    ...overrides,
  };
}

// The action row carries mt-auto, so anything rendered after it rides down on
// that auto margin and lands under the buttons — below the fold on the compact
// frame. Contextual guidance has to precede it in the DOM, and so in tab order.
function assertGuidancePrecedesActions(markup, guidance) {
  assert.ok(
    markup.indexOf(guidance) < markup.indexOf("common.continue"),
    `${guidance} should render before the action row`
  );
}

const systemAudio = {
  granted: false,
  mode: "portal",
  supportsOnboardingGrant: false,
  request: async () => false,
};

test("Linux onboarding exposes labelled minimize, maximize, and close controls in both modes", async (t) => {
  const vite = await createOnboardingRenderer(t);
  const { default: OnboardingShell } = await vite.ssrLoadModule(
    "/components/onboarding/OnboardingShell.tsx"
  );

  for (const compact of [true, false]) {
    const mode = compact ? "compact" : "expanded";
    const markup = renderToStaticMarkup(
      React.createElement(OnboardingShell, { compact }, React.createElement("div"))
    );

    for (const control of ["minimize", "maximize", "close"]) {
      assert.match(
        markup,
        new RegExp(`title="windowControls\\.${control}"`),
        `${mode} ${control} title`
      );
      assert.match(
        markup,
        new RegExp(`aria-label="windowControls\\.${control}"`),
        `${mode} ${control} aria-label`
      );
    }
  }
});

test("a denied microphone exposes the existing Linux settings recovery", async (t) => {
  const vite = await createOnboardingRenderer(t);
  const { default: CompactPermissionsStep } = await vite.ssrLoadModule(
    "/components/onboarding/CompactPermissionsStep.tsx"
  );

  const markup = renderToStaticMarkup(
    React.createElement(CompactPermissionsStep, {
      permissions: permissions({ micPermissionError: "Microphone blocked by the OS" }),
      systemAudio,
      onContinue: noop,
    })
  );

  assert.match(markup, /Microphone blocked by the OS/);
  assert.match(markup, />hooks.permissions.warning.soundLabel<\/button>/);
  assertGuidancePrecedesActions(markup, "Microphone blocked by the OS");
});

test("permissions offers Back ahead of Continue and gates Continue on microphone access", async (t) => {
  const vite = await createOnboardingRenderer(t, "darwin");
  const { default: CompactPermissionsStep } = await vite.ssrLoadModule(
    "/components/onboarding/CompactPermissionsStep.tsx"
  );

  const render = (micPermissionGranted, onBack) =>
    renderToStaticMarkup(
      React.createElement(CompactPermissionsStep, {
        permissions: permissions({ micPermissionGranted }),
        systemAudio,
        onBack,
        onContinue: noop,
      })
    );

  const blocked = render(false, noop);
  assert.doesNotMatch(blocked, /common\.logout/);
  assert.ok(
    blocked.indexOf("common.back") < blocked.indexOf("common.continue"),
    "Back sits ahead of Continue"
  );
  // Continue is part of the step now rather than an overlay above it, so it
  // follows the permission rows in the DOM, and so in tab order.
  assert.ok(
    blocked.indexOf("onboarding.permissions.microphoneTitle") < blocked.indexOf("common.continue"),
    "Continue should render after the permission rows"
  );
  assert.match(blocked, /<button[^>]*\bdisabled=""[^>]*>common\.continue<\/button>/);

  const ready = render(true, noop);
  assert.match(ready, /<button[^>]*>common\.continue<\/button>/);
  assert.doesNotMatch(ready, /\bdisabled=""[^>]*>common\.continue/);

  // With nothing to return to (a resumed session with no history), Back is gone.
  assert.doesNotMatch(render(true, undefined), /common\.back/);
});
test("provider setup exposes a single transcription stage", async (t) => {
  const vite = await createOnboardingRenderer(t);
  const { SetupStageStepper } = await vite.ssrLoadModule(
    "/components/onboarding/ProviderSetupStep.tsx"
  );

  const markup = renderToStaticMarkup(React.createElement(SetupStageStepper));
  assert.match(markup, /onboarding\.rehaul\.provider\.title/);
  assert.doesNotMatch(markup, /dictation|assistant|screenContext|pasteTools/i);
});
