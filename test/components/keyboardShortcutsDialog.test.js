const assert = require("node:assert/strict");
const test = require("node:test");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const heroMock = `
import React from "react";
const passthrough = ({children}) => React.createElement(React.Fragment, null, children);
export const Button = ({children,onPress,...rest}) => React.createElement("button", {onClick:onPress}, children);
export const Modal = Object.assign(
  ({isOpen,children}) => isOpen ? React.createElement(React.Fragment, null, children) : null,
  { Backdrop: passthrough, Container: passthrough, Dialog: passthrough, CloseTrigger: passthrough, Heading: passthrough }
);
`;

async function renderDialog(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-keyboard-shortcuts-",
    noExternal: ["@heroui/react"],
    mockModules: {
      "@heroui/react": heroMock,
      "react-i18next": `export function useTranslation() { return { t: (key, options) => options?.defaultValue ?? key }; }`,
    },
  });
  const mod = await vite.ssrLoadModule("/components/KeyboardShortcutsDialog.tsx");
  return renderToStaticMarkup(createElement(mod.default, { open: true, onOpenChange: () => {} }));
}

test("the shortcut cheat sheet lists every wired action and its chord", async (t) => {
  const html = await renderDialog(t);

  assert.match(html, /Keyboard shortcuts/, "title");
  assert.match(html, /Navigation/, "navigation group");
  assert.match(html, /Next \/ previous note/);
  assert.match(html, /Switch notes \/ upload/);
  assert.match(html, /New note/);
  assert.match(html, /New folder/);
  assert.match(html, /Find in note/);
  assert.match(html, /Settings/);
});

test("a closed cheat sheet renders nothing", async (t) => {
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
