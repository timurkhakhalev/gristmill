const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const enginePath = require.resolve("../../src/helpers/meetingDetectionEngine");
const originalLoad = Module._load;

function loadEngine() {
  delete require.cache[enginePath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return { shell: { openExternal: async () => {} } };
    }
    if (request === "./debugLogger" || request === "./debugLogger.js") {
      return { info() {}, warn() {}, debug() {}, error() {} };
    }
    if (request === "./windowBroadcast" || request === "./windowBroadcast.js") {
      return { broadcastToWindows() {} };
    }
    // ESM module; the app loads it through a transpiling loader. The engine
    // imports it with the explicit .js extension TS emits, tests may too.
    if (request === "./meetingJoinUrl" || request === "./meetingJoinUrl.js") {
      return { getMeetingJoinUrl: (event) => event?.hangout_link ?? null };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(enginePath);
  } finally {
    Module._load = originalLoad;
  }
}

function createEngine() {
  const MeetingDetectionEngine = loadEngine();

  const reminderScheduler = {
    getActiveMeetingState: () => ({ activeMeeting: null, activeEvents: [], upcomingEvents: [] }),
  };
  const processDetector = new EventEmitter();
  processDetector.start = () => {};
  processDetector.stop = () => {};

  const audioDetector = new EventEmitter();
  audioDetector.dismissals = 0;
  audioDetector.dismiss = () => audioDetector.dismissals++;
  audioDetector.resetPrompt = () => {};
  audioDetector.setUserRecording = () => {};
  audioDetector.setMicWarmHold = () => {};
  audioDetector.meetingAppNotifications = 0;
  audioDetector.notifyMeetingAppsChanged = () => audioDetector.meetingAppNotifications++;
  audioDetector.start = () => {};
  audioDetector.stop = () => {};
  const callDetector = new EventEmitter();
  callDetector.start = () => {};
  callDetector.stop = () => {};

  const shown = [];
  const windowManager = {
    notificationPrefs: {},
    showMeetingNotification: (data) => shown.push(data),
    dismissMeetingNotification: () => {},
    queueMeetingNoteNavigation: async () => {},
  };

  const engine = new MeetingDetectionEngine(
    reminderScheduler,
    processDetector,
    audioDetector,
    windowManager,
    {},
    { callDetector }
  );

  return { engine, audioDetector, callDetector, processDetector, shown, reminderScheduler };
}

test("microphone activity alone cannot show a meeting prompt", () => {
  const { audioDetector, shown } = createEngine();
  audioDetector.emit("sustained-audio-detected", { durationMs: 2000, detectedAt: 0 });
  assert.equal(shown.length, 0);
});

test("an unanswered call prompt does not repeat for the same call", () => {
  const { engine, callDetector, shown } = createEngine();

  callDetector.emit("call-active", { key: "zoom:123", service: "zoom" });
  assert.equal(shown.length, 1, "the detection must reach the overlay");

  engine.handleNotificationTimeout();
  callDetector.emit("call-active", { key: "zoom:123", service: "zoom" });
  assert.equal(shown.length, 1);
  assert.equal(engine.activeDetections.size, 0, "expired detections must be cleared");
});

test("dismissal does not repeat until the call ends", async () => {
  const { engine, callDetector, shown } = createEngine();

  callDetector.emit("call-active", { key: "zoom:123", service: "zoom" });
  await engine.handleNotificationResponse(shown[0].detectionId, "dismiss");
  callDetector.emit("call-active", { key: "zoom:123", service: "zoom" });
  assert.equal(shown.length, 1);
});

test("a confirmed new call can prompt after the previous one ends", () => {
  const { engine, callDetector, shown } = createEngine();

  callDetector.emit("call-active", { key: "zoom:123", service: "zoom" });
  engine.handleDetectionNotificationClosed(shown[0].detectionId);
  callDetector.emit("call-ended", { key: "zoom:123" });
  callDetector.emit("call-active", { key: "zoom:123", service: "zoom" });

  assert.equal(shown.length, 2);
});

test("calendar reminder and confirmed Meet call share one offer", () => {
  const { engine, callDetector, reminderScheduler, shown } = createEngine();
  const { createHash } = require("node:crypto");
  const event = {
    id: "calendar-1", start_time: new Date(Date.now() + 60_000).toISOString(),
    hangout_link: "https://meet.google.com/abc-defg-hij", calendar_id: "calendar-1",
  };
  reminderScheduler.getActiveMeetingState = () => ({ activeMeeting: event, upcomingEvents: [] });
  const key = `meet:${createHash("sha256").update("meet.google.com/abc-defg-hij").digest("hex")}`;
  engine.handleCalendarReminder(event);
  callDetector.emit("call-active", { key, service: "meet" });
  assert.equal(shown.length, 1);
});

test("a confirmed Meet call suppresses its later calendar reminder", () => {
  const { engine, callDetector, reminderScheduler, shown } = createEngine();
  const { createHash } = require("node:crypto");
  const event = {
    id: "calendar-2", start_time: new Date(Date.now() + 60_000).toISOString(),
    hangout_link: "https://meet.google.com/abc-defg-hij", calendar_id: "calendar-2",
  };
  reminderScheduler.getActiveMeetingState = () => ({ activeMeeting: event, upcomingEvents: [] });
  const key = `meet:${createHash("sha256").update("meet.google.com/abc-defg-hij").digest("hex")}`;
  callDetector.emit("call-active", { key, service: "meet" });
  engine.handleCalendarReminder(event);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].variant, "detected");
});

test("a meeting app appearing asks the mic detector to re-evaluate unattributed activity", () => {
  const { audioDetector, processDetector, shown } = createEngine();

  processDetector.emit("meeting-process-detected", {
    processKey: "zoom",
    appName: "Zoom",
    detectedAt: 0,
  });

  assert.equal(audioDetector.meetingAppNotifications, 1);
  assert.equal(shown.length, 0, "a running meeting app alone stays context-only");
});
