// @probe-name "the full calendar manager graph compiles under strict settings"
// @probe-codes []
// @probe-origin test/scripts/calendarManagersTypeProbe.test.js
import { GoogleCalendarManager } from "./src/helpers/googleCalendarManager.ts";
import {
  MicrosoftCalendarManager,
  normalizeGraphDateTime,
} from "./src/helpers/microsoftCalendarManager.ts";
import { AppleCalendarManager } from "./src/helpers/appleCalendarManager.ts";
import { GoogleCalendarOAuth } from "./src/helpers/googleCalendarOAuth.ts";
import { MicrosoftCalendarOAuth } from "./src/helpers/microsoftCalendarOAuth.ts";
import {
  CalendarSyncInterval,
  FOCUS_SYNC_THROTTLE_MS,
} from "./src/helpers/calendarSyncInterval.ts";
import { CalendarReminderScheduler } from "./src/helpers/calendarReminderScheduler.ts";
import {
  runOAuthLoopbackFlow,
  OAuthFlowError,
  type OAuthFlowResult,
} from "./src/helpers/oauthLoopbackFlow.ts";
import type {
  CalendarEventRow,
  GoogleTokenRow,
  MicrosoftTokenRow,
  AppleCalendarRow,
  GoogleCalendarRow,
  MicrosoftCalendarRow,
  CalendarAccountRow,
} from "./src/helpers/database.ts";

const emptyEvents: CalendarEventRow[] = [];
const db = {
  getGoogleAccounts: (): CalendarAccountRow[] => [],
  getAllGoogleTokens: (): GoogleTokenRow[] => [],
  getGoogleTokens: (): GoogleTokenRow | null => null,
  getGoogleTokensByEmail: (_: string): GoogleTokenRow | null => null,
  refreshGoogleTokens: () => ({ success: true }),
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
  upsertGooglePeople: () => undefined,
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
  refreshMicrosoftTokens: () => ({ success: true }),
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
  // The manager keeps the historical WindowManagerLike parameter (all-optional
  // members); main.ts passes the real manager, the probe passes the shape.
  const google = new GoogleCalendarManager(db, {}, reminderDeps);
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
