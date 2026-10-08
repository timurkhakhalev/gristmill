import { z } from "zod";
import type { CalendarAttendee } from "../contracts/calendar";

// Calendar providers differ in what they send; unknown RSVP values and missing
// flags degrade to the neutral value instead of dropping the attendee.
const attendeeSchema = z.object({
  email: z.string(),
  displayName: z
    .string()
    .nullish()
    .transform((name) => name ?? null),
  responseStatus: z
    .enum(["needsAction", "declined", "tentative", "accepted"])
    .nullish()
    .catch(null)
    .transform((status) => status ?? null),
  self: z.boolean().catch(false),
});

/** Parses `notes.participants` JSON; malformed entries are skipped one by one. */
export function parseNoteParticipants(raw: string | null): CalendarAttendee[] {
  if (!raw) return [];

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const list = z.array(z.unknown()).safeParse(parsed);

  if (!list.success) return [];

  return list.data.flatMap((item) => {
    const attendee = attendeeSchema.safeParse(item);

    return attendee.success ? [attendee.data] : [];
  });
}
