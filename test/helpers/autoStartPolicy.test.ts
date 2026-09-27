const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getLoginItemArgs,
  resolveAutoStartState,
  wasLaunchedHidden,
} = require("../../src/helpers/autoStartPolicy.ts");

test("macOS login items use no command-line arguments", () => {
  assert.deepEqual(getLoginItemArgs(), []);
});

test("an item awaiting approval reads as off, with the reason surfaced", () => {
  const state = resolveAutoStartState({
    loginItemSettings: { openAtLogin: false, status: "requires-approval" },
  });
  assert.deepEqual(state, { enabled: false, requiresApproval: true });
});

test("macOS reports an approved item without prompting for approval", () => {
  const state = resolveAutoStartState({
    loginItemSettings: { openAtLogin: true, status: "enabled" },
  });
  assert.deepEqual(state, { enabled: true, requiresApproval: false });
});

test("a disabled macOS item is neither enabled nor awaiting approval", () => {
  const state = resolveAutoStartState({
    loginItemSettings: { openAtLogin: false, status: "not-registered" },
  });
  assert.deepEqual(state, { enabled: false, requiresApproval: false });
});

test("macOS detects a login launch from wasOpenedAtLogin", () => {
  assert.equal(wasLaunchedHidden({ loginItemSettings: { wasOpenedAtLogin: true } }), true);
  assert.equal(wasLaunchedHidden({ loginItemSettings: { wasOpenedAtLogin: false } }), false);
});
