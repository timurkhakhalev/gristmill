import { z } from "zod";

export const contactIdSchema = z.number().int().positive();

export const contactEmailSchema = z
  .string()
  .nullish()
  .transform((email) => email?.trim().toLowerCase() || null);

/** Telegram's basic username format; no network lookup or account verification. */
export function normalizeTelegramUsername(input: string | null): string | null {
  let value = input?.trim() || "";

  if (!value) return null;

  if (value.startsWith("https://t.me/") || value.startsWith("t.me/")) {
    value = value.replace(/^(?:https:\/\/)?t\.me\//, "").replace(/\/$/, "");
  } else if (value.startsWith("@")) value = value.slice(1);

  if (!/^[A-Za-z0-9_]{5,32}$/.test(value)) throw new Error("Invalid Telegram username");

  return value;
}

export const noteParticipantSchema = z.object({
  contactId: contactIdSchema,
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  responseStatus: z
    .enum(["needsAction", "declined", "tentative", "accepted"])
    .nullish()
    .catch(null)
    .transform((value) => value ?? null),
  self: z.boolean().catch(false),
});

export type NoteParticipant = z.infer<typeof noteParticipantSchema>;
