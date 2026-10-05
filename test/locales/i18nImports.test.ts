const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const {
  createRendererServer,
  installBrowserGlobals,
}: typeof import("../lib/rendererTestHarness.ts") = require("../lib/rendererTestHarness.ts");

test("i18n still loads under a window stub that lacks localStorage", async (t: import("node:test").TestContext) => {
  installBrowserGlobals(t, { window: { localStorage: undefined } });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-i18n-import-test-",
  });

  const mod = await vite.ssrLoadModule("/i18n.ts");

  assert.equal(typeof mod.normalizeUiLanguage, "function");
  assert.ok(mod.SUPPORTED_UI_LANGUAGES.includes(mod.default.language));
});
