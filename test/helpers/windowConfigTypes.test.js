const test = require("node:test");
const assert = require("node:assert/strict");

const WINDOW_CONFIG_PATH = require.resolve("../../src/helpers/windowConfig.js");
const { resolveOverlayWindowType } = require(WINDOW_CONFIG_PATH);

const SESSION_ENV_KEYS = [
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_DESKTOP",
  "DESKTOP_SESSION",
  "WAYLAND_DISPLAY",
  "DISPLAY",
  "SWAYSOCK",
  "HYPRLAND_INSTANCE_SIGNATURE",
];

function setEnvironmentValue(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function loadWindowConfig({ platform, environment }) {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalEnvironment = Object.fromEntries(
    SESSION_ENV_KEYS.map((key) => [key, process.env[key]])
  );

  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  for (const key of SESSION_ENV_KEYS) setEnvironmentValue(key, environment[key]);
  delete require.cache[WINDOW_CONFIG_PATH];

  try {
    return require(WINDOW_CONFIG_PATH);
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
    for (const key of SESSION_ENV_KEYS) setEnvironmentValue(key, originalEnvironment[key]);
    delete require.cache[WINDOW_CONFIG_PATH];
  }
}

const OVERLAY_ROLES = ["main", "notification"];

function resolveAllOverlayTypes(platform, session) {
  return Object.fromEntries(
    OVERLAY_ROLES.map((role) => [
      role,
      resolveOverlayWindowType({ role, platform, linuxSession: session }),
    ])
  );
}

test("macOS overlays use panel windows", () => {
  const windowConfig = loadWindowConfig({
    platform: "darwin",
    environment: {},
  });

  assert.deepEqual(
    {
      main: windowConfig.MAIN_WINDOW_CONFIG.type,
      notification: windowConfig.NOTIFICATION_WINDOW_CONFIG.type,
    },
    {
      main: "panel",
      notification: "panel",
    }
  );
  assert.equal(windowConfig.MAIN_WINDOW_CONFIG.focusable, false);
  assert.equal(windowConfig.NOTIFICATION_WINDOW_CONFIG.focusable, false);
});

test("onboarding sizing does not resize the normal control panel", () => {
  const windowConfig = loadWindowConfig({ platform: "darwin", environment: {} });

  assert.deepEqual(
    {
      width: windowConfig.CONTROL_PANEL_CONFIG.width,
      height: windowConfig.CONTROL_PANEL_CONFIG.height,
    },
    { width: 1200, height: 800 }
  );
  assert.deepEqual(windowConfig.ONBOARDING_WINDOW_SIZES.COMPACT, { width: 480, height: 624 });
  assert.deepEqual(windowConfig.ONBOARDING_WINDOW_SIZES.EXPANDED, { width: 1000, height: 740 });
});

test("the overlay resolver uses the macOS panel contract", () => {
  const cases = [
    {
      name: "macOS",
      platform: "darwin",
      session: {},
      expected: {
        main: "panel",
        notification: "panel",
      },
    },
  ];

  for (const { name, platform, session, expected } of cases) {
    assert.deepEqual(resolveAllOverlayTypes(platform, session), expected, name);
  }
});

test("non-macOS inputs still resolve to the macOS window contract", () => {
  const windowConfig = loadWindowConfig({
    platform: "darwin",
    environment: {},
  });

  assert.deepEqual(
    {
      main: windowConfig.MAIN_WINDOW_CONFIG.type,
      notification: windowConfig.NOTIFICATION_WINDOW_CONFIG.type,
    },
    {
      main: "panel",
      notification: "panel",
    }
  );
});
