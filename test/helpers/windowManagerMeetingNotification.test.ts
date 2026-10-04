const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");

function createDeferred<T = void>() {
  let resolve!: (value?: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = (value) => resolvePromise(value!);
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const createdWindows: any[] = [];
const appListeners = new Map();
const hotkeyManagers: any[] = [];
let appQuitCount = 0;
let dialogResponse = 1;
const dialogCalls: any[] = [];
const dialogParents: unknown[] = [];
let devServerWaitPromise: Promise<void> = Promise.resolve();

class FakeBrowserWindow extends EventEmitter {
  constructor(options: unknown) {
    super();
    this.options = options;
    this.destroyed = false;
    this.loadDeferred = createDeferred();
    this.messages = [];
    this.loadUrlCount = 0;
    this.showCount = 0;
    this.visible = false;
    this.bounds = { x: 20, y: 20, width: 1200, height: 800 };
    this.minimumSize = [0, 0];
    this.ignoreMouseEvents = [];
    this.webContents = Object.assign(new EventEmitter(), {
      send: (channel: string, payload: unknown) => this.messages.push({ channel, payload }),
      setWindowOpenHandler() {},
      isCrashed: () => false,
    });
    createdWindows.push(this);
  }

  setContentProtection() {}

  setIgnoreMouseEvents(ignore: boolean, options: unknown) {
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

  showInactive() { this.show(); }

  show() {
    this.showCount += 1;
    this.visible = true;
  }
  hide() { this.visible = false; }
  focus() {}
  isMinimized() { return false; }
  restore() { this.visible = true; }
  setTitle() {}
  setMinimumSize(width: number, height: number) { this.minimumSize = [width, height]; }
  getMinimumSize() { return this.minimumSize; }
  getBounds() { return this.bounds; }
  getContentBounds() { return this.bounds; }
  setContentBounds(bounds: unknown) { this.bounds = bounds; }
  isFullScreen() { return false; }
  isMaximized() { return false; }
  setResizable() {}
  setMinimizable() {}
  setMaximizable() {}
  setClosable() {}
  setFullScreenable() {}
  setWindowButtonVisibility() {}
  isResizable() { return true; }
  isMinimizable() { return true; }
  isMaximizable() { return true; }
  isClosable() { return true; }
  isFullScreenable() { return true; }

  isVisible() {
    return this.visible && !this.destroyed;
  }
}

class FakeHotkeyManager {
  unregisterCount: number;
  static isGlobeLikeHotkey() { return false; }
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

class FakeDragManager {
  cleanup() {}
}

const originalLoad = Module._load;
const appStub = {
  on: (event: unknown, listener: unknown) => appListeners.set(event, listener),
  quit: () => { appQuitCount += 1; },
};
const dialogStub = {
  showMessageBox: async (windowOrOptions: unknown, options?: unknown) => {
    dialogCalls.push(options ?? windowOrOptions);
    dialogParents.push(options ? windowOrOptions : null);
    return { response: dialogResponse };
  },
};
Module._load = function loadWindowManagerWithStubs(request: string, parent: unknown, isMain: boolean) {
  if (request === "electron") {
    return {
      app: appStub,
      screen: { getPrimaryDisplay: () => ({}), getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }), on: () => undefined },
      BrowserWindow: FakeBrowserWindow,
      shell: {},
      dialog: dialogStub,
    };
  }
  if (request === "./debugLogger" || request === "./debugLogger.js") {
    return { info: () => undefined, warn: () => undefined, error: () => undefined };
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
  if (request === "./dockManager" || request === "./dockManager.js") return { setControlPanelVisible() {} };
  if (request === "./i18nMain" || request === "./i18nMain.js") {
    return { i18nMain: { t: (key: string) => key } };
  }
  if (request === "./windowConfig" || request === "./windowConfig.js") {
    const detectionSize = { width: 392, height: 92 };
    const autoEndSize = { width: 620, height: 116 };
    return {
      MAIN_WINDOW_CONFIG: {},
      CONTROL_PANEL_CONFIG: { width: 1200, height: 800 },
      CONTROL_PANEL_MIN_SIZE: { width: 1000, height: 700 },
      ONBOARDING_WINDOW_SIZES: {
        COMPACT: { width: 480, height: 624 },
        EXPANDED: { width: 1000, height: 740 },
      },
      NOTIFICATION_WINDOW_CONFIG: { ...detectionSize, acceptFirstMouse: true },
      AUTO_END_NOTIFICATION_WINDOW_SIZE: autoEndSize,
      getMeetingNotificationWindowSize: (data: any) =>
        data?.kind === "auto-end" ? autoEndSize : detectionSize,
      WINDOW_SIZES: {},
      WindowPositionUtil: {
        getNotificationPosition: (_display: unknown, size = detectionSize) => ({
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

const notificationWindowFor = (index: number) => createdWindows[index];

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

  // Node and DOM overloads disagree on the timer handle; this fake only uses numeric IDs.
  global.setTimeout = Object.assign((callback: string | ((...args: unknown[]) => void), delay = 0, ...args: unknown[]) => {
    if (typeof callback !== "function") throw new TypeError("Expected timer callback");
    const timerId = nextTimerId;
    nextTimerId += 1;
    timers.set(timerId, { callback: () => callback(...args), delay });
    return timerId;
  }, { __promisify__: originalSetTimeout.__promisify__ }) as unknown as typeof setTimeout;
  global.clearTimeout = (timerId) => timers.delete(timerId);

  return {
    pendingCount: () => timers.size,
    pendingDelays: () => [...timers.values()].map(({ delay }) => delay),
    runDelay: (delay: number) => {
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
  dialogParents.length = 0;
});

test("quit confirmation uses the capture window's asynchronous sheet", async () => {
  const manager = createNormalWindowManager();
  const parent = new FakeBrowserWindow({});
  manager.controlPanelWindow = parent;
  manager.setMeetingCaptureQuitGuard({ isRecording: () => true, stop: async () => ({ success: true }) });
  appListeners.get("before-quit")({ preventDefault() {} });
  await manager._quitConfirmationPromise;
  assert.equal(dialogParents[0], parent);
  assert.equal(parent.showCount, 1);
  assert.equal(manager.isQuitting, false);
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
  const stopDeferred = createDeferred<{ success: boolean }>();
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
  const closedSessions: unknown[] = [];
  manager.meetingDetectionEngine = {
    handleAutoEndNotificationClosed: (sessionId: unknown) => closedSessions.push(sessionId),
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
  const closedSessions: unknown[] = [];
  manager.meetingDetectionEngine = {
    handleAutoEndNotificationClosed: (sessionId: unknown) => closedSessions.push(sessionId),
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
  const timedOutNotifications: unknown[] = [];
  let now = 40_000;
  Date.now = () => now;
  manager.meetingDetectionEngine = {
    handleNotificationTimeout: (notification: unknown) => timedOutNotifications.push(notification),
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

test("only the active detection card can pause and resume its countdown", async () => {
  const originalDateNow = Date.now;
  Date.now = () => 50_000;
  const timers = installFakeTimers();
  const manager = createNormalWindowManager();
  try {
    const showing = manager.showMeetingNotification({ kind: "detection", detectionId: "meeting-1", source: "audio" });
    const window = createdWindows[0];
    window.loadDeferred.resolve();
    await showing;
    assert.equal(timers.pendingDelays().includes(60_000), true);
    const before = window.ignoreMouseEvents.length;
    manager.setNotificationInteractivity({ send() {} }, true);
    assert.equal(timers.pendingDelays().includes(60_000), true, "another overlay cannot pause the card");
    assert.equal(window.ignoreMouseEvents.length, before);
    for (let i = 0; i < 3; i++) {
      manager.setNotificationInteractivity(window.webContents, true);
      assert.equal(timers.pendingDelays().includes(60_000), false);
      manager.setNotificationInteractivity(window.webContents, false);
      assert.equal(timers.pendingDelays().includes(60_000), true);
    }
    assert.equal(window.ignoreMouseEvents.length, before + 6);
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
  const closedDetections: unknown[] = [];
  manager.meetingDetectionEngine = {
    handleDetectionNotificationClosed: (detectionId: unknown) => closedDetections.push(detectionId),
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
  const closedDetections: unknown[] = [];
  let timeouts = 0;
  manager.meetingDetectionEngine = {
    handleDetectionNotificationClosed: (detectionId: unknown) => closedDetections.push(detectionId),
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
  const closedDetections: unknown[] = [];
  manager.meetingDetectionEngine = {
    handleDetectionNotificationClosed: (detectionId: unknown) => closedDetections.push(detectionId),
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

// Issue #173: the notification toggles arrive from the renderer through the
// desktop settings handler, which centralizes the update and the derived
// detection gate on the window manager. Pinning the gate keeps detection and
// the master/meeting toggles consistent without re-deriving it at each caller.
test("notification preferences update individually and derive the detection gate", () => {
  const manager = createNormalWindowManager();

  // Defaults are all on.
  assert.equal(manager.notificationsGateDetection(), true);

  // macOS disabled notifications
  manager.setNotificationPreferences({ notificationsEnabled: false });
  assert.equal(manager.notificationPrefs.notificationsEnabled, false);
  assert.equal(manager.notificationsGateDetection(), false);

  // Re-enabling the master is not enough — the meeting toggle still gates it.
  manager.setNotificationPreferences({ notificationsEnabled: true });
  assert.equal(manager.notificationsGateDetection(), true);
  manager.setNotificationPreferences({ notifyMeetingDetection: false });
  assert.equal(manager.notificationsGateDetection(), false);

  // The calendar reminder toggle does not affect the detection gate.
  manager.setNotificationPreferences({ notifyCalendarReminders: false });
  assert.equal(manager.notificationPrefs.notifyCalendarReminders, false);
  assert.equal(manager.notificationsGateDetection(), false);

  // Setting an immutable-typed partial leaves the other keys untouched.
  const before = { ...manager.notificationPrefs };
  manager.setNotificationPreferences({});
  assert.deepEqual(manager.notificationPrefs, before);
});

for (const completed of [false, true]) {
  test(`tray startup loads a hidden renderer and ${completed ? "releases" : "retains"} the onboarding gate`, async (t) => {
    const timers = installFakeTimers();
    t.after(() => timers.restore());
    const manager = new WindowManager();
    t.after(() => manager._clearControlPanelVisibilityTimer());
    let loads = 0;
    manager.loadControlPanel = async () => {
      loads++;
      manager.controlPanelWindow.webContents.emit("did-finish-load");
    };
    assert.equal(manager.isMeetingInputAllowed(), false);
    await manager.createControlPanelWindow({ show: false });
    const panel = manager.controlPanelWindow;
    assert.equal(loads, 1, "tray launch still loads the renderer");
    assert.equal(panel.options.show, false);
    manager.setOnboardingActive(!completed);
    manager.setOnboardingWindowMode(completed ? "restore" : "compact");
    assert.equal(manager.isMeetingInputAllowed(), completed);
    timers.runAll();
    assert.equal(panel.showCount, 0, "mode and backstop do not show the tray-started window");
    assert.equal(panel.isVisible(), false);
    manager.setNotificationPreferences({ notificationsEnabled: false });
    assert.equal(manager.notificationsGateDetection(), false);
    if (!completed) {
      assert.equal(await manager.showMeetingNotification({ kind: "detection", id: "tray-gated" }), false);
    }
    await manager.createControlPanelWindow(); // Explicit tray/open action.
    assert.equal(manager.controlPanelWindow, panel);
    assert.equal(loads, 1);
    assert.equal(panel.isVisible(), true);
    manager.hideControlPanelToTray();
    manager.setOnboardingWindowMode("restore");
    assert.equal(panel.isVisible(), false, "a later restore honors the user's explicit hide");
    panel.webContents.emit("did-finish-load");
    assert.equal(manager.isMeetingInputAllowed(), false, "reload waits for a new handshake");
    manager.setOnboardingActive(!completed);
    manager.setOnboardingWindowMode(completed ? "restore" : "compact");
    assert.equal(panel.isVisible(), false);
    assert.equal(manager.isMeetingInputAllowed(), completed);
  });
}

test("visible startup keeps the load backstop and explicit hide cancels it", async (t) => {
  const timers = installFakeTimers();
  t.after(() => timers.restore());
  const manager = new WindowManager();
  t.after(() => manager._clearControlPanelVisibilityTimer());
  manager.loadControlPanel = async () => {};
  await manager.createControlPanelWindow();
  assert.equal(manager.controlPanelWindow.showCount, 0);
  timers.runDelay(10000);
  assert.equal(manager.controlPanelWindow.isVisible(), true);
  manager.hideControlPanelToTray();
  manager.setOnboardingWindowMode("restore");
  timers.runAll();
  assert.equal(manager.controlPanelWindow.isVisible(), false);
});

test("hidden load rejection settles bootstrap gated and explicit open retries", async (t) => {
  const timers = installFakeTimers();
  t.after(() => timers.restore());
  const manager = new WindowManager();
  t.after(() => manager._clearControlPanelVisibilityTimer());
  let loads = 0;
  manager.loadControlPanel = async () => {
    loads++;
    if (loads === 1) throw new Error("renderer unavailable");
    manager.controlPanelWindow.webContents.emit("did-finish-load");
    manager.setOnboardingActive(false);
    manager.setOnboardingWindowMode("restore");
  };
  await manager.createControlPanelWindow({ show: false });
  assert.equal(manager._controlPanelLoadFailed, true);
  assert.equal(manager.isMeetingInputAllowed(), false);
  timers.runAll();
  assert.equal(manager.controlPanelWindow.showCount, 0);
  await manager.createControlPanelWindow();
  assert.equal(loads, 2);
  assert.equal(manager.isMeetingInputAllowed(), true);
  assert.equal(manager.controlPanelWindow.isVisible(), true);
});
