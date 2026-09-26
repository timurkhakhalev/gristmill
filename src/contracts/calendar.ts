// Single source of truth for the Google/Microsoft/Apple Calendar integration
// boundary: the remaining command and event channel names, their argument
// and result shapes, and the public DTO projected onto renderers and chat
// tools. The calendar availability boundary (PR #31) stays in its own small
// contract; connection/account DTO are defined once here and are not
// duplicated there.
//
// Wire projection policy: only fields actually consumed by the renderer and
// tools cross the boundary. OAuth access/refresh tokens, provider sync
// tokens and raw provider responses never enter these schemas; provider
// ingestion stays in the managers and keeps its own internal DB types.
import { z } from "zod";

// --- Channels and events -----------------------------------------------------

export const calendarIntegrationChannels = {
  gcalStartOAuth: "gcal-start-oauth",
  gcalDisconnect: "gcal-disconnect",
  gcalGetConnectionStatus: "gcal-get-connection-status",
  gcalGetCalendars: "gcal-get-calendars",
  gcalSetCalendarSelection: "gcal-set-calendar-selection",
  gcalSetPrimaryOnly: "gcal-set-primary-only",
  gcalSyncEvents: "gcal-sync-events",
  gcalGetUpcomingEvents: "gcal-get-upcoming-events",
  gcalGetEvent: "gcal-get-event",
  mcalStartOAuth: "mcal-start-oauth",
  mcalDisconnect: "mcal-disconnect",
  mcalGetConnectionStatus: "mcal-get-connection-status",
  mcalSetPrimaryOnly: "mcal-set-primary-only",
  acalConnect: "acal-connect",
  acalDisconnect: "acal-disconnect",
  acalGetConnectionStatus: "acal-get-connection-status",
  openCalendarPrivacySettings: "open-calendar-privacy-settings",
  gcalConnectionChanged: "gcal-connection-changed",
  gcalEventsSynced: "gcal-events-synced",
  mcalConnectionChanged: "mcal-connection-changed",
  mcalEventsSynced: "mcal-events-synced",
  acalConnectionChanged: "acal-connection-changed",
  acalEventsSynced: "acal-events-synced",
} as const;

// --- Shared DTO --------------------------------------------------------------

export type CalendarResponseStatus = "needsAction" | "declined" | "tentative" | "accepted";
export type CalendarAvailabilityStatus = "free" | "tentative" | "busy" | "unavailable" | "unknown";

// The public calendar event, projected from a `calendar_events` row. SQLite
// timestamps and all-day local dates keep their stored string form — Google
// datetimes, Microsoft offsets and all-day "YYYY-MM-DD" dates are NOT forced
// into one ISO datetime format. `synced_at` and every sync token stay
// internal; these are exactly the fields the upcoming list, calendar tool,
// attendee utils and note metadata lookup consume.
export const calendarEventSchema = z.object({
  id: z.string(),
  calendar_id: z.string(),
  provider: z.string(),
  summary: z.string().nullable(),
  start_time: z.string(),
  end_time: z.string(),
  is_all_day: z.number().int(),
  status: z.string(),
  availability_status: z.enum(["free", "tentative", "busy", "unavailable", "unknown"]),
  self_response_status: z.enum(["needsAction", "declined", "tentative", "accepted", "unknown"]),
  hangout_link: z.string().nullable(),
  conference_data: z.string().nullable(),
  event_url: z.string().nullable(),
  organizer_email: z.string().nullable(),
  attendees_count: z.number().int(),
  attendees: z.string().nullable(),
});
export type CalendarEvent = z.infer<typeof calendarEventSchema>;

export interface CalendarAttendee {
  email: string;
  displayName: string | null;
  responseStatus: CalendarResponseStatus | null;
  self: boolean;
}

export interface CalendarAccount {
  email: string;
}

// The Google calendar list entry without token columns: `sync_token` and
// `sync_token_expires_at` never cross the preload.
export const googleCalendarSummarySchema = z.object({
  id: z.string(),
  account_email: z.string().nullable(),
  summary: z.string(),
  description: z.string().nullable(),
  background_color: z.string().nullable(),
  is_selected: z.number().int(),
  is_primary: z.number().int(),
});
export type GoogleCalendarSummary = z.infer<typeof googleCalendarSummarySchema>;

// --- Connection status -------------------------------------------------------
//
// Absence versus false is real signal: the unconfigured/manager-missing
// fallbacks return fewer fields than a live manager, and the renderer reads
// `configured` only when present. These shapes pin that exactly.

export const googleConnectionStatusSchema = z.object({
  connected: z.boolean(),
  email: z.string().nullable(),
  configured: z.boolean().optional(),
  accounts: z.array(z.object({ email: z.string() })).optional(),
});
export type GoogleConnectionStatus = z.infer<typeof googleConnectionStatusSchema>;

export const microsoftConnectionStatusSchema = z.object({
  connected: z.boolean(),
  accounts: z.array(z.object({ email: z.string() })),
  configured: z.boolean().optional(),
});
export type MicrosoftConnectionStatus = z.infer<typeof microsoftConnectionStatusSchema>;

export const appleConnectionStatusSchema = z.object({
  connected: z.boolean(),
  sourceNames: z.array(z.string()),
});
export type AppleConnectionStatus = z.infer<typeof appleConnectionStatusSchema>;

// Historical alias kept for renderer state typing; Google's status is the
// single-account shape the UI was built around.
export type CalendarConnectionStatus = GoogleConnectionStatus;

// --- Command results ----------------------------------------------------------

export const oauthResultSchema = z.union([
  z.object({ success: z.literal(true), email: z.string() }),
  z.object({ success: z.literal(false), error: z.string().optional() }),
]);
export type CalendarOAuthResult = z.infer<typeof oauthResultSchema>;

const commandFailureSchema = z.object({
  success: z.literal(false),
  error: z.string().optional(),
});
export type CalendarCommandFailure = z.infer<typeof commandFailureSchema>;

export const calendarCommandResultSchema = z.union([
  z.object({ success: z.literal(true) }),
  commandFailureSchema,
]);
export type CalendarCommandResult = z.infer<typeof calendarCommandResultSchema>;

// Apple connect resolves after the first EventKit snapshot or the denial —
// the failure reasons name the exact stage that ended the attempt.
export const appleConnectResultSchema = z.union([
  z.object({ success: z.literal(true) }),
  z.object({
    success: z.literal(false),
    reason: z.enum(["unsupported", "helper-missing", "denied", "snapshot-failed"]).optional(),
    error: z.string().optional(),
  }),
]);
export type AppleConnectResult = z.infer<typeof appleConnectResultSchema>;

// Reads degrade to empty shapes on internal errors — the UI keeps rendering
// a disconnected/empty state instead of an error surface.
export const upcomingEventsResultSchema = z.object({
  success: z.boolean(),
  events: z.array(calendarEventSchema),
});
export type UpcomingEventsResult = z.infer<typeof upcomingEventsResultSchema>;

export const calendarEventResultSchema = z.object({
  success: z.boolean(),
  event: calendarEventSchema.nullable(),
});
export type CalendarEventResult = z.infer<typeof calendarEventResultSchema>;

export const googleCalendarsResultSchema = z.object({
  success: z.boolean(),
  calendars: z.array(googleCalendarSummarySchema),
});
export type GoogleCalendarsResult = z.infer<typeof googleCalendarsResultSchema>;

// --- Command arguments ---------------------------------------------------------

export const upcomingEventsArgsSchema = z.tuple([
  z.number().int().positive().max(527040).optional(),
]);
export const calendarEventArgsSchema = z.tuple([z.string().min(1)]);
export const calendarSelectionArgsSchema = z.tuple([z.string().min(1), z.boolean()]);
export const primaryOnlyArgsSchema = z.tuple([z.boolean()]);
export const disconnectArgsSchema = z.tuple([z.string().min(1).optional()]);

// --- Event payloads ------------------------------------------------------------

export const calendarAccountsEventSchema = z.object({
  accounts: z.array(z.object({ email: z.string() })),
});
export type CalendarAccountsEvent = z.infer<typeof calendarAccountsEventSchema>;

// Synced events carry no fields; unknown keys are a malformed payload, so the
// object must be strict and the bridge drops it instead of delivering.
export const calendarSyncedEventSchema = z.object({}).strict();

// --- Wire projection helpers ----------------------------------------------------

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

// Projects one `calendar_events` row onto the allowlisted wire DTO. A row
// that does not survive the schema is dropped (null) — a malformed successful
// payload must never pass as a valid event.
export function projectCalendarEvent(row: unknown): CalendarEvent | null {
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;
  const parsed = calendarEventSchema.safeParse({
    id: record.id,
    calendar_id: record.calendar_id,
    provider: record.provider,
    summary: asStringOrNull(record.summary),
    start_time: record.start_time,
    end_time: record.end_time,
    is_all_day: asInt(record.is_all_day),
    status: record.status,
    availability_status: record.availability_status,
    self_response_status: record.self_response_status,
    hangout_link: asStringOrNull(record.hangout_link),
    conference_data: asStringOrNull(record.conference_data),
    event_url: asStringOrNull(record.event_url),
    organizer_email: asStringOrNull(record.organizer_email),
    attendees_count: asInt(record.attendees_count),
    attendees: asStringOrNull(record.attendees),
  });
  return parsed.success ? parsed.data : null;
}

// The calendar list keeps the selection/description fields the settings UI
// reads and drops the sync-token columns the manager owns.
export function projectGoogleCalendarSummary(row: unknown): GoogleCalendarSummary | null {
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;
  const parsed = googleCalendarSummarySchema.safeParse({
    id: record.id,
    account_email: asStringOrNull(record.account_email),
    summary: record.summary,
    description: asStringOrNull(record.description),
    background_color: asStringOrNull(record.background_color),
    is_selected: asInt(record.is_selected),
    is_primary: asInt(record.is_primary),
  });
  return parsed.success ? parsed.data : null;
}

// --- Renderer-facing API ---------------------------------------------------------

export interface CalendarIntegrationApi {
  gcalStartOAuth(): Promise<CalendarOAuthResult>;
  gcalDisconnect(email?: string): Promise<CalendarCommandResult>;
  gcalGetConnectionStatus(): Promise<GoogleConnectionStatus>;
  gcalGetCalendars(): Promise<GoogleCalendarsResult>;
  gcalSetCalendarSelection(calendarId: string, isSelected: boolean): Promise<CalendarCommandResult>;
  gcalSetPrimaryOnly(value: boolean): Promise<CalendarCommandResult>;
  gcalSyncEvents(): Promise<CalendarCommandResult>;
  gcalGetUpcomingEvents(windowMinutes?: number): Promise<UpcomingEventsResult>;
  gcalGetEvent(eventId: string): Promise<CalendarEventResult>;
  mcalStartOAuth(): Promise<CalendarOAuthResult>;
  mcalDisconnect(email?: string): Promise<CalendarCommandResult>;
  mcalGetConnectionStatus(): Promise<MicrosoftConnectionStatus>;
  mcalSetPrimaryOnly(value: boolean): Promise<CalendarCommandResult>;
  acalConnect(): Promise<AppleConnectResult>;
  acalDisconnect(): Promise<CalendarCommandResult>;
  acalGetConnectionStatus(): Promise<AppleConnectionStatus>;
  openCalendarPrivacySettings(): Promise<{ success: boolean; error?: string }>;
  onGcalConnectionChanged(callback: (data: CalendarAccountsEvent) => void): () => void;
  onGcalEventsSynced(callback: () => void): () => void;
  onMcalConnectionChanged(callback: (data: CalendarAccountsEvent) => void): () => void;
  onMcalEventsSynced(callback: () => void): () => void;
  onAcalConnectionChanged(callback: (data: AppleConnectionStatus) => void): () => void;
  onAcalEventsSynced(callback: () => void): () => void;
}
