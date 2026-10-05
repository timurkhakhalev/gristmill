const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const Module = require("node:module");

const { EventEmitter } = require("node:events");

import type { MeetingNotificationData } from "../../src/contracts/meetingCoordinator";

const {
  createMeetingDetectionClock,
}: typeof import("../lib/meetingDetectionClock.ts") = require("../lib/meetingDetectionClock.ts");

const enginePath = require.resolve("../../src/helpers/meetingDetectionEngine");

const originalLoad = Module._load;

function loadEngine() {
  delete require.cache[enginePath];

  Module._load = function loadWithMocks(request: string, parent: unknown, isMain: boolean) {
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
      return {
        getMeetingJoinUrl: (event: { hangout_link?: string } | null) => event?.hangout_link ?? null,
      };
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
  const clock = createMeetingDetectionClock();

  const reminderScheduler: {
    getActiveMeetingState: () => {
      activeMeeting: Record<string, unknown> | null;
      upcomingEvents: unknown[];
      activeEvents?: unknown[];
    };
  } = {
    getActiveMeetingState: () => ({ activeMeeting: null, activeEvents: [], upcomingEvents: [] }),
  };

  const processDetector = new EventEmitter();
  processDetector.starts = 0;
  processDetector.stops = 0;
  processDetector.start = () => {
    processDetector.starts++;
  };

  processDetector.stop = () => {
    processDetector.stops++;
  };

  const audioDetector = new EventEmitter();
  audioDetector.dismissals = 0;
  audioDetector.dismiss = () => audioDetector.dismissals++;
  audioDetector.resetPrompt = () => {};

  audioDetector.setUserRecording = () => {};

  audioDetector.setMicWarmHold = () => {};

  audioDetector.meetingAppNotifications = 0;
  audioDetector.notifyMeetingAppsChanged = () => audioDetector.meetingAppNotifications++;
  audioDetector.starts = 0;
  audioDetector.stops = 0;
  audioDetector.start = () => {
    audioDetector.starts++;
  };

  audioDetector.stop = () => {
    audioDetector.stops++;
  };

  const callDetector = new EventEmitter();
  callDetector.starts = 0;
  callDetector.stops = 0;
  callDetector.start = () => {
    callDetector.starts++;
  };

  callDetector.stop = () => {
    callDetector.stops++;
  };

  const shown: MeetingNotificationData[] = [];

  const windowManager = {
    notificationPrefs: {},
    showMeetingNotification: (data: MeetingNotificationData) => shown.push(data),
    dismissMeetingNotification: () => {},
    queueMeetingNoteNavigation: async () => {},
  };

  const engine = new MeetingDetectionEngine(
    reminderScheduler,
    processDetector,
    audioDetector,
    windowManager,
    {},
    { callDetector, ...clock }
  );

  return { clock, engine, audioDetector, callDetector, processDetector, shown, reminderScheduler };
}

function detectionAt(shown: MeetingNotificationData[], index: number) {
  const data = shown[index];

  if (data?.kind !== "detection") throw new Error(`Expected detection notification at ${index}`);

  return data;
}

test("microphone activity alone cannot show a meeting prompt", () => {
  const { audioDetector, shown } = createEngine();
  audioDetector.emit("sustained-audio-detected", { durationMs: 2000, detectedAt: 0 });
  assert.equal(shown.length, 0);
});

test("a call retries when startup prevents its notification from being shown", async () => {
  const { engine, callDetector, shown } = createEngine();
  let ready = false;
  engine.windowManager.showMeetingNotification = async (data: MeetingNotificationData) => {
    if (!ready) return false;
    shown.push(data);

    return true;
  };

  const call = { key: `meet:${"a".repeat(64)}`, service: "meet" };
  callDetector.emit("call-active", call);
  await Promise.resolve();
  assert.equal(engine.activeDetections.size, 0);
  assert.equal(engine.offeredCalls.has(call.key), false);
  ready = true;
  callDetector.emit("call-active", call);
  await Promise.resolve();
  assert.equal(shown.length, 1);
  callDetector.emit("call-active", call);
  assert.equal(shown.length, 1);
});

test("a failed notification load releases the call for retry", async () => {
  const { engine, callDetector } = createEngine();
  engine.windowManager.showMeetingNotification = async () => {
    throw new Error("load failed");
  };

  const call = { key: `meet:${"b".repeat(64)}`, service: "meet" };
  callDetector.emit("call-active", call);
  await new Promise(setImmediate);
  assert.equal(engine.activeDetections.size, 0);
  assert.equal(engine.offeredCalls.has(call.key), false);
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
  await engine.handleNotificationResponse(detectionAt(shown, 0).detectionId, "dismiss");
  callDetector.emit("call-active", { key: "zoom:123", service: "zoom" });
  assert.equal(shown.length, 1);
});

test("a confirmed new call can prompt after the previous one ends", () => {
  const { engine, callDetector, shown } = createEngine();

  callDetector.emit("call-active", { key: "zoom:123", service: "zoom" });
  engine.handleDetectionNotificationClosed(detectionAt(shown, 0).detectionId);
  callDetector.emit("call-ended", { key: "zoom:123" });
  callDetector.emit("call-active", { key: "zoom:123", service: "zoom" });

  assert.equal(shown.length, 2);
});

test("calendar reminder and confirmed Meet call share one offer", () => {
  const { clock, engine, callDetector, reminderScheduler, shown } = createEngine();
  const { createHash }: typeof import("node:crypto") = require("node:crypto");

  const event = {
    id: "calendar-1",
    start_time: new Date(clock.now() + 60_000).toISOString(),
    hangout_link: "https://meet.google.com/abc-defg-hij",
    calendar_id: "calendar-1",
  };

  reminderScheduler.getActiveMeetingState = () => ({ activeMeeting: event, upcomingEvents: [] });
  const key = `meet:${createHash("sha256").update("meet.google.com/abc-defg-hij").digest("hex")}`;
  engine.handleCalendarReminder(event);
  callDetector.emit("call-active", { key, service: "meet" });
  assert.equal(shown.length, 1);
});

test("a later call can prompt after the call tied to a calendar offer ends", () => {
  const { clock, engine, callDetector, reminderScheduler, shown } = createEngine();
  const { createHash }: typeof import("node:crypto") = require("node:crypto");

  const event = {
    id: "calendar-rejoin",
    start_time: new Date(clock.now() + 60_000).toISOString(),
    hangout_link: "https://meet.google.com/abc-defg-hij",
    calendar_id: "calendar-rejoin",
  };

  reminderScheduler.getActiveMeetingState = () => ({ activeMeeting: event, upcomingEvents: [] });
  const key = `meet:${createHash("sha256").update("meet.google.com/abc-defg-hij").digest("hex")}`;

  engine.handleCalendarReminder(event);
  callDetector.emit("call-active", { key, service: "meet" });
  callDetector.emit("call-ended", { key });
  callDetector.emit("call-active", { key, service: "meet" });

  assert.equal(shown.length, 2);
  assert.equal(detectionAt(shown, 1).source, "audio");
});

test("a calendar offer without a join link does not hide an unrelated call", () => {
  const { clock, engine, callDetector, reminderScheduler, shown } = createEngine();

  const event = {
    id: "calendar-unlinked",
    start_time: new Date(clock.now() + 60_000).toISOString(),
    calendar_id: "calendar-unlinked",
    attendees: [{ email: "teammate@example.com" }],
  };

  reminderScheduler.getActiveMeetingState = () => ({ activeMeeting: event, upcomingEvents: [] });

  engine.handleCalendarReminder(event);
  callDetector.emit("call-active", { key: "zoom:123", service: "zoom" });

  assert.equal(shown.length, 2);
  assert.equal(detectionAt(shown, 1).source, "audio");
});

test("a confirmed Meet call suppresses its later calendar reminder", () => {
  const { clock, engine, callDetector, reminderScheduler, shown } = createEngine();
  const { createHash }: typeof import("node:crypto") = require("node:crypto");

  const event = {
    id: "calendar-2",
    start_time: new Date(clock.now() + 60_000).toISOString(),
    hangout_link: "https://meet.google.com/abc-defg-hij",
    calendar_id: "calendar-2",
  };

  reminderScheduler.getActiveMeetingState = () => ({ activeMeeting: event, upcomingEvents: [] });
  const key = `meet:${createHash("sha256").update("meet.google.com/abc-defg-hij").digest("hex")}`;
  callDetector.emit("call-active", { key, service: "meet" });
  engine.handleCalendarReminder(event);
  assert.equal(shown.length, 1);
  assert.equal(detectionAt(shown, 0).variant, "detected");
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

function createEngineWithNotes(existingNote: { id: number; folder_id: number | null } | null) {
  const MeetingDetectionEngine = loadEngine();

  const noop = Object.assign(new EventEmitter(), {
    start() {},
    stop() {},
    resetPrompt() {},
    setUserRecording() {},
    setMicWarmHold() {},
  });

  const saved: Array<[string, string]> = [];
  const updates: Array<[number, Record<string, unknown>]> = [];
  const navigations: unknown[] = [];

  const database = {
    saveNote: (title: string, content: string) => {
      saved.push([title, content]);

      return { note: { id: 42 } };
    },
    getNoteByCalendarEventId: () => existingNote,
    getCalendarEventById: (id: string) =>
      id === "evt-1" ? { id: "evt-1", summary: "Design review", attendees: "[]" } : null,
    updateNote: (id: number, update: Record<string, unknown>) => {
      updates.push([id, update]);

      return { success: true, note: { id } };
    },
    getActiveEvents: () => [],
  };

  const engine = new MeetingDetectionEngine(
    { getActiveMeetingState: () => ({ activeMeeting: null, upcomingEvents: [] }) },
    noop,
    noop,
    {
      notificationPrefs: {},
      queueMeetingNoteNavigation: async (payload: unknown) => navigations.push(payload),
    },
    database,
    { callDetector: noop }
  );

  return { engine, saved, updates, navigations };
}

test("an event's note is created only on request, with the user's first input", () => {
  const { engine, saved, updates, navigations } = createEngineWithNotes(null);

  // Looking an event up never creates its note.
  assert.equal(engine.findCalendarEventNote("evt-1"), null);
  assert.deepEqual(saved, []);

  assert.deepEqual(engine.createCalendarEventNote("evt-1", { content: "First line" }), {
    noteId: 42,
    folderId: null,
  });
  assert.deepEqual(saved, [["Design review", "First line"]]);
  assert.deepEqual(updates, [[42, { calendar_event_id: "evt-1", participants: "[]" }]]);
  // Recording starts only through meeting navigation; creating must not queue it.
  assert.deepEqual(navigations, []);
  assert.equal(engine._meetingModeActive, false);
});

test("a typed title replaces the event name on the new note", () => {
  const { engine, saved } = createEngineWithNotes(null);

  engine.createCalendarEventNote("evt-1", { title: "Prep: design review" });
  assert.deepEqual(saved, [["Prep: design review", ""]]);
});

test("an event with a note reuses it and leaves it untouched", () => {
  const { engine, saved } = createEngineWithNotes({ id: 5, folder_id: 3 });

  assert.deepEqual(engine.findCalendarEventNote("evt-1"), { noteId: 5, folderId: 3 });
  assert.deepEqual(engine.createCalendarEventNote("evt-1", { content: "ignored" }), {
    noteId: 5,
    folderId: 3,
    existing: true,
  });
  assert.deepEqual(saved, []);
});

test("an unknown calendar event gets no note", () => {
  const { engine, saved } = createEngineWithNotes(null);

  assert.equal(engine.createCalendarEventNote("missing", {}), null);
  assert.deepEqual(saved, []);
});

test("an event's note stores attendees under their best-known names", () => {
  const MeetingDetectionEngine = loadEngine();

  const noop = Object.assign(new EventEmitter(), {
    start() {},
    stop() {},
    resetPrompt() {},
    setUserRecording() {},
    setMicWarmHold() {},
  });

  const updates: Array<Record<string, unknown>> = [];

  const engine = new MeetingDetectionEngine(
    { getActiveMeetingState: () => ({ activeMeeting: null, upcomingEvents: [] }) },
    noop,
    noop,
    { notificationPrefs: {} },
    {
      saveNote: () => ({ note: { id: 1 } }),
      getNoteByCalendarEventId: () => null,
      getCalendarEventById: () => ({
        id: "evt-1",
        summary: "Sync",
        attendees: JSON.stringify([
          { email: "Eli.Rum@example.com", displayName: null },
          { email: "k@x.com", displayName: "Kostya" },
          { email: "unknown@x.com", displayName: null },
        ]),
      }),
      getContactProfiles: () => [{ email: "eli.rum@example.com", display_name: "Eli Rum" }],
      updateNote: (_id: number, update: Record<string, unknown>) => {
        updates.push(update);

        return { success: true };
      },
      getActiveEvents: () => [],
    },
    { callDetector: noop }
  );

  engine.createCalendarEventNote("evt-1", {});

  assert.deepEqual(JSON.parse(updates[0].participants as string), [
    { email: "Eli.Rum@example.com", displayName: "Eli Rum" },
    { email: "k@x.com", displayName: "Kostya" },
    { email: "unknown@x.com", displayName: null },
  ]);
});

test("calendar matching uses the injected five-minute window and scheduled variant", () => {
  const { clock, engine, reminderScheduler, shown } = createEngine();
  const event = { id: "clock-event", start_time: new Date(clock.now() + 300_001).toISOString() };
  reminderScheduler.getActiveMeetingState = () => ({
    activeMeeting: null,
    upcomingEvents: [event],
  });
  assert.equal(engine._findCalendarEvent(), null);
  clock.advance(1);
  assert.equal(engine._findCalendarEvent(), event);
  engine.handleCalendarReminder(event);
  assert.equal(detectionAt(shown, 0).variant, "starting");
  assert.equal(engine.activeDetections.get("calendar:clock-event").data.detectedAt, clock.now());
  clock.advance(300_000);
  assert.equal(engine._findCalendarEvent(), null);
  engine.handleCalendarReminder({ ...event, id: "started-event" });
  assert.equal(detectionAt(shown, 1).variant, "underway");
  engine.stop();
});

test("detected and manual placeholder events use the injected timestamp", async () => {
  const { clock, engine, callDetector, shown } = createEngine();
  callDetector.emit("call-active", { key: "zoom:clock", service: "zoom" });
  const detected = detectionAt(shown, 0).event;
  assert.ok(detected && "id" in detected && "start_time" in detected && "end_time" in detected);
  assert.equal(detected.id, `detected-${clock.now()}`);
  assert.equal(detected.start_time, new Date(clock.now()).toISOString());
  assert.equal(detected.end_time, new Date(clock.now() + 3_600_000).toISOString());
  const navigations: Array<{ event: { id: string; start_time: string } }> = [];
  engine.databaseManager.getActiveEvents = () => [];
  engine.databaseManager.saveNote = () => ({ note: { id: 42, folder_id: null } });
  engine.windowManager.queueMeetingNoteNavigation = async (data: {
    event: { id: string; start_time: string };
  }) => {
    navigations.push(data);
  };

  clock.advance(500);
  await engine.startManualMeeting();
  const navigation = navigations[0];
  assert.ok(navigation);
  assert.equal(navigation.event.id, `manual-${clock.now()}`);
  assert.equal(navigation.event.start_time, new Date(clock.now()).toISOString());
  engine.stop();
});

// Issue #173: the notification toggles now reach main reactively, and the
// desktop settings handler re-applies the same audio gate on every sync. A
// redundant sync (the value main already holds) must not restart the detached
// detectors — only an actual change may.
test("setPreferences does not restart detectors when a value is unchanged", () => {
  const { engine, audioDetector, callDetector, processDetector } = createEngine();

  engine.setPreferences({ audioDetection: false, processDetection: false });
  assert.equal(audioDetector.starts, 0);
  assert.equal(audioDetector.stops, 1);
  assert.equal(callDetector.stops, 1);
  assert.equal(processDetector.stops, 1);
  assert.deepEqual(engine.getPreferences(), { processDetection: false, audioDetection: false });

  // Re-sending the exact same values is a no-op: no detector is touched again.
  engine.setPreferences({ audioDetection: false, processDetection: false });
  assert.equal(audioDetector.starts, 0);
  assert.equal(audioDetector.stops, 1, "a redundant audio sync must not stop again");
  assert.equal(callDetector.stops, 1, "a redundant audio sync must not touch the call detector");
  assert.equal(processDetector.stops, 1, "a redundant process sync must not stop again");

  // A real change re-applies only the changed gate.
  engine.setPreferences({ audioDetection: true });
  assert.equal(audioDetector.starts, 1, "re-enabling audio starts the detector");
  assert.equal(callDetector.starts, 1);
  assert.equal(processDetector.starts, 0, "the unchanged process gate is not restarted");
  engine.stop();
});

// The master toggle is enforced by main notifying the engine with the derived
// audio gate; re-enabling after a disable must start detection again.
test("setPreferences re-enables detection after a disable", () => {
  const { engine, audioDetector } = createEngine();
  engine.setPreferences({ audioDetection: false });
  assert.equal(engine.getPreferences().audioDetection, false);
  engine.setPreferences({ audioDetection: true });
  assert.equal(engine.getPreferences().audioDetection, true);
  assert.equal(audioDetector.starts, 1);
  engine.stop();
});
