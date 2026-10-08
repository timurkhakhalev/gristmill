// Node service for calendar availability: validates the request against the
// domain policy, queries the local calendar cache for the connected
// providers and projects the computation onto the privacy-safe wire shape.
// Busy intervals never leave this layer — the renderer tool only surfaces
// free-slot facts to the model.
import {
  MAX_AVAILABILITY_HORIZON_DAYS,
  USER_CORRECTABLE_ERRORS,
  validateCalendarAvailabilityRequest,
  computeCalendarAvailability,
} from "./calendarAvailability.js";
import type { AvailabilityResult } from "../contracts/calendarAvailability.js";

export interface CalendarProviderEntry {
  provider: string;
  manager: { isConnected?: () => boolean } | null | undefined;
}

export interface CalendarAvailabilityServiceDeps {
  databaseManager: {
    getCalendarEventsInRange: (
      start: string,
      end: string,
      providers: string[]
    ) => readonly unknown[];
  };
}

function connectedCalendarProviders(
  calendarProviders: CalendarProviderEntry[]
): CalendarProviderEntry[] {
  return calendarProviders.filter(
    ({ provider, manager }) =>
      (provider !== "apple" || process.platform === "darwin") && manager?.isConnected?.()
  );
}

export function getCalendarAvailability({
  request,
  databaseManager,
  calendarProviders,
  clock = () => new Date(),
}: {
  request: unknown;
  databaseManager: CalendarAvailabilityServiceDeps["databaseManager"];
  calendarProviders: CalendarProviderEntry[];
  clock?: () => Date;
}): AvailabilityResult {
  const now = clock();
  const normalized = validateCalendarAvailabilityRequest(request, now);
  const connectedProviders = connectedCalendarProviders(calendarProviders);

  if (connectedProviders.length === 0) {
    throw new Error(USER_CORRECTABLE_ERRORS.noCalendarConnected);
  }

  const endMs = Date.parse(normalized.end);
  const startMs = Date.parse(normalized.start);
  const bufferMs = normalized.bufferMinutes * 60 * 1000;
  const queryStart = new Date(startMs - bufferMs).toISOString();
  const queryEnd = new Date(endMs + bufferMs).toISOString();

  const events = databaseManager.getCalendarEventsInRange(
    queryStart,
    queryEnd,
    connectedProviders.map(({ provider }) => provider)
  );

  const { availableSlots, hasMore, isEntireRangeFree } = computeCalendarAvailability(
    events,
    normalized
  );

  return {
    range: { start: normalized.start, end: normalized.end },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    availableSlots,
    hasMore,
    isEntireRangeFree,
    coverage: {
      source: "local-calendar-cache",
      lookaheadDays: MAX_AVAILABILITY_HORIZON_DAYS,
    },
  };
}
