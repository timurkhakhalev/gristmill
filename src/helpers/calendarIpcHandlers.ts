// The Google/Microsoft/Apple Calendar integration IPC handlers, moved out of
// ipcHandlers.js. OAuth, sync, reminders and data cleanup stay inside the
// existing (JS) managers — this module only validates arguments before any
// manager/DB work, calls the current operation and projects the result onto
// the wire DTO. `join-calendar-meeting` belongs to the meeting-detection
// boundary and stays there; availability has its own module.
import { type CalendarSyncOutcome } from "./calendarSyncInterval.js";
import {
  appleConnectResultSchema,
  calendarCommandResultSchema,
  calendarEventArgsSchema,
  calendarIntegrationChannels,
  calendarSelectionArgsSchema,
  disconnectArgsSchema,
  googleCalendarsResultSchema,
  googleConnectionStatusSchema,
  microsoftConnectionStatusSchema,
  appleConnectionStatusSchema,
  oauthResultSchema,
  primaryOnlyArgsSchema,
  upcomingEventsArgsSchema,
  projectCalendarEvent,
  projectGoogleCalendarSummary,
  type AppleConnectResult,
  type CalendarCommandResult,
  type CalendarEventResult,
  type CalendarOAuthResult,
  type GoogleCalendarsResult,
  type GoogleConnectionStatus,
  type MicrosoftConnectionStatus,
  type AppleConnectionStatus,
  type UpcomingEventsResult,
} from "../contracts/calendar.js";

type IpcEventListener = (event: unknown, ...args: unknown[]) => unknown;

export interface GoogleCalendarManagerLike {
  startOAuth(): Promise<{ success: boolean; email?: string; error?: string }>;
  disconnect(email?: string): void;
  getConnectionStatus(): GoogleConnectionStatus;
  // Rows feed projectGoogleCalendarSummary, which validates each entry.
  getCalendars(): readonly unknown[];
  setCalendarSelection(calendarId: string, isSelected: boolean): Promise<void>;
  setPrimaryOnly(value: boolean): Promise<void>;
  syncEvents(): Promise<CalendarSyncOutcome | void>;
}

export interface MicrosoftCalendarManagerLike {
  syncEvents(): Promise<CalendarSyncOutcome | void>;
  startOAuth(): Promise<{ success: boolean; email?: string; error?: string }>;
  disconnect(email?: string): void;
  getConnectionStatus(): MicrosoftConnectionStatus;
  setPrimaryOnly(value: boolean): Promise<void>;
}

export interface AppleCalendarManagerLike {
  connect(): Promise<AppleConnectResult>;
  disconnect(): { success: boolean };
  getConnectionStatus(): AppleConnectionStatus;
}

export interface CalendarIntegrationDeps {
  googleManager: GoogleCalendarManagerLike;
  microsoftManager: MicrosoftCalendarManagerLike;
  appleManager: AppleCalendarManagerLike;
  // Provider-neutral event reads keep their current owners: the Google
  // manager reads the shared calendar_events table, and single-event lookup
  // reads the DB directly.
  getUpcomingEvents: (windowMinutes?: number) => Promise<unknown[]>;
  getCalendarEventById: (eventId: string) => unknown;
  openCalendarPrivacySettings: () => Promise<{ success: boolean; error?: string }>;
  logError: (message: string, data?: unknown, tag?: string) => void;
}

interface LoggedError {
  message?: string;
}

// ipcHandlers catch blocks log thrown unknowns; only the optional message is
// read, so this parse is the boundary.
function thrownError(error: unknown): LoggedError {
  if (error instanceof Error) return { message: error.message };

  return {};
}

function parseOr<T>(raw: unknown, parse: (value: unknown) => T | null, fallback: T): T {
  const parsed = parse(raw);

  return parsed === null ? fallback : parsed;
}

export function registerCalendarIntegrationHandlers(
  ipcMain: { handle(channel: string, listener: IpcEventListener): void },
  deps: CalendarIntegrationDeps
): void {
  // --- Google Calendar ---

  ipcMain.handle(
    calendarIntegrationChannels.gcalStartOAuth,
    async (): Promise<CalendarOAuthResult> => {
      try {
        const result = await deps.googleManager.startOAuth();
        const parsed = oauthResultSchema.safeParse(result);

        return parsed.success ? parsed.data : { success: false };
      } catch (error) {
        const err = thrownError(error);
        deps.logError("Google Calendar OAuth failed", { error: err?.message }, "calendar");

        return { success: false, ...(err?.message !== undefined ? { error: err.message } : {}) };
      }
    }
  );

  ipcMain.handle(
    calendarIntegrationChannels.gcalDisconnect,
    async (_event, ...args: unknown[]): Promise<CalendarCommandResult> => {
      const parsedArgs = disconnectArgsSchema.safeParse(args);

      if (!parsedArgs.success) {
        return { success: false, error: "Invalid disconnect request" };
      }

      try {
        deps.googleManager.disconnect(parsedArgs.data[0]);

        return { success: true };
      } catch (error) {
        const err = thrownError(error);
        deps.logError("Google Calendar disconnect failed", { error: err?.message }, "calendar");

        return { success: false, ...(err?.message !== undefined ? { error: err.message } : {}) };
      }
    }
  );

  ipcMain.handle(
    calendarIntegrationChannels.gcalGetConnectionStatus,
    async (): Promise<GoogleConnectionStatus> => {
      try {
        const status = deps.googleManager.getConnectionStatus();
        const parsed = googleConnectionStatusSchema.safeParse(status);

        // Absence versus false is signal: the unconfigured fallback keeps
        // exactly its own field set.
        return parsed.success
          ? parsed.data
          : { connected: false, email: null, sync: { state: "error", requiresReconnect: false } };
      } catch {
        return {
          connected: false,
          email: null,
          sync: { state: "error", requiresReconnect: false },
        };
      }
    }
  );

  ipcMain.handle(
    calendarIntegrationChannels.gcalGetCalendars,
    async (): Promise<GoogleCalendarsResult> => {
      try {
        const calendars = deps.googleManager
          .getCalendars()
          .map(projectGoogleCalendarSummary)
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

        return googleCalendarsResultSchema.parse({ success: true, calendars });
      } catch {
        return { success: false, calendars: [] };
      }
    }
  );

  ipcMain.handle(
    calendarIntegrationChannels.gcalSetCalendarSelection,
    async (_event, ...args: unknown[]): Promise<CalendarCommandResult> => {
      const parsedArgs = calendarSelectionArgsSchema.safeParse(args);

      if (!parsedArgs.success) {
        return { success: false, error: "Invalid calendar selection request" };
      }

      const [calendarId, isSelected] = parsedArgs.data;

      try {
        await deps.googleManager.setCalendarSelection(calendarId, isSelected);

        return { success: true };
      } catch (error) {
        const err = thrownError(error);

        return { success: false, ...(err?.message !== undefined ? { error: err.message } : {}) };
      }
    }
  );

  ipcMain.handle(
    calendarIntegrationChannels.gcalSetPrimaryOnly,
    async (_event, ...args: unknown[]): Promise<CalendarCommandResult> => {
      const parsedArgs = primaryOnlyArgsSchema.safeParse(args);

      if (!parsedArgs.success) {
        return { success: false, error: "Invalid request" };
      }

      try {
        await deps.googleManager.setPrimaryOnly(parsedArgs.data[0]);

        return { success: true };
      } catch (error) {
        const err = thrownError(error);

        return { success: false, ...(err?.message !== undefined ? { error: err.message } : {}) };
      }
    }
  );

  for (const [channel, manager] of [
    [calendarIntegrationChannels.gcalSyncEvents, deps.googleManager],
    [calendarIntegrationChannels.mcalSyncEvents, deps.microsoftManager],
  ] as const) {
    ipcMain.handle(channel, async (): Promise<CalendarCommandResult> => {
      try {
        const outcome = await manager.syncEvents();

        if (outcome && outcome.failed > 0) {
          // Every calendar failed: no successful update, report failure.
          if (outcome.succeeded === 0) {
            return { success: false, error: outcome.errors[0] || "Calendar sync failed" };
          }

          // Some calendars updated, others failed: incomplete but not false.
          return { success: true, partial: true };
        }

        return { success: true };
      } catch (error) {
        const err = thrownError(error);

        return { success: false, ...(err?.message !== undefined ? { error: err.message } : {}) };
      }
    });
  }

  // Despite the historical name, this is the provider-neutral upcoming read
  // over the shared calendar_events table. Invalid windows are rejected
  // before the DB call.
  ipcMain.handle(
    calendarIntegrationChannels.gcalGetUpcomingEvents,
    async (_event, ...args: unknown[]): Promise<UpcomingEventsResult> => {
      const parsedArgs = upcomingEventsArgsSchema.safeParse(args);

      if (!parsedArgs.success) {
        return { success: false, events: [] };
      }

      try {
        const events = (await deps.getUpcomingEvents(parsedArgs.data[0]))
          .map(projectCalendarEvent)
          .filter((event): event is NonNullable<typeof event> => event !== null);

        return { success: true, events };
      } catch {
        return { success: false, events: [] };
      }
    }
  );

  ipcMain.handle(
    calendarIntegrationChannels.gcalGetEvent,
    async (_event, ...args: unknown[]): Promise<CalendarEventResult> => {
      const parsedArgs = calendarEventArgsSchema.safeParse(args);

      if (!parsedArgs.success) {
        return { success: false, event: null };
      }

      try {
        return {
          success: true,
          event: parseOr(deps.getCalendarEventById(parsedArgs.data[0]), projectCalendarEvent, null),
        };
      } catch {
        return { success: false, event: null };
      }
    }
  );

  // --- Microsoft Calendar ---

  ipcMain.handle(
    calendarIntegrationChannels.mcalStartOAuth,
    async (): Promise<CalendarOAuthResult> => {
      try {
        const result = await deps.microsoftManager.startOAuth();
        const parsed = oauthResultSchema.safeParse(result);

        return parsed.success ? parsed.data : { success: false };
      } catch (error) {
        const err = thrownError(error);
        deps.logError("Microsoft Calendar OAuth failed", { error: err?.message }, "calendar");

        return { success: false, ...(err?.message !== undefined ? { error: err.message } : {}) };
      }
    }
  );

  ipcMain.handle(
    calendarIntegrationChannels.mcalDisconnect,
    async (_event, ...args: unknown[]): Promise<CalendarCommandResult> => {
      const parsedArgs = disconnectArgsSchema.safeParse(args);

      if (!parsedArgs.success) {
        return { success: false, error: "Invalid disconnect request" };
      }

      try {
        deps.microsoftManager.disconnect(parsedArgs.data[0]);

        return { success: true };
      } catch (error) {
        const err = thrownError(error);
        deps.logError("Microsoft Calendar disconnect failed", { error: err?.message }, "calendar");

        return { success: false, ...(err?.message !== undefined ? { error: err.message } : {}) };
      }
    }
  );

  ipcMain.handle(
    calendarIntegrationChannels.mcalGetConnectionStatus,
    async (): Promise<MicrosoftConnectionStatus> => {
      try {
        const status = deps.microsoftManager.getConnectionStatus();
        const parsed = microsoftConnectionStatusSchema.safeParse(status);

        // The unconfigured fallback omits `configured`; keep its exact shape.
        return parsed.success
          ? parsed.data
          : {
              connected: false,
              accounts: [],
              sync: { state: "error", requiresReconnect: false },
            };
      } catch (error) {
        const err = thrownError(error);
        deps.logError(
          "Microsoft Calendar connection status failed",
          { error: err?.message },
          "calendar"
        );

        return {
          connected: false,
          accounts: [],
          sync: { state: "error", requiresReconnect: false },
        };
      }
    }
  );

  ipcMain.handle(
    calendarIntegrationChannels.mcalSetPrimaryOnly,
    async (_event, ...args: unknown[]): Promise<CalendarCommandResult> => {
      const parsedArgs = primaryOnlyArgsSchema.safeParse(args);

      if (!parsedArgs.success) {
        return { success: false, error: "Invalid request" };
      }

      try {
        await deps.microsoftManager.setPrimaryOnly(parsedArgs.data[0]);

        return { success: true };
      } catch (error) {
        const err = thrownError(error);

        return { success: false, ...(err?.message !== undefined ? { error: err.message } : {}) };
      }
    }
  );

  // --- Apple Calendar (macOS EventKit) ---

  ipcMain.handle(calendarIntegrationChannels.acalConnect, async (): Promise<AppleConnectResult> => {
    try {
      const result = await deps.appleManager.connect();
      const parsed = appleConnectResultSchema.safeParse(result);

      return parsed.success ? parsed.data : { success: false };
    } catch (error) {
      const err = thrownError(error);
      deps.logError("Apple Calendar connect failed", { error: err?.message }, "acal");

      return { success: false, ...(err?.message !== undefined ? { error: err.message } : {}) };
    }
  });

  ipcMain.handle(
    calendarIntegrationChannels.acalDisconnect,
    async (): Promise<CalendarCommandResult> => {
      try {
        const result = deps.appleManager.disconnect();
        const parsed = calendarCommandResultSchema.safeParse(result);

        return parsed.success ? parsed.data : { success: false };
      } catch (error) {
        const err = thrownError(error);
        deps.logError("Apple Calendar disconnect failed", { error: err?.message }, "acal");

        return { success: false, ...(err?.message !== undefined ? { error: err.message } : {}) };
      }
    }
  );

  ipcMain.handle(
    calendarIntegrationChannels.acalGetConnectionStatus,
    async (): Promise<AppleConnectionStatus> => {
      try {
        const status = deps.appleManager.getConnectionStatus();
        const parsed = appleConnectionStatusSchema.safeParse(status);

        return parsed.success ? parsed.data : { connected: false, sourceNames: [] };
      } catch (error) {
        const err = thrownError(error);
        deps.logError("Apple Calendar connection status failed", { error: err?.message }, "acal");

        return { connected: false, sourceNames: [] };
      }
    }
  );

  ipcMain.handle(
    calendarIntegrationChannels.openCalendarPrivacySettings,
    async (): Promise<{ success: boolean; error?: string }> => {
      try {
        return await deps.openCalendarPrivacySettings();
      } catch (error) {
        const err = thrownError(error);

        return { success: false, ...(err?.message !== undefined ? { error: err.message } : {}) };
      }
    }
  );
}
