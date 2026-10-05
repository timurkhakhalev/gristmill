const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const load = () => import("../../src/utils/windowContext.ts");

test("a packaged dictation window ignores control in its install path", async (t: import("node:test").TestContext) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        pathname:
          "/Users/controller/Applications/OpenWhispr.app/Contents/Resources/app.asar/src/dist/index.html",
        search: "",
      },
    },
  });

  const { isControlPanelWindow, isDictationPanelWindow } = await load();

  assert.equal(isControlPanelWindow(), false);
  assert.equal(isDictationPanelWindow(), true);
});

test("only the explicit panel=true query selects the control panel", async (t: import("node:test").TestContext) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  const location = {
    pathname: "/Applications/OpenWhispr.app/Contents/Resources/app.asar/src/dist/index.html",
    search: "?panel=true",
  };

  Object.defineProperty(globalThis, "window", { configurable: true, value: { location } });

  const { isControlPanelWindow } = await load();

  assert.equal(isControlPanelWindow(), true);

  location.search = "?notpanel=true";
  assert.equal(isControlPanelWindow(), false);

  location.search = "?panel=trueish";
  assert.equal(isControlPanelWindow(), false);
});
