const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test") = require("node:test");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals }: typeof import("../lib/rendererTestHarness.ts") = require("../lib/rendererTestHarness.ts");

const heroMock = `
import React from "react";
const passthrough = ({children}) => React.createElement(React.Fragment, null, children);
export const Button = ({children,onPress,...rest}) => React.createElement("button", {onClick:onPress}, children);
export const Modal = Object.assign(
  ({isOpen,children}) => isOpen ? React.createElement(React.Fragment, null, children) : null,
  { Backdrop: passthrough, Container: passthrough, Dialog: passthrough, CloseTrigger: passthrough, Heading: passthrough }
);
`;

async function renderDialog(t: import("node:test").TestContext) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-keyboard-shortcuts-",
    noExternal: ["@heroui/react"],
    mockModules: {
      "@heroui/react": heroMock,
      "/utils/platform": 'export const getCachedPlatform = () => "darwin";',
      "react-i18next": `export function useTranslation() { return { t: (key, options) => options?.defaultValue ?? key }; }`,
    },
  });
  const mod = await vite.ssrLoadModule("/components/KeyboardShortcutsDialog.tsx");
  return renderToStaticMarkup(createElement(mod.default, { open: true, onOpenChange: () => {} }));
}

test("the shortcut cheat sheet lists every wired action and its chord", async (t: import("node:test").TestContext) => {
  const html = await renderDialog(t);

  assert.match(html, /Keyboard shortcuts/, "title");
  assert.match(html, /Navigation/, "navigation group");
  for (const [label, chord] of [
    ["Search", ["⌘", "K"]],
    ["Next / previous note", ["⌘", "⇧", "[ / ]"]],
    ["Switch notes / upload", ["⌘", "1 / 2"]],
    ["Settings", ["⌘", ","]],
    ["New note", ["⌘", "N"]],
    ["New folder", ["⌘", "⇧", "N"]],
    ["Find in note", ["⌘", "F"]],
    ["Keyboard shortcuts", ["⌘", "/"]],
  ]) {
    const row = html.match(new RegExp(`<span[^>]*>${String(label).replaceAll("/", "\\/")}</span><span[^>]*>(.*?)</span>`));
    assert.ok(row, `${label} row`);
    assert.deepEqual([...row[1].matchAll(/<kbd[^>]*>(.*?)<\/kbd>/g)].map((match) => match[1]), chord, String(label));
  }
});

test("a closed cheat sheet renders nothing", async (t: import("node:test").TestContext) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-keyboard-shortcuts-closed-",
    noExternal: ["@heroui/react"],
    mockModules: {
      "@heroui/react": heroMock,
      "react-i18next": `export function useTranslation() { return { t: (key, options) => options?.defaultValue ?? key }; }`,
    },
  });
  const mod = await vite.ssrLoadModule("/components/KeyboardShortcutsDialog.tsx");
  const html = renderToStaticMarkup(createElement(mod.default, { open: false, onOpenChange: () => {} }));
  assert.equal(html, "");
});
