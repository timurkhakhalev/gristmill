const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

// Same electron stub as the other hotkeyManager suites: `registered` holds the
// callback globalShortcut would fire, so a test can invoke it directly.
const registered = new Map();
require.cache[require.resolve("electron")] = Object.assign(new (require("node:module").Module)(require.resolve("electron")), {
  exports: {
    globalShortcut: {
      register(accelerator: string, callback: unknown) {
        if (registered.has(accelerator)) return false;
        registered.set(accelerator, callback);
        return true;
      },
      unregister(accelerator: string) {
        registered.delete(accelerator);
      },
      isRegistered(accelerator: string) {
        return registered.has(accelerator);
      },
      unregisterAll() {
        registered.clear();
      },
    },
    BrowserWindow: class {},
  },
});

const HotkeyManager: typeof import("../../src/helpers/hotkeyManager.ts").HotkeyManager = require("../../src/helpers/hotkeyManager.ts");

test.beforeEach(() => {
  registered.clear();
});

test("an Fn combination is rejected without registering its base key", async () => {
  const manager = new HotkeyManager();

  const result = await manager.registerSlot("dictation", "Fn+A", () => {}, { atomic: true });

  assert.equal(result.success, false);
  assert.equal(result.reason, "fn_combination_unsupported");
  assert.deepEqual([...registered.keys()], []);
});

test("rejecting an Fn combination preserves the slot's previous binding", async () => {
  const manager = new HotkeyManager();
  const fired: unknown[] = [];

  await manager.registerSlot("dictation", "Control+Shift+A", (hotkey: unknown) => fired.push(hotkey), {
    atomic: true,
  });
  const result = await manager.registerSlot("dictation", "Fn+A", (hotkey: unknown) => fired.push(hotkey), {
    atomic: true,
  });

  assert.equal(result.success, false);
  assert.deepEqual([...registered.keys()], ["Control+Shift+A"]);
  registered.get("Control+Shift+A")();
  assert.deepEqual(fired, ["Control+Shift+A"]);
});

test("ordinary hotkeys continue to register normally", async () => {
  const manager = new HotkeyManager();
  const fired: unknown[] = [];

  await manager.registerSlot("dictation", "Control+Shift+A", (hotkey: unknown) => fired.push(hotkey), {
    atomic: true,
  });

  registered.get("Control+Shift+A")();
  assert.deepEqual(fired, ["Control+Shift+A"]);
});
