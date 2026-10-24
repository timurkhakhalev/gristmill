import { z } from "zod";
import { noteParticipantSchema, type NoteParticipant } from "../contracts/contactIdentity";

/** Parses `notes.participants` JSON; malformed entries are skipped one by one. */
export function parseNoteParticipants(raw: string | null): NoteParticipant[] {
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
    const attendee = noteParticipantSchema.safeParse(item);

    return attendee.success ? [attendee.data] : [];
  });
}
