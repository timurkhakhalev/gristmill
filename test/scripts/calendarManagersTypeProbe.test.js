// Strict compiler probes for the migrated calendar managers/OAuth/reminders:
// provider payload types stay internal, dependency surfaces are narrow, and
// wrong usage must fail compilation. Codes verified against a real tsc run.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");
const configPath = path.join(root, "tsconfig.main.json");

function probeDiagnostics(source) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsed.options.strict, true);
  const probe = path.join(root, "calendar-managers-type-probe.ts");
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...args) =>
    file === probe
      ? ts.createSourceFile(file, source, languageVersion, true)
      : readSource(file, languageVersion, ...args);
  const program = ts.createProgram([probe], { ...parsed.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  return {
    codes: diagnostics.map((d) => d.code).sort((a, b) => a - b),
    cleanup: () => {
      if (fs.existsSync(probe)) fs.rmSync(probe, { force: true });
    },
  };
}

test("wrong manager/OAuth/scheduler usage fails compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { GoogleCalendarManager } from "./src/helpers/googleCalendarManager.ts";
import { MicrosoftCalendarManager } from "./src/helpers/microsoftCalendarManager.ts";
import { AppleCalendarManager } from "./src/helpers/appleCalendarManager.ts";
import { GoogleCalendarOAuth } from "./src/helpers/googleCalendarOAuth.ts";
import { MicrosoftCalendarOAuth } from "./src/helpers/microsoftCalendarOAuth.ts";
import { CalendarSyncInterval } from "./src/helpers/calendarSyncInterval.ts";
import { CalendarReminderScheduler } from "./src/helpers/calendarReminderScheduler.ts";
import { normalizeGraphDateTime } from "./src/helpers/microsoftCalendarManager.ts";

// Managers take (databaseManager, [windowManager], reminderScheduler); a
// database-only wiring must not compile.
new GoogleCalendarManager({});
new MicrosoftCalendarManager({});
new AppleCalendarManager({});

// The reminder scheduler needs the calendar DB surface, not any object.
new CalendarReminderScheduler({});

// Interval runner requires the full options object.
new CalendarSyncInterval(async () => {}, { intervalMs: 1000 });

// Graph datetime normalization takes { dateTime }, not a bare string.
normalizeGraphDateTime("2026-09-15T10:00:00.0000000", false);

// OAuth needs the token DB; a scheduler is not one.
new GoogleCalendarOAuth({});
new MicrosoftCalendarOAuth({});
`);
  try {
    assert.ok(codes.length > 0, "wrong usage must not compile");
    // Verified against an actual strict run: TS2345 ×5 (arg type mismatches),
    // TS2554 ×3 (wrong arity for the oauth/scheduler constructors).
    assert.equal(codes.filter((code) => code === 2345).length, 5);
    assert.equal(codes.filter((code) => code === 2554).length, 3);
  } finally {
    cleanup();
  }
});

test("the full calendar manager graph compiles under strict settings", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { GoogleCalendarManager } from "./src/helpers/googleCalendarManager.ts";
import { MicrosoftCalendarManager, normalizeGraphDateTime } from "./src/helpers/microsoftCalendarManager.ts";
import { AppleCalendarManager } from "./src/helpers/appleCalendarManager.ts";
import { GoogleCalendarOAuth } from "./src/helpers/googleCalendarOAuth.ts";
import { MicrosoftCalendarOAuth } from "./src/helpers/microsoftCalendarOAuth.ts";
import { CalendarSyncInterval, FOCUS_SYNC_THROTTLE_MS } from "./src/helpers/calendarSyncInterval.ts";
import { CalendarReminderScheduler } from "./src/helpers/calendarReminderScheduler.ts";
import { runOAuthLoopbackFlow, OAuthFlowError, type OAuthFlowResult } from "./src/helpers/oauthLoopbackFlow.ts";
import type { CalendarEventRow, GoogleTokenRow, MicrosoftTokenRow, AppleCalendarRow, GoogleCalendarRow, MicrosoftCalendarRow, CalendarAccountRow } from "./src/helpers/database.ts";

const emptyEvents: CalendarEventRow[] = [];
const db = {
  getGoogleAccounts: (): CalendarAccountRow[] => [],
  getAllGoogleTokens: (): GoogleTokenRow[] => [],
  getGoogleTokens: (): GoogleTokenRow | null => null,
  getGoogleTokensByEmail: (_: string): GoogleTokenRow | null => null,
  saveGoogleTokens: () => undefined,
  removeGoogleAccount: () => undefined,
  clearGoogleCalendarData: () => undefined,
  saveGoogleCalendars: () => undefined,
  getGoogleCalendars: (): GoogleCalendarRow[] => [],
  getSelectedCalendars: (): GoogleCalendarRow[] => [],
  applyPrimaryOnlyToSelection: () => undefined,
  updateCalendarSelection: () => undefined,
  removeEventsFromDeselectedCalendars: () => undefined,
  upsertCalendarEvents: () => undefined,
  removeCalendarEvents: () => undefined,
  removeStaleCalendarEvents: () => undefined,
  updateCalendarSyncToken: () => undefined,
  upsertContacts: () => undefined,
  getUpcomingEvents: (_windowMinutes?: number): CalendarEventRow[] => emptyEvents,
  getActiveEvents: (): CalendarEventRow[] => emptyEvents,
  getMicrosoftAccounts: (): CalendarAccountRow[] => [],
  removeMicrosoftAccount: () => undefined,
  clearMicrosoftCalendarData: () => undefined,
  saveMicrosoftCalendars: () => undefined,
  getSelectedMicrosoftCalendars: (): MicrosoftCalendarRow[] => [],
  applyMicrosoftPrimaryOnlyToSelection: () => undefined,
  updateMicrosoftCalendarSyncToken: () => undefined,
  getMicrosoftTokensByEmail: (_: string): MicrosoftTokenRow | null => null,
  saveMicrosoftTokens: () => undefined,
  getCalendarEventById: () => null,
  getAppleCalendars: (): AppleCalendarRow[] => [],
  saveAppleCalendars: () => undefined,
  replaceAppleCalendarEvents: () => undefined,
  clearAppleCalendarData: () => undefined,
};
const reminderDeps = {
  scheduleNextMeeting: () => undefined,
  reset: (_?: string | null) => undefined,
  reconcileProvider: (_: string) => undefined,
};

async function useAll(): Promise<string> {
  const google = new GoogleCalendarManager(db, null, reminderDeps);
  const microsoft = new MicrosoftCalendarManager(db, reminderDeps);
  const apple = new AppleCalendarManager(db, reminderDeps);

  google.start();
  await google.startOAuth();
  await google.fetchCalendars();
  await google.syncEvents();
  await google.setPrimaryOnly(false);
  await google.setCalendarSelection("cal-1", true);
  void google.getConnectionStatus().accounts[0]?.email;
  google.disconnect("a@b.c");
  google.revokeAllTokens();
  google.onWakeFromSleep();
  google.syncOnFocus();
  google.stop();

  microsoft.start();
  await microsoft.startOAuth();
  await microsoft.fetchCalendars();
  await microsoft.syncEvents();
  await microsoft.setPrimaryOnly(true);
  void microsoft.getConnectionStatus().configured;
  microsoft.disconnect();
  microsoft.onWakeFromSleep();
  microsoft.syncOnFocus();
  microsoft.stop();

  const connected = await apple.connect();
  if (!connected.success) {
    void connected.reason;
  }
  void apple.getConnectionStatus().sourceNames;
  apple.syncOnFocus();
  apple.onWakeFromSleep();
  apple.disconnect();
  apple.stop();

  const scheduler = new CalendarReminderScheduler(db);
  scheduler.scheduleNextMeeting();
  scheduler.onMeetingStart(db.getUpcomingEvents(1)[0] as CalendarEventRow);
  scheduler.onMeetingEnd();
  scheduler.onWakeFromSleep();
  scheduler.getActiveMeetingState();
  scheduler.reconcileProvider("google");
  scheduler.reset();
  scheduler.stop();

  const interval = new CalendarSyncInterval(async () => {}, {
    intervalMs: 1000,
    maxIntervalMs: 30000,
    logScope: "probe",
  });
  interval.start();
  interval.syncOnFocus();
  interval.notifySuccess();
  interval.stop();

  const googleOAuth = new GoogleCalendarOAuth(db);
  void googleOAuth.isConfigured();
  await googleOAuth.getValidAccessToken(null);
  const msOAuth = new MicrosoftCalendarOAuth(db);
  void msOAuth.isConfigured();
  await msOAuth.getValidAccessToken("a@b.c");

  void FOCUS_SYNC_THROTTLE_MS;
  void normalizeGraphDateTime({ dateTime: "2026-09-15T10:00:00.0000000" }, true);

  const flow: Promise<OAuthFlowResult> = runOAuthLoopbackFlow({
    buildAuthUrl: (redirectUri, state, challenge) => redirectUri + "?" + state + "&" + challenge,
    handleCallback: async (code) => {
      if (code === "bad") throw new OAuthFlowError("token_exchange_failed", "no");
      return { success: true, email: "a@b.c" };
    },
  });
  void flow;

  return "ok";
}
void useAll;
`);
  try {
    assert.deepEqual(codes, []);
  } finally {
    cleanup();
  }
});
