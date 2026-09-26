const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const createdWindows = [];
const appListeners = new Map();
const hotkeyManagers = [];
let appQuitCount = 0;
let dialogResponse = 1;
const dialogCalls = [];
let devServerWaitPromise = Promise.resolve();

class FakeBrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.loadDeferred = createDeferred();
    this.messages = [];
    this.loadUrlCount = 0;
    this.showCount = 0;
    this.ignoreMouseEvents = [];
    this.webContents = {
      send: (channel, payload) => this.messages.push({ channel, payload }),
    };
    createdWindows.push(this);
  }

  setContentProtection() {}

  setIgnoreMouseEvents(ignore, options) {
    this.ignoreMouseEvents.push({ ignore, options });
  }

  loadFile() {
    return this.loadDeferred.promise;
  }

  loadURL() {
    this.loadUrlCount += 1;
    return Promise.resolve();
  }

  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }

  isDestroyed() {
    return this.destroyed;
  }

  showInactive() {
    this.showCount += 1;
  }
}

class FakeHotkeyManager {
  constructor() {
    this.unregisterCount = 0;
    hotkeyManagers.push(this);
  }

  unregisterAll() {
    this.unregisterCount += 1;
  }

  isInListeningMode() {
    return false;
  }
}
FakeHotkeyManager.isGlobeLikeHotkey = () => false;

class FakeDragManager {
  cleanup() {}
}

const originalLoad = Module._load;
const appStub = {
  on: (event, listener) => appListeners.set(event, listener),
  quit: () => { appQuitCount += 1; },
};
const dialogStub = {
  showMessageBox: async (options) => {
    dialogCalls.push(options);
    return { response: dialogResponse };
  },
};
Module._load = function loadWindowManagerWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: appStub,
      screen: { getPrimaryDisplay: () => ({}), on: () => undefined },
      BrowserWindow: FakeBrowserWindow,
      shell: {},
      dialog: dialogStub,
    };
  }
  if (request === "./debugLogger" || request === "./debugLogger.js") {
    return { warn: () => undefined };
  }
  if (request === "./hotkeyManager" || request === "./hotkeyManager.js") {
    return { HotkeyManager: FakeHotkeyManager };
  }
  if (request === "./dragManager" || request === "./dragManager.js") {
    return { DragManager: FakeDragManager };
  }
  if (request === "./menuManager" || request === "./menuManager.js") {
    return { MenuManager: { setupMainMenu() {}, setupControlPanelMenu() {} } };
  }
  if (request === "./devServerManager" || request === "./devServerManager.js") {
    return {
      DevServerManager: {
        DEV_SERVER_PORT: 5173,
        DEV_SERVER_URL: "http://localhost:5173",
        getAppFilePath: () => ({ path: "/app/index.html", query: {} }),
        waitForDevServer: () => devServerWaitPromise,
      },
    };
  }
  if (request === "./dockManager" || request === "./dockManager.js") return {};
  if (request === "./i18nMain" || request === "./i18nMain.js") {
    return { i18nMain: { t: (key) => key } };
  }
  if (request === "./windowConfig" || request === "./windowConfig.js") {
    const detectionSize = { width: 392, height: 92 };
    const autoEndSize = { width: 620, height: 116 };
    return {
      MAIN_WINDOW_CONFIG: {},
      CONTROL_PANEL_CONFIG: { width: 1200, height: 800 },
      ONBOARDING_WINDOW_SIZES: {
        COMPACT: { width: 480, height: 624 },
        EXPANDED: { width: 1000, height: 740 },
      },
      NOTIFICATION_WINDOW_CONFIG: { ...detectionSize, acceptFirstMouse: true },
      AUTO_END_NOTIFICATION_WINDOW_SIZE: autoEndSize,
      getMeetingNotificationWindowSize: (data) =>
        data?.kind === "auto-end" ? autoEndSize : detectionSize,
      WINDOW_SIZES: {},
      WindowPositionUtil: {
        getNotificationPosition: (_display, size = detectionSize) => ({
          ...size,
          x: 1000 - size.width,
          y: 16,
        }),
        setupAlwaysOnTop: () => undefined,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const WindowManager = require("../../src/helpers/windowManager");
Module._load = originalLoad;

const notificationWindowFor = (index) => createdWindows[index];

function createNormalWindowManager() {
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  return manager;
}

function installFakeTimers() {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let nextTimerId = 1;
  const timers = new Map();

  global.setTimeout = (callback, delay = 0) => {
    const timerId = nextTimerId;
    nextTimerId += 1;
    timers.set(timerId, { callback, delay });
    return timerId;
  };
  global.clearTimeout = (timerId) => timers.delete(timerId);

  return {
    pendingCount: () => timers.size,
    pendingDelays: () => [...timers.values()].map(({ delay }) => delay),
    runDelay: (delay) => {
      for (const [timerId, timer] of [...timers]) {
        if (timer.delay !== delay) continue;
        timers.delete(timerId);
        timer.callback();
      }
    },
    runAll: () => {
      for (const [timerId, { callback }] of [...timers]) {
        timers.delete(timerId);
        callback();
      }
    },
    restore: () => {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    },
  };
}

test.beforeEach(() => {
  createdWindows.length = 0;
  appListeners.clear();
  hotkeyManagers.length = 0;
  appQuitCount = 0;
  dialogResponse = 1;
  dialogCalls.length = 0;
});

test("canceling quit during capture preserves capture and hotkeys", async () => {
  const manager = createNormalWindowManager();
  let stopCount = 0;
  manager.setMeetingCaptureQuitGuard({
    isRecording: () => true,
    stop: async () => { stopCount += 1; return { success: true }; },
  });
  let prevented = false;

  appListeners.get("before-quit")({ preventDefault: () => { prevented = true; } });
  await manager._quitConfirmationPromise;

  assert.equal(prevented, true);
  assert.equal(manager.isQuitting, false);
  assert.equal(stopCount, 0);
  assert.equal(hotkeyManagers[0].unregisterCount, 0);
  assert.equal(appQuitCount, 0);
  assert.equal(dialogCalls.length, 1);
});

test("confirming quit waits for safe capture stop before shutdown", async () => {
  const manager = createNormalWindowManager();
  const stopDeferred = createDeferred();
  let stopCount = 0;
  manager.setMeetingCaptureQuitGuard({
    isRecording: () => true,
    stop: () => { stopCount += 1; return stopDeferred.promise; },
  });
  dialogResponse = 0;
  let prevented = false;

  appListeners.get("before-quit")({ preventDefault: () => { prevented = true; } });
  const pendingQuit = manager._quitConfirmationPromise;
  await Promise.resolve();

  assert.equal(prevented, true);
  assert.equal(stopCount, 1);
  assert.equal(manager.isQuitting, false);
  assert.equal(appQuitCount, 0);
  stopDeferred.resolve({ success: true });
  await pendingQuit;

  assert.equal(manager.isQuitting, true);
  assert.equal(hotkeyManagers[0].unregisterCount, 1);
  assert.equal(appQuitCount, 1);
});

test("failed safe stop keeps the app open", async () => {
  const manager = createNormalWindowManager();
  manager.setMeetingCaptureQuitGuard({
    isRecording: () => true,
    stop: async () => ({ success: false }),
  });
  dialogResponse = 0;

  appListeners.get("before-quit")({ preventDefault() {} });
  await manager._quitConfirmationPromise;

  assert.equal(manager.isQuitting, false);
  assert.equal(hotkeyManagers[0].unregisterCount, 0);
  assert.equal(appQuitCount, 0);
  assert.equal(dialogCalls.length, 2);
  assert.equal(dialogCalls[1].type, "error");
});



test("window manager starts fail-closed and suppresses normal-app popup surfaces", async () => {
  const manager = new WindowManager();

  assert.equal(manager.isMeetingInputAllowed(), false);
  assert.equal(await manager.showMeetingNotification({ detectionId: "onboarding" }), false);
  assert.deepEqual(createdWindows, []);
});

test("window creation uses the auto-end dimensions and variant-aware position", async () => {
  const manager = createNormalWindowManager();

  try {
    const showPromise = manager.showMeetingAutoEndNotification({
      sessionId: "meeting-1",
      expiresAt: 70_000,
      reason: "silence",
    });
    const notificationWindow = createdWindows[0];

    assert.deepEqual(
      {
        acceptFirstMouse: notificationWindow.options.acceptFirstMouse,
        width: notificationWindow.options.width,
        height: notificationWindow.options.height,
        x: notificationWindow.options.x,
        y: notificationWindow.options.y,
      },
      { acceptFirstMouse: true, width: 620, height: 116, x: 380, y: 16 }
    );
    // The reason rides along in the pending payload the overlay will fetch.
    assert.deepEqual(manager._pendingNotificationData, {
      kind: "auto-end",
      sessionId: "meeting-1",
      expiresAt: 70_000,
      reason: "silence",
    });

    notificationWindow.loadDeferred.resolve();
    await showPromise;
  } finally {
    manager.dismissMeetingNotification();
  }
});

test("unexpected auto-end window closure invalidates that restart offer", async () => {
  const manager = createNormalWindowManager();
  const closedSessions = [];
  manager.meetingDetectionEngine = {
    handleAutoEndNotificationClosed: (sessionId) => closedSessions.push(sessionId),
  };

  const showPromise = manager.showMeetingAutoEndNotification({
    sessionId: "meeting-1",
    expiresAt: 70_000,
    reason: "silence",
  });
  const notificationWindow = createdWindows[0];
  notificationWindow.loadDeferred.resolve();
  await showPromise;

  notificationWindow.close();

  assert.deepEqual(closedSessions, ["meeting-1"]);
});

test("replacing an auto-end notification invalidates its restart offer", async () => {
  const manager = createNormalWindowManager();
  const closedSessions = [];
  manager.meetingDetectionEngine = {
    handleAutoEndNotificationClosed: (sessionId) => closedSessions.push(sessionId),
  };

  const autoEndPromise = manager.showMeetingAutoEndNotification({
    sessionId: "meeting-1",
    expiresAt: Date.now() + 30_000,
    reason: "silence",
  });
  createdWindows[0].loadDeferred.resolve();
  await autoEndPromise;

  const replacementPromise = manager.showMeetingNotification(
    { kind: "detection", detectionId: "calendar:next", source: "calendar" },
    { autoDismiss: false }
  );

  try {
    assert.deepEqual(closedSessions, ["meeting-1"]);
  } finally {
    createdWindows[1].loadDeferred.resolve();
    await replacementPromise;
    manager.dismissMeetingNotification();
  }
});

test("auto-end notification loading has a fail-safe timeout", async () => {
  const timers = installFakeTimers();
  const manager = createNormalWindowManager();
  const showPromise = manager.showMeetingAutoEndNotification({
    sessionId: "meeting-1",
    expiresAt: 70_000,
    reason: "silence",
  });
  const notificationWindow = createdWindows[0];

  try {
    assert.equal(timers.pendingCount(), 1);
    timers.runAll();

    await assert.rejects(showPromise, /timed out/i);
    assert.equal(notificationWindow.isDestroyed(), true);
    assert.equal(manager.notificationWindow, null);
  } finally {
    manager.dismissMeetingNotification();
    notificationWindow.loadDeferred.resolve();
    await showPromise.catch(() => undefined);
    timers.restore();
  }
});

test("auto-end recovery subtracts load time from its expiry and hover cannot extend it", async () => {
  const timers = installFakeTimers();
  const manager = createNormalWindowManager();
  const originalDateNow = Date.now;
  const timedOutNotifications = [];
  let now = 40_000;
  Date.now = () => now;
  manager.meetingDetectionEngine = {
    handleNotificationTimeout: (notification) => timedOutNotifications.push(notification),
    handleAutoEndNotificationClosed: () => undefined,
  };

  const notification = {
    kind: "auto-end",
    sessionId: "meeting-1",
    expiresAt: 70_000,
    reason: "silence",
  };
  const showPromise = manager.showMeetingAutoEndNotification(notification);
  const notificationWindow = createdWindows[0];

  try {
    now = 45_000;
    notificationWindow.loadDeferred.resolve();
    await showPromise;
    assert.equal(timers.pendingDelays().includes(25_000), true);

    manager.setNotificationInteractivity(notificationWindow.webContents, true);
    manager.setNotificationInteractivity(notificationWindow.webContents, false);
    assert.equal(timers.pendingDelays().includes(25_000), true);

    timers.runDelay(25_000);
    assert.deepEqual(timedOutNotifications, [notification]);
    assert.equal(notificationWindow.isDestroyed(), true);
  } finally {
    Date.now = originalDateNow;
    manager.dismissMeetingNotification();
    timers.restore();
  }
});

test("a replaced deferred notification cannot send its payload to the newer window", async () => {
  const timers = installFakeTimers();
  const manager = createNormalWindowManager();
  let secondShowPromise;

  try {
    const firstShowPromise = manager.showMeetingNotification(
      { detectionId: "first" },
      { autoDismiss: false }
    );
    const firstWindow = createdWindows[0];
    secondShowPromise = manager.showMeetingNotification(
      { detectionId: "second" },
      { autoDismiss: false }
    );
    const secondWindow = createdWindows[1];

    firstWindow.loadDeferred.resolve();
    await firstShowPromise;
    timers.runAll();

    assert.deepEqual(secondWindow.messages, []);
    assert.equal(secondWindow.showCount, 0);
  } finally {
    createdWindows[1]?.loadDeferred.resolve();
    await secondShowPromise?.catch(() => undefined);
    manager.dismissMeetingNotification();
    timers.restore();
  }
});

test("canceling during a deferred load prevents later timers and timeout callbacks", async () => {
  const timers = installFakeTimers();
  const manager = createNormalWindowManager();
  let timeoutCount = 0;
  manager.meetingDetectionEngine = {
    handleNotificationTimeout: () => {
      timeoutCount += 1;
    },
  };
  const showPromise = manager.showMeetingNotification({ detectionId: "first" });
  const notificationWindow = createdWindows[0];

  try {
    manager.dismissMeetingNotification();
    notificationWindow.loadDeferred.reject(new Error("ERR_ABORTED"));

    await assert.doesNotReject(showPromise);
    timers.runAll();

    assert.equal(timeoutCount, 0);
    assert.deepEqual(notificationWindow.messages, []);
    assert.equal(notificationWindow.showCount, 0);
    assert.equal(manager.notificationWindow, null);
  } finally {
    await showPromise.catch(() => undefined);
    manager.dismissMeetingNotification();
    timers.restore();
  }
});

test("canceling while waiting for the dev server never loads the stale window", async () => {
  const timers = installFakeTimers();
  const manager = createNormalWindowManager();
  const originalNodeEnv = process.env.NODE_ENV;
  const devServerWait = createDeferred();
  devServerWaitPromise = devServerWait.promise;
  process.env.NODE_ENV = "development";

  try {
    const showPromise = manager.showMeetingNotification({ detectionId: "first" });
    const notificationWindow = createdWindows[0];
    manager.dismissMeetingNotification();
    devServerWait.resolve();

    await assert.doesNotReject(showPromise);
    assert.equal(notificationWindow.loadUrlCount, 0);
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    devServerWaitPromise = Promise.resolve();
    manager.dismissMeetingNotification();
    timers.restore();
  }
});

test("a stale ready callback cannot show the replacement notification window", async () => {
  const timers = installFakeTimers();
  const manager = createNormalWindowManager();

  try {
    const firstShowPromise = manager.showMeetingNotification(
      { detectionId: "first" },
      { autoDismiss: false }
    );
    const firstWindow = createdWindows[0];
    firstWindow.loadDeferred.resolve();
    await firstShowPromise;

    const secondShowPromise = manager.showMeetingNotification(
      { detectionId: "second" },
      { autoDismiss: false }
    );
    const secondWindow = createdWindows[1];
    secondWindow.loadDeferred.resolve();
    await secondShowPromise;

    manager.showNotificationWindow(firstWindow.webContents);
    assert.equal(secondWindow.showCount, 0);

    manager.showNotificationWindow(secondWindow.webContents);
    assert.equal(secondWindow.showCount, 1);
  } finally {
    manager.dismissMeetingNotification();
    timers.restore();
  }
});

test("an auto-end notification dismissed while loading reports that it was not shown", async () => {
  const manager = createNormalWindowManager();

  const showPromise = manager.showMeetingAutoEndNotification({
    sessionId: "meeting-1",
    expiresAt: Date.now() + 30_000,
    reason: "silence",
  });
  manager.dismissMeetingNotification();
  createdWindows[0].loadDeferred.resolve();

  assert.equal(await showPromise, false);
});

test("an auto-end notification whose load fails after dismissal reports that it was not shown", async () => {
  const manager = createNormalWindowManager();

  const showPromise = manager.showMeetingAutoEndNotification({
    sessionId: "meeting-1",
    expiresAt: Date.now() + 30_000,
    reason: "silence",
  });
  manager.dismissMeetingNotification();
  createdWindows[0].loadDeferred.reject(new Error("load failed"));

  assert.equal(await showPromise, false);
});

// The engine flushes its queued detections when an expiring restart offer
// releases them, so a prompt raised from the timeout handler must outlive the
// dismissal that closes the expired card.
test("a notification raised from the timeout handler survives the dismissal that follows", async () => {
  const timers = installFakeTimers();
  const manager = createNormalWindowManager();
  const originalDateNow = Date.now;
  let now = 40_000;
  Date.now = () => now;
  let replacementPromise = null;
  manager.meetingDetectionEngine = {
    handleNotificationTimeout: () => {
      replacementPromise = manager.showMeetingNotification(
        { kind: "detection", detectionId: "calendar:next", source: "calendar" },
        { autoDismiss: false }
      );
    },
    handleAutoEndNotificationClosed: () => undefined,
  };

  const showPromise = manager.showMeetingAutoEndNotification({
    kind: "auto-end",
    sessionId: "meeting-1",
    expiresAt: 70_000,
    reason: "silence",
  });

  try {
    notificationWindowFor(0).loadDeferred.resolve();
    await showPromise;

    timers.runDelay(30_000);
    notificationWindowFor(1).loadDeferred.resolve();
    await replacementPromise;

    assert.equal(createdWindows.length, 2);
    assert.equal(notificationWindowFor(1).isDestroyed(), false);
    assert.equal(manager.notificationWindow, notificationWindowFor(1));
  } finally {
    Date.now = originalDateNow;
    manager.dismissMeetingNotification();
    timers.restore();
  }
});

test("unexpected detection card closure releases that detection", async () => {
  const manager = createNormalWindowManager();
  const closedDetections = [];
  manager.meetingDetectionEngine = {
    handleDetectionNotificationClosed: (detectionId) => closedDetections.push(detectionId),
  };

  const showPromise = manager.showMeetingNotification({
    kind: "detection",
    detectionId: "audio:sustained-audio",
    source: "audio",
  });
  const notificationWindow = createdWindows[0];
  notificationWindow.loadDeferred.resolve();
  await showPromise;

  // A compositor window kill never reaches the renderer's response IPC.
  notificationWindow.close();

  assert.deepEqual(closedDetections, ["audio:sustained-audio"]);
});

test("ending a call closes only its own detection card", async () => {
  const manager = createNormalWindowManager();
  const showPromise = manager.showMeetingNotification({
    kind: "detection", detectionId: "audio:zoom:123", source: "audio",
  });
  const window = createdWindows[0];
  window.loadDeferred.resolve();
  await showPromise;

  manager.dismissDetectionNotification("audio:zoom:other");
  assert.equal(window.isDestroyed(), false);
  manager.dismissDetectionNotification("audio:zoom:123");
  assert.equal(window.isDestroyed(), true);
});

test("an expired detection reports the timeout once, not also as a close", async () => {
  const timers = installFakeTimers();
  const manager = createNormalWindowManager();
  const closedDetections = [];
  let timeouts = 0;
  manager.meetingDetectionEngine = {
    handleDetectionNotificationClosed: (detectionId) => closedDetections.push(detectionId),
    handleNotificationTimeout: () => {
      timeouts += 1;
    },
  };

  const showPromise = manager.showMeetingNotification({
    kind: "detection",
    detectionId: "audio:sustained-audio",
    source: "audio",
  });
  createdWindows[0].loadDeferred.resolve();
  await showPromise;

  try {
    timers.runDelay(60_000);
    assert.equal(timeouts, 1, "the countdown owns this dismissal");
    assert.deepEqual(closedDetections, [], "the close must not double-report the same card");
  } finally {
    manager.dismissMeetingNotification();
    timers.restore();
  }
});

test("a detection card whose load fails releases that detection", async () => {
  const manager = createNormalWindowManager();
  const closedDetections = [];
  manager.meetingDetectionEngine = {
    handleDetectionNotificationClosed: (detectionId) => closedDetections.push(detectionId),
  };

  const showPromise = manager.showMeetingNotification({
    kind: "detection",
    detectionId: "audio:sustained-audio",
    source: "audio",
  });
  createdWindows[0].loadDeferred.reject(new Error("load failed"));

  // The card never appeared and no countdown ever started, so nothing else
  // would ever settle this detection.
  await assert.rejects(showPromise, /load failed/);
  assert.deepEqual(closedDetections, ["audio:sustained-audio"]);
});
