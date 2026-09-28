const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals }: typeof import("../lib/rendererTestHarness.ts") = require("../lib/rendererTestHarness.ts");

type TestContext = import("node:test").TestContext;

// Assertions are class-based, so the untranslated i18n fallback (raw keys) is fine.
async function renderBottomBar(t: TestContext, props: Record<string, unknown>) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-note-bottom-bar-test-",
    mockModules: {
      "/stores/meetingRecordingStore": `
        export const getMicAnalyser = () => null;
        export const useMeetingRecordingStore = { getState: () => ({ currentMicLevel: 0 }) };
      `,
    },
  });
  const mod = await vite.ssrLoadModule("/components/notes/NoteBottomBar.tsx");
  return renderToStaticMarkup(
    createElement(mod.default, {
      isRecording: false,
      onAskSubmit: () => {},
      ...props,
    })
  );
}

test("recording state renders no backdrop-filter surface over the live transcript", async (t: TestContext) => {
  const html = await renderBottomBar(t, { isRecording: true });

  // The 1.9.0 CPU regression: every transcript partial re-blurred the strip.
  assert.ok(!html.includes("backdrop-blur"), "no backdrop-blur while recording");
  assert.ok(!html.includes("backdrop-saturate"), "no backdrop-saturate while recording");
  assert.ok(html.includes("bg-surface-2/95"), "capsules use the near-opaque surface");
  assert.ok(html.includes("shadow-(--shadow-glass)"), "capsules keep the glass rim shadow");
});

test("idle state keeps the liquid-glass capsule", async (t: TestContext) => {
  const html = await renderBottomBar(t, { isRecording: false });

  assert.ok(html.includes("backdrop-blur-xl"));
  assert.ok(html.includes("backdrop-saturate-150"));
  assert.ok(!html.includes("<button"), "idle composer has no model picker");
});

test("the ask capsule never transitions its surface between the two states", async (t: TestContext) => {
  // transition-all would tween backdrop-filter and background-color for 500ms
  // on every recording start and stop, re-paying the cost this change removes;
  // the outline (radius, shadow) must not morph either.
  for (const isRecording of [false, true]) {
    const html = await renderBottomBar(t, { isRecording });
    assert.ok(
      html.includes("transition-[opacity,height]"),
      `capsule transition is property-scoped (isRecording=${isRecording})`
    );
  }
});
