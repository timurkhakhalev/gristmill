const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const path: typeof import("node:path") = require("node:path");

const test: typeof import("node:test") = require("node:test");

const repoRoot = path.join(__dirname, "../..");

const source = (relativePath: string) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

test("nav drawer slides in from the start edge in both document directions", () => {
  const drawer = source("src/components/ControlPanelNavDrawer.tsx");

  assert.match(drawer, /transition-\[transform,opacity\]/);
  assert.match(drawer, /-translate-x-full opacity-0 rtl:translate-x-full/);
  assert.match(drawer, /translate-x-0 opacity-100/);
  assert.doesNotMatch(drawer, /animate-in|slide-in-from-/);
});

test("standard toasts enter from the outer edge in both document directions", () => {
  const toast = source("src/components/ui/Toast.tsx");
  const css = source("src/index.css");

  assert.match(toast, /toast-enter opacity-100 translate-x-0 scale-100/);
  assert.doesNotMatch(toast, /animate-in|slide-in-from-/);
  assert.match(css, /\.toast-enter\s*\{[\s\S]*?--toast-enter-x: 1rem;/);
  assert.match(css, /\[dir="rtl"\] \.toast-enter\s*\{[\s\S]*?--toast-enter-x: -1rem;/);
  assert.match(css, /@keyframes toast-enter[\s\S]*?translateX\(var\(--toast-enter-x\)\)/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?\.toast-enter[\s\S]*?animation: none/);
});
