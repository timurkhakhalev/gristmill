// @probe-name "the full registration, bridge and contract compile under strict settings"
// @probe-codes []
// @probe-origin test/scripts/calendarTypeProbe.test.js
import { registerCalendarIntegrationHandlers } from "./src/helpers/calendarIpcHandlers.ts";
import { createCalendarIntegrationBridge } from "./src/preload/calendarBridge.ts";
import {
  projectCalendarEvent,
  projectGoogleCalendarSummary,
  googleConnectionStatusSchema,
  type CalendarEvent,
} from "./src/contracts/calendar.ts";

declare const ipcMain: {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
};

registerCalendarIntegrationHandlers(ipcMain, {
  googleManager: {
    startOAuth: async () => ({ success: true, email: "g@x.io" }),
    disconnect: (email?: string) => {
      void email;
    },
    getConnectionStatus: () => ({ connected: true, email: "g@x.io", configured: true }),
    getCalendars: () => [],
    setCalendarSelection: async (calendarId: string, isSelected: boolean) => {
      void calendarId;
      void isSelected;
    },
    setPrimaryOnly: async (value: boolean) => {
      void value;
    },
    syncEvents: async () => {},
  },
  microsoftManager: {
    startOAuth: async () => ({ success: true, email: "m@x.io" }),
    disconnect: () => {},
    getConnectionStatus: () => ({ connected: false, accounts: [] }),
    setPrimaryOnly: async () => {},
  },
  appleManager: {
    connect: async () => ({ success: true }),
    disconnect: () => ({ success: true }),
    getConnectionStatus: () => ({ connected: false, sourceNames: [] }),
  },
  getUpcomingEvents: async () => [
    {
      id: "e",
      calendar_id: "c",
      provider: "google",
      summary: null,
      start_time: "2026-09-15",
      end_time: "2026-09-15",
      is_all_day: 0,
      status: "confirmed",
      availability_status: "unknown",
      self_response_status: "unknown",
      hangout_link: null,
      conference_data: null,
      organizer_email: null,
      attendees_count: 0,
      attendees: null,
      synced_at: "x",
    },
  ],
  getCalendarEventById: () => null,
  openCalendarPrivacySettings: async () => ({ success: true }),
  logError: () => {},
});

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
};
const bridge = createCalendarIntegrationBridge(ipcRendererLike);

async function useAll(): Promise<string> {
  const oauth = await bridge.gcalStartOAuth();
  await bridge.gcalDisconnect("g@x.io");
  const status = await bridge.gcalGetConnectionStatus();
  const calendars = await bridge.gcalGetCalendars();
  await bridge.gcalSetCalendarSelection("cal-1", true);
  await bridge.gcalSetPrimaryOnly(false);
  await bridge.gcalSyncEvents();
  const upcoming = await bridge.gcalGetUpcomingEvents(60);
  const single = await bridge.gcalGetEvent("evt-1");
  const mstatus = await bridge.mcalGetConnectionStatus();
  const astatus = await bridge.acalGetConnectionStatus();
  await bridge.acalConnect();
  await bridge.acalDisconnect();
  await bridge.openCalendarPrivacySettings();
  const unsubAccounts = bridge.onGcalConnectionChanged((data) => {
    void data.accounts;
  });
  const unsubSynced = bridge.onGcalEventsSynced(() => {});
  unsubAccounts();
  unsubSynced();
  return [
    oauth.success ? "ok" : "no",
    String(status.connected),
    String(calendars.calendars.length),
    String(upcoming.events.length),
    single.event === null ? "none" : "some",
    String(mstatus.connected),
    String(astatus.sourceNames.length),
  ].join();
}
void useAll;

// The projection drops internals and keeps consumer fields at the type level.
const projected = projectCalendarEvent({
  id: "e",
  calendar_id: "c",
  provider: "google",
  summary: null,
  start_time: "s",
  end_time: "e",
  is_all_day: 0,
  status: "confirmed",
  availability_status: "busy",
  self_response_status: "accepted",
  hangout_link: null,
  conference_data: null,
  organizer_email: null,
  attendees_count: 1,
  attendees: null,
  synced_at: "internal",
});
const wire: CalendarEvent | null = projected;
void wire;
void projectGoogleCalendarSummary;
void googleConnectionStatusSchema;
