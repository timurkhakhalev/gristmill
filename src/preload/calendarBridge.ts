// Renderer-facing calendar integration bridge: the Google/Microsoft/Apple
// commands plus the six provider events. The sandboxed preload can't require
// local modules, so build-main.js bundles the final preload with esbuild
// before packaging. Event payloads are validated before the callback;
// malformed events are dropped, and every subscription returns an idempotent
// unsubscribe.
import {
  appleConnectResultSchema,
  appleConnectionStatusSchema,
  calendarAccountsEventSchema,
  calendarCommandResultSchema,
  calendarEventArgsSchema,
  calendarEventResultSchema,
  calendarIntegrationChannels,
  calendarSelectionArgsSchema,
  calendarSyncedEventSchema,
  disconnectArgsSchema,
  googleCalendarsResultSchema,
  googleConnectionStatusSchema,
  microsoftConnectionStatusSchema,
  oauthResultSchema,
  primaryOnlyArgsSchema,
  upcomingEventsArgsSchema,
  upcomingEventsResultSchema,
  type CalendarIntegrationApi,
  type CalendarCommandResult,
  type CalendarEventResult,
  type CalendarOAuthResult,
  type GoogleCalendarsResult,
  type GoogleConnectionStatus,
  type MicrosoftConnectionStatus,
  type AppleConnectResult,
  type AppleConnectionStatus,
  type UpcomingEventsResult,
} from "../contracts/calendar.js";
import type { ZodType } from "zod";

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
}

function parseResult<T>(schema: ZodType<T>, raw: unknown, channel: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Unexpected response shape from ${channel}`);
  }
  return result.data;
}

function subscribeValidated<T>(
  ipcRenderer: IpcRendererLike,
  channel: string,
  schema: ZodType<T>,
  callback: (data: T) => void
): () => void {
  const listener = (_event: unknown, ...args: unknown[]) => {
    const parsed = schema.safeParse(args[0]);
    if (!parsed.success) return;
    callback(parsed.data);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

// The return type is the shared CalendarIntegrationApi, so any drift between
// this implementation and the contract fails compilation.
export function createCalendarIntegrationBridge(
  ipcRenderer: IpcRendererLike
): CalendarIntegrationApi {
  const invoke = async <T>(channel: string, schema: ZodType<T>, ...args: unknown[]): Promise<T> => {
    const raw = await ipcRenderer.invoke(channel, ...args);
    return parseResult(schema, raw, channel);
  };

  return {
    gcalStartOAuth: (): Promise<CalendarOAuthResult> =>
      invoke(
        calendarIntegrationChannels.gcalStartOAuth,
        oauthResultSchema
      ),

    gcalDisconnect: (email?: string): Promise<CalendarCommandResult> => {
      if (!disconnectArgsSchema.safeParse([email]).success) {
        return Promise.resolve({ success: false, error: "Invalid disconnect request" });
      }
      return invoke(calendarIntegrationChannels.gcalDisconnect, calendarCommandResultSchema, email);
    },

    gcalGetConnectionStatus: (): Promise<GoogleConnectionStatus> =>
      invoke(
        calendarIntegrationChannels.gcalGetConnectionStatus,
        googleConnectionStatusSchema
      ),

    gcalGetCalendars: (): Promise<GoogleCalendarsResult> =>
      invoke(calendarIntegrationChannels.gcalGetCalendars, googleCalendarsResultSchema),

    gcalSetCalendarSelection: (
      calendarId: string,
      isSelected: boolean
    ): Promise<CalendarCommandResult> => {
      if (!calendarSelectionArgsSchema.safeParse([calendarId, isSelected]).success) {
        return Promise.resolve({ success: false, error: "Invalid calendar selection request" });
      }
      return invoke(
        calendarIntegrationChannels.gcalSetCalendarSelection,
        calendarCommandResultSchema,
        calendarId,
        isSelected
      );
    },

    gcalSetPrimaryOnly: (value: boolean): Promise<CalendarCommandResult> => {
      if (!primaryOnlyArgsSchema.safeParse([value]).success) {
        return Promise.resolve({ success: false, error: "Invalid request" });
      }
      return invoke(calendarIntegrationChannels.gcalSetPrimaryOnly, calendarCommandResultSchema, value);
    },

    gcalSyncEvents: (): Promise<CalendarCommandResult> =>
      invoke(calendarIntegrationChannels.gcalSyncEvents, calendarCommandResultSchema),

    gcalGetUpcomingEvents: (windowMinutes?: number): Promise<UpcomingEventsResult> => {
      if (!upcomingEventsArgsSchema.safeParse([windowMinutes]).success) {
        return Promise.resolve({ success: false, events: [] });
      }
      return invoke(
        calendarIntegrationChannels.gcalGetUpcomingEvents,
        upcomingEventsResultSchema,
        windowMinutes
      );
    },

    gcalGetEvent: (eventId: string): Promise<CalendarEventResult> => {
      if (!calendarEventArgsSchema.safeParse([eventId]).success) {
        return Promise.resolve({ success: false, event: null });
      }
      return invoke(calendarIntegrationChannels.gcalGetEvent, calendarEventResultSchema, eventId);
    },

    mcalStartOAuth: (): Promise<CalendarOAuthResult> =>
      invoke(calendarIntegrationChannels.mcalStartOAuth, oauthResultSchema),

    mcalDisconnect: (email?: string): Promise<CalendarCommandResult> => {
      if (!disconnectArgsSchema.safeParse([email]).success) {
        return Promise.resolve({ success: false, error: "Invalid disconnect request" });
      }
      return invoke(calendarIntegrationChannels.mcalDisconnect, calendarCommandResultSchema, email);
    },

    mcalGetConnectionStatus: (): Promise<MicrosoftConnectionStatus> =>
      invoke(
        calendarIntegrationChannels.mcalGetConnectionStatus,
        microsoftConnectionStatusSchema
      ),

    mcalSetPrimaryOnly: (value: boolean): Promise<CalendarCommandResult> => {
      if (!primaryOnlyArgsSchema.safeParse([value]).success) {
        return Promise.resolve({ success: false, error: "Invalid request" });
      }
      return invoke(calendarIntegrationChannels.mcalSetPrimaryOnly, calendarCommandResultSchema, value);
    },

    acalConnect: (): Promise<AppleConnectResult> =>
      invoke(calendarIntegrationChannels.acalConnect, appleConnectResultSchema),

    acalDisconnect: (): Promise<CalendarCommandResult> =>
      invoke(calendarIntegrationChannels.acalDisconnect, calendarCommandResultSchema),

    acalGetConnectionStatus: (): Promise<AppleConnectionStatus> =>
      invoke(
        calendarIntegrationChannels.acalGetConnectionStatus,
        appleConnectionStatusSchema
      ),

    openCalendarPrivacySettings: (): Promise<{ success: boolean; error?: string }> =>
      invoke(calendarIntegrationChannels.openCalendarPrivacySettings, calendarCommandResultSchema).then(
        (result) =>
          result.success === false
            ? { success: false, ...(result.error !== undefined ? { error: result.error } : {}) }
            : { success: true }
      ),

    onGcalConnectionChanged: (callback: (data: { accounts: Array<{ email: string }> }) => void) =>
      subscribeValidated(
        ipcRenderer,
        calendarIntegrationChannels.gcalConnectionChanged,
        calendarAccountsEventSchema,
        callback
      ),

    onGcalEventsSynced: (callback: () => void) =>
      subscribeValidated(
        ipcRenderer,
        calendarIntegrationChannels.gcalEventsSynced,
        calendarSyncedEventSchema,
        callback
      ),

    onMcalConnectionChanged: (callback: (data: { accounts: Array<{ email: string }> }) => void) =>
      subscribeValidated(
        ipcRenderer,
        calendarIntegrationChannels.mcalConnectionChanged,
        calendarAccountsEventSchema,
        callback
      ),

    onMcalEventsSynced: (callback: () => void) =>
      subscribeValidated(
        ipcRenderer,
        calendarIntegrationChannels.mcalEventsSynced,
        calendarSyncedEventSchema,
        callback
      ),

    onAcalConnectionChanged: (callback: (data: AppleConnectionStatus) => void) =>
      subscribeValidated(
        ipcRenderer,
        calendarIntegrationChannels.acalConnectionChanged,
        appleConnectionStatusSchema,
        callback
      ),

    onAcalEventsSynced: (callback: () => void) =>
      subscribeValidated(
        ipcRenderer,
        calendarIntegrationChannels.acalEventsSynced,
        calendarSyncedEventSchema,
        callback
      ),
  };
}
