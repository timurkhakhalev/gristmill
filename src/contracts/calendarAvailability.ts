// Shared wire contract for the calendar availability IPC channel: the
// response the renderer (and the chat tool's projection source) receives.
// Only privacy-safe facts cross the boundary — never busy intervals, event
// titles, attendees or ids. The domain validation/computation stays in
// helpers/calendarAvailability.ts; this module only describes the wire.
import { z } from "zod";

export const availabilityIntervalSchema = z.object({
  start: z.string(),
  end: z.string(),
});

export type AvailabilityInterval = z.infer<typeof availabilityIntervalSchema>;

export const availabilitySlotSchema = availabilityIntervalSchema.extend({
  durationMinutes: z.number(),
});

export type AvailabilitySlot = z.infer<typeof availabilitySlotSchema>;

export const availabilityCoverageSchema = z.object({
  source: z.literal("local-calendar-cache"),
  lookaheadDays: z.number(),
});

export type AvailabilityCoverage = z.infer<typeof availabilityCoverageSchema>;

// The service projects the internal computation onto exactly these fields.
export const availabilityResultSchema = z.object({
  range: availabilityIntervalSchema,
  timezone: z.string(),
  isEntireRangeFree: z.boolean(),
  availableSlots: z.array(availabilitySlotSchema),
  hasMore: z.boolean(),
  coverage: availabilityCoverageSchema,
});

export type AvailabilityResult = z.infer<typeof availabilityResultSchema>;

// Discriminated wire result: success carries availability, failure an error
// message (user-correctable messages are relayed verbatim by the tool).
export const availabilityResponseSchema = z.union([
  z.object({ success: z.literal(true), availability: availabilityResultSchema }),
  z.object({ success: z.literal(false), error: z.string() }),
]);

export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>;

// The one renderer IPC channel for availability.
export const calendarAvailabilityChannels = {
  getAvailability: "calendar-get-availability",
} as const;

export interface CalendarAvailabilityRequestWire {
  start: string;
  end: string;
  minimumSlotMinutes?: number;
  bufferMinutes?: number;
  maxResults?: number;
}

// The renderer-facing surface: one operation.
export interface CalendarAvailabilityApi {
  calendarGetAvailability(request: CalendarAvailabilityRequestWire): Promise<AvailabilityResponse>;
}
