// The single senders for the calendar connection/sync events. Every
// producer — the managers — goes through here instead of raw broadcasts, so
// a malformed payload from JS-land is dropped and diagnosed before it
// reaches renderers. A bad payload must never break the already-completed
// sync, so a validation failure only logs. The bundled preload validates
// again on the receiving side.
import { broadcastToWindows } from "./windowBroadcast.js";
import {
  appleConnectionStatusSchema,
  calendarAccountsEventSchema,
  calendarSyncedEventSchema,
  calendarIntegrationChannels,
} from "../contracts/calendar.js";
import type { ZodType } from "zod";

// Senders build payloads from DB rows; the schema is the wire boundary, so
// unknown input is expected here and malformed payloads are dropped.
function parseOrDrop<T>(channel: string, payload: unknown, schema: ZodType<T>): T | null {
  const result = schema.safeParse(payload);

  if (!result.success) {
    console.error(
      `[calendarEvents] dropped malformed ${channel} payload: ${result.error.issues
        .map((issue) => issue.message)
        .join("; ")}`
    );

    return null;
  }

  return result.data;
}

function sendAccountsEvent(
  channel: string,
  accounts: unknown,
  schema: typeof calendarAccountsEventSchema
): void {
  const valid = parseOrDrop(channel, accounts, schema);

  if (valid) broadcastToWindows(channel, valid);
}

export function sendGcalConnectionChanged(accounts: unknown): void {
  sendAccountsEvent(
    calendarIntegrationChannels.gcalConnectionChanged,
    accounts,
    calendarAccountsEventSchema
  );
}

export function sendGcalEventsSynced(): void {
  if (parseOrDrop(calendarIntegrationChannels.gcalEventsSynced, {}, calendarSyncedEventSchema)) {
    broadcastToWindows(calendarIntegrationChannels.gcalEventsSynced, {});
  }
}

export function sendMcalConnectionChanged(accounts: unknown): void {
  sendAccountsEvent(
    calendarIntegrationChannels.mcalConnectionChanged,
    accounts,
    calendarAccountsEventSchema
  );
}

export function sendMcalEventsSynced(): void {
  if (parseOrDrop(calendarIntegrationChannels.mcalEventsSynced, {}, calendarSyncedEventSchema)) {
    broadcastToWindows(calendarIntegrationChannels.mcalEventsSynced, {});
  }
}

export function sendAcalConnectionChanged(status: unknown): void {
  const valid = parseOrDrop(
    calendarIntegrationChannels.acalConnectionChanged,
    status,
    appleConnectionStatusSchema
  );

  if (valid) broadcastToWindows(calendarIntegrationChannels.acalConnectionChanged, valid);
}

export function sendAcalEventsSynced(): void {
  if (parseOrDrop(calendarIntegrationChannels.acalEventsSynced, {}, calendarSyncedEventSchema)) {
    broadcastToWindows(calendarIntegrationChannels.acalEventsSynced, {});
  }
}
