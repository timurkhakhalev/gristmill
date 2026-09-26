const test = require("node:test");
const assert = require("node:assert/strict");

const load = async () => import("../../src/utils/appShortcuts.ts");

const key = (key, mods = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

test("resolves the primary app shortcuts", async () => {
  const { resolveAppShortcut } = await load();
  assert.equal(resolveAppShortcut(key("k", { metaKey: true })), "search");
  assert.equal(resolveAppShortcut(key(",", { metaKey: true })), "settings");
  assert.equal(resolveAppShortcut(key("n", { metaKey: true })), "new-note");
  assert.equal(resolveAppShortcut(key("n", { metaKey: true, shiftKey: true })), "new-folder");
  assert.equal(resolveAppShortcut(key("1", { metaKey: true })), "view-notes");
  assert.equal(resolveAppShortcut(key("2", { metaKey: true })), "view-upload");
  assert.equal(resolveAppShortcut(key("/", { metaKey: true })), "shortcuts-help");
  assert.equal(resolveAppShortcut(key("k", { ctrlKey: true })), "search");
});

test("note navigation uses Cmd+Shift+brackets, layout independent", async () => {
  const { resolveAppShortcut } = await load();
  assert.equal(
    resolveAppShortcut(key("}", { metaKey: true, shiftKey: true, code: "BracketRight" })),
    "next-note"
  );
  assert.equal(
    resolveAppShortcut(key("{", { metaKey: true, shiftKey: true, code: "BracketLeft" })),
    "prev-note"
  );
  // A non-US layout can report a different glyph; the physical code still wins.
  assert.equal(
    resolveAppShortcut(key("+", { metaKey: true, shiftKey: true, code: "BracketRight" })),
    "next-note"
  );
});

test("ignores plain keys, unrelated modifiers and unknown combos", async () => {
  const { resolveAppShortcut } = await load();
  assert.equal(resolveAppShortcut(key("k")), null);
  assert.equal(resolveAppShortcut(key("k", { metaKey: true, altKey: true })), null);
  assert.equal(resolveAppShortcut(key("j", { metaKey: true })), null);
  assert.equal(resolveAppShortcut(key("n", { metaKey: true, altKey: true, shiftKey: true })), null);
});

test("isCommandPaletteShortcut only matches Cmd/Ctrl+K", async () => {
  const { isCommandPaletteShortcut } = await load();
  assert.equal(isCommandPaletteShortcut(key("k", { metaKey: true })), true);
  assert.equal(isCommandPaletteShortcut(key("k", { ctrlKey: true })), true);
  assert.equal(isCommandPaletteShortcut(key("k")), false);
  assert.equal(isCommandPaletteShortcut(key("n", { metaKey: true })), false);
});
