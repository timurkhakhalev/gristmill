// Pure calendar availability calculation, shared with the renderer tool.
// Typed normalized request, intervals/slots and the internal result (which
// carries busy) live here; the wire response projection lives in the service
// layer. Raw requests/events stay unknown until checked — events only need
// the fields below, and malformed ones are skipped, exactly as before.

const MINUTE_MS = 60 * 1000;

export const MAX_AVAILABILITY_HORIZON_DAYS = 31;

export const PAST_START_TOLERANCE_MS = 5 * MINUTE_MS;

export const DEFAULT_MINIMUM_SLOT_MINUTES = 30;

export const DEFAULT_BUFFER_MINUTES = 0;

export const DEFAULT_MAX_RESULTS = 10;

export const MAX_BUFFER_MINUTES = 120;

// Shared with the renderer tool's JSON schema (calendarAvailabilityTool.ts) so
// the advertised bounds can never drift from what validation enforces.
export const MINIMUM_SLOT_MINUTES_BOUNDS = Object.freeze({ minimum: 5, maximum: 480 });

export const BUFFER_MINUTES_BOUNDS = Object.freeze({ minimum: 0, maximum: MAX_BUFFER_MINUTES });

export const MAX_RESULTS_BOUNDS = Object.freeze({ minimum: 1, maximum: 20 });

const REQUEST_KEYS = new Set(["start", "end", "minimumSlotMinutes", "bufferMinutes", "maxResults"]);

// Time/connection-dependent failures the renderer tool relays verbatim so
// the model can correct the request; every other error stays generic.
export const USER_CORRECTABLE_ERRORS = Object.freeze({
  startTooFarInPast: "start cannot be more than 5 minutes in the past",
  endBeyondHorizon: `end plus buffer cannot extend beyond ${MAX_AVAILABILITY_HORIZON_DAYS} local calendar days from now`,
  endNotAfterNow: "end must be after the current time",
  noCalendarConnected: "No calendar is connected",
});

const RFC3339_WITH_OFFSET_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;

  if ([4, 6, 9, 11].includes(month)) return 30;

  return 31;
}

function hasValidDateParts(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function isExplicitOffsetRfc3339(value: string): boolean {
  const match = RFC3339_WITH_OFFSET_PATTERN.exec(value);

  if (!match) return false;

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    offsetHourText,
    offsetMinuteText,
  ] = match;

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);

  return (
    hasValidDateParts(year, month, day) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

// An event row as stored by the sync: availability reads only these fields
// and malformed rows are skipped.
interface AvailabilityEvent {
  status?: unknown;
  self_response_status?: unknown;
  attendees?: unknown;
  availability_status?: unknown;
  is_all_day?: unknown;
  start_time?: unknown;
  end_time?: unknown;
}

// The request arrives over the tool/IPC wire as JSON; only these five option
// keys are read and any other key is rejected by name.
export interface RawRequest {
  start: unknown;
  end: unknown;
  minimumSlotMinutes?: unknown;
  bufferMinutes?: unknown;
  maxResults?: unknown;
}

interface PlainObjectLike {
  constructor: unknown;
}

function hasObjectPrototype(value: PlainObjectLike): boolean {
  // SAFETY: only plain-object prototypes pass; class instances are rejected
  // like before, since the wire payloads decode to plain objects.
  const prototype = Object.getPrototypeOf(value) as PlainObjectLike | null;

  return prototype === Object.prototype || prototype === null;
}

function isPlainObject(value: unknown): value is RawRequest {
  if (value === null || Array.isArray(value) || typeof value !== "object") return false;

  return hasObjectPrototype(value);
}

// The events cache stores rows shaped like AvailabilityEvent; anything else
// in the array is skipped exactly as before.
function isAvailabilityEvent(value: unknown): value is AvailabilityEvent {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerOption(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function validateIntegerOption(
  value: number,
  name: string,
  { minimum, maximum }: { minimum: number; maximum: number }
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }

  return value;
}

function getLocalAvailabilityHorizonMs(now: Date): number {
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + MAX_AVAILABILITY_HORIZON_DAYS);

  return horizon.getTime();
}

export interface NormalizedAvailabilityRequest {
  start: string;
  end: string;
  minimumSlotMinutes: number;
  bufferMinutes: number;
  maxResults: number;
}

export function validateCalendarAvailabilityRequest(
  request: unknown,
  now: Date = new Date()
): NormalizedAvailabilityRequest {
  if (!isPlainObject(request)) {
    throw new TypeError("Calendar availability request must be a plain object");
  }

  const unknownKey = Object.keys(request).find((key) => !REQUEST_KEYS.has(key));

  if (unknownKey) throw new TypeError(`Unknown calendar availability option: ${unknownKey}`);

  if (typeof request.start !== "string" || !isExplicitOffsetRfc3339(request.start)) {
    throw new TypeError("start must be an RFC3339 timestamp with an explicit UTC offset");
  }

  if (typeof request.end !== "string" || !isExplicitOffsetRfc3339(request.end)) {
    throw new TypeError("end must be an RFC3339 timestamp with an explicit UTC offset");
  }

  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }

  const nowMs = now.getTime();
  const requestedStartMs = Date.parse(request.start);
  const endMs = Date.parse(request.end);

  const rawMinimumSlot = request.minimumSlotMinutes ?? DEFAULT_MINIMUM_SLOT_MINUTES;

  const minimumSlotMinutes = validateIntegerOption(
    isIntegerOption(rawMinimumSlot) ? rawMinimumSlot : Number.NaN,
    "minimumSlotMinutes",
    MINIMUM_SLOT_MINUTES_BOUNDS
  );

  const rawBuffer = request.bufferMinutes ?? DEFAULT_BUFFER_MINUTES;

  const bufferMinutes = validateIntegerOption(
    isIntegerOption(rawBuffer) ? rawBuffer : Number.NaN,
    "bufferMinutes",
    BUFFER_MINUTES_BOUNDS
  );

  const rawMaxResults = request.maxResults ?? DEFAULT_MAX_RESULTS;

  const maxResults = validateIntegerOption(
    isIntegerOption(rawMaxResults) ? rawMaxResults : Number.NaN,
    "maxResults",
    MAX_RESULTS_BOUNDS
  );

  if (endMs <= requestedStartMs) throw new RangeError("end must be after start");

  if (requestedStartMs < nowMs - PAST_START_TOLERANCE_MS) {
    throw new RangeError(USER_CORRECTABLE_ERRORS.startTooFarInPast);
  }

  if (endMs + bufferMinutes * MINUTE_MS > getLocalAvailabilityHorizonMs(now)) {
    throw new RangeError(USER_CORRECTABLE_ERRORS.endBeyondHorizon);
  }

  const startMs = Math.max(requestedStartMs, nowMs);

  if (endMs <= startMs) throw new RangeError(USER_CORRECTABLE_ERRORS.endNotAfterNow);

  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    minimumSlotMinutes,
    bufferMinutes,
    maxResults,
  };
}

function parseLocalDateOnly(value: string): number | null {
  const match = DATE_ONLY_PATTERN.exec(value);

  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (!hasValidDateParts(year, month, day)) return null;

  const date = new Date(year, month - 1, day);

  if (year >= 0 && year < 100) date.setFullYear(year);
  const timestamp = date.getTime();

  return Number.isFinite(timestamp) ? timestamp : null;
}

export function parseEventTime(value: string, isAllDay: boolean): number | null {
  if (isAllDay && DATE_ONLY_PATTERN.test(value)) return parseLocalDateOnly(value);
  const timestamp = Date.parse(value);

  return Number.isFinite(timestamp) ? timestamp : null;
}

function isDeclinedResponse(value: string | undefined | null): boolean {
  return value?.trim().toLowerCase() === "declined";
}

interface RawAttendee {
  self?: unknown;
  responseStatus?: unknown;
  response_status?: unknown;
}

function parseRawAttendees(attendees: unknown): RawAttendee[] {
  let parsed: unknown = attendees;

  if (typeof attendees === "string") {
    try {
      parsed = JSON.parse(attendees);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  return parsed.filter(
    (attendee): attendee is RawAttendee => typeof attendee === "object" && attendee !== null
  );
}

function attendeeResponse(attendee: RawAttendee): string | undefined {
  const { responseStatus, response_status } = attendee;

  if (typeof responseStatus === "string") return responseStatus;

  return typeof response_status === "string" ? response_status : undefined;
}

function isSelfDeclined(attendees: unknown): boolean {
  return parseRawAttendees(attendees).some(
    (attendee) => attendee.self === true && isDeclinedResponse(attendeeResponse(attendee))
  );
}

function blocksTime(event: AvailabilityEvent): boolean {
  const eventStatus = typeof event.status === "string" ? event.status.toLowerCase() : "";

  if (eventStatus === "cancelled" || eventStatus === "canceled") return false;

  if (typeof event.self_response_status === "string") {
    if (isDeclinedResponse(event.self_response_status)) return false;
  }

  if (isSelfDeclined(event.attendees)) return false;

  const availability =
    typeof event.availability_status === "string"
      ? event.availability_status.toLowerCase()
      : "unknown";

  return availability !== "free";
}

function toIsoInterval(startMs: number, endMs: number): AvailabilityInterval {
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
  };
}

export interface AvailabilityInterval {
  start: string;
  end: string;
}

export interface AvailabilitySlot {
  start: string;
  end: string;
  durationMinutes: number;
}

export interface AvailabilityComputation {
  busy: AvailabilityInterval[];
  availableSlots: AvailabilitySlot[];
  hasMore: boolean;
  isEntireRangeFree: boolean;
}

// Expects a request already normalized by validateCalendarAvailabilityRequest,
// so callers that validated up front (calendarAvailabilityService.ts needs the
// normalized window to query the cache first) don't pay for a second pass.
export function computeCalendarAvailability(
  events: readonly unknown[],
  normalizedRequest: NormalizedAvailabilityRequest
): AvailabilityComputation {
  const windowStartMs = Date.parse(normalizedRequest.start);
  const windowEndMs = Date.parse(normalizedRequest.end);
  const bufferMs = normalizedRequest.bufferMinutes * MINUTE_MS;

  const intervals: Array<{ startMs: number; endMs: number }> = [];

  for (const event of events) {
    if (!isAvailabilityEvent(event)) continue;

    if (!blocksTime(event)) continue;
    const isAllDay = event.is_all_day === true || event.is_all_day === 1;
    const startText = event.start_time;
    const endText = event.end_time;

    if (typeof startText !== "string" || typeof endText !== "string") continue;
    const eventStartMs = parseEventTime(startText, isAllDay);
    const eventEndMs = parseEventTime(endText, isAllDay);

    if (eventStartMs === null || eventEndMs === null || eventEndMs <= eventStartMs) continue;

    const startMs = Math.max(windowStartMs, eventStartMs - bufferMs);
    const endMs = Math.min(windowEndMs, eventEndMs + bufferMs);

    if (startMs < endMs) intervals.push({ startMs, endMs });
  }

  intervals.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const merged: { startMs: number; endMs: number }[] = [];

  for (const interval of intervals) {
    const previous = merged.at(-1);

    if (previous && interval.startMs <= previous.endMs) {
      previous.endMs = Math.max(previous.endMs, interval.endMs);
    } else {
      merged.push({ ...interval });
    }
  }

  const minimumSlotMs = normalizedRequest.minimumSlotMinutes * MINUTE_MS;
  const allAvailableSlots: { startMs: number; endMs: number }[] = [];
  let cursorMs = windowStartMs;

  for (const interval of merged) {
    if (interval.startMs - cursorMs >= minimumSlotMs) {
      allAvailableSlots.push({ startMs: cursorMs, endMs: interval.startMs });
    }

    cursorMs = interval.endMs;
  }

  if (windowEndMs - cursorMs >= minimumSlotMs) {
    allAvailableSlots.push({ startMs: cursorMs, endMs: windowEndMs });
  }

  return {
    busy: merged.map(({ startMs, endMs }) => toIsoInterval(startMs, endMs)),
    availableSlots: allAvailableSlots
      .slice(0, normalizedRequest.maxResults)
      .map(({ startMs, endMs }) => ({
        ...toIsoInterval(startMs, endMs),
        durationMinutes: Math.floor((endMs - startMs) / MINUTE_MS),
      })),
    hasMore: allAvailableSlots.length > normalizedRequest.maxResults,
    isEntireRangeFree: merged.length === 0,
  };
}

export function calculateCalendarAvailability(
  events: readonly unknown[],
  request: RawRequest,
  now: Date = new Date()
): AvailabilityComputation {
  return computeCalendarAvailability(events, validateCalendarAvailabilityRequest(request, now));
}
