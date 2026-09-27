import type { TestContext } from "node:test";
import type { BbHarness } from "../../src/contracts/bb.js";

const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness.ts") as typeof import("../lib/rendererTestHarness.js");

const HARNESS = {
  id: "codex",
  displayName: "Codex",
  available: true,
  logo: null,
  reasoningLevels: [],
} satisfies BbHarness;
const MODELS = [{ id: "gpt-5", displayName: "GPT-5", supportedReasoningEfforts: [], defaultReasoningEffort: null }];

// The picker's box must not depend on which tab is open: a measured/auto body
// resized the popover and jumped its anchor when switching to the API tab.
async function renderPanel(t: TestContext, { leadingActive }: { leadingActive: boolean }) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-bb-model-panel-test-",
    mockModules: {
      "/components/bb/useBbCatalog": `
        export function defaultReasoningFor() { return "medium"; }
        export function useBbModels() { return { models: ${JSON.stringify(MODELS)}, error: "", loading: false }; }
      `,
      "react-i18next": `export function useTranslation() { return { t: (key) => key }; }`,
    },
  });
  const mod = await vite.ssrLoadModule("/components/bb/BbModelPanel.tsx") as typeof import("../../src/components/bb/BbModelPanel.js");
  return renderToStaticMarkup(
    createElement(mod.BbModelPanel, {
      harnesses: [HARNESS],
      selection: { provider: "codex", model: "gpt-5", reasoningLevel: "medium" },
      onSelect: () => {},
      leadingTabs: [{ id: "api", label: "API", icon: null, active: leadingActive, onSelect: () => {} }],
      leadingContent: createElement("p", null, "route"),
    })
  );
}

test("the panel body keeps one fixed box on every tab", async (t: TestContext) => {
  const harnessHtml = await renderPanel(t, { leadingActive: false });
  const apiHtml = await renderPanel(t, { leadingActive: true });

  for (const [name, html] of [["harness", harnessHtml], ["api", apiHtml]] as const) {
    assert.match(html, /class="flex h-64 min-h-0 flex-col"/, `${name} tab uses the fixed body box`);
  }
});
