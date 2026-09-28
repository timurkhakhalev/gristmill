import { z } from "zod";
import type { MeetingTextConversation } from "./meetingSummary.js";

const participantSchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
}).strict();

const segmentSchema = z.object({
  id: z.string().min(1),
  speakerId: z.string().nullable(),
  speakerName: z.string().nullable(),
  text: z.string(),
}).strict();

export const meetingSpeakerNamingInputSchema = z.object({
  meetingTitle: z.string().nullable(),
  participants: z.array(participantSchema),
  segments: z.array(segmentSchema).min(1),
}).strict();

const responseSchema = z.object({
  speakers: z.array(z.object({
    speakerId: z.string().min(1).max(200),
    name: z.string().max(200),
  }).strict()),
}).strict();

export const MEETING_SPEAKER_NAMING_INSTRUCTION = `Name an unknown meeting speaker only when the complete supplied transcript segments give clear evidence of that person's name and uniquely identify that speaker. A calendar participant name is a candidate spelling only; it does not prove that person spoke. Never infer a name from an email address, attendee order, organizer role, or implied identity. Omit ambiguous speaker IDs or names that could refer to more than one person. Return only a JSON object with exactly this shape: {"speakers":[{"speakerId":"...","name":"..."}]}. Do not include Markdown fences or extra fields.`;

export async function suggestMeetingSpeakerNames(input: unknown, conversation: MeetingTextConversation): Promise<Array<{ speakerId: string; name: string }>> {
  const parsedInput = meetingSpeakerNamingInputSchema.parse(input);
  const unknownSpeakerIds = [...new Set(parsedInput.segments
    .filter((segment) => segment.speakerId !== null && segment.speakerName === null)
    .map((segment) => segment.speakerId as string))];
  const allowed = new Set(unknownSpeakerIds);
  const initial = await conversation.send(JSON.stringify(parsedInput));
  if (initial.refusal || looksLikeRefusal(initial.text)) throw codedError("speaker-name-refused");

  const first = validateResponse(initial.text, allowed);
  if (first.success) return first.speakers;

  const repaired = await conversation.send(
    `Correct your previous response. Previous response:\n${initial.text}\n\nValidation error: ${first.error}\nReturn only a valid JSON object in the requested shape.`
  );
  if (repaired.refusal || looksLikeRefusal(repaired.text)) throw codedError("speaker-name-refused");
  const second = validateResponse(repaired.text, allowed);
  if (second.success) return second.speakers;
  throw codedError("speaker-name-json-invalid");
}

function validateResponse(text: string, allowed: Set<string>):
  | { success: true; speakers: Array<{ speakerId: string; name: string }> }
  | { success: false; error: string } {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return { success: false, error: "Output was not valid JSON." };
  }
  const parsed = responseSchema.safeParse(decoded);
  if (!parsed.success) return { success: false, error: "Expected only a speakers array with nonempty speaker IDs and names." };

  const seen = new Set<string>();
  const speakers: Array<{ speakerId: string; name: string }> = [];
  for (const suggestion of parsed.data.speakers) {
    if (!allowed.has(suggestion.speakerId)) return { success: false, error: "A speaker ID was not unknown in the source run." };
    if (seen.has(suggestion.speakerId)) return { success: false, error: "Each speaker ID may appear only once." };
    const name = suggestion.name.trim();
    if (!name) return { success: false, error: "Speaker names must not be empty." };
    seen.add(suggestion.speakerId);
    speakers.push({ speakerId: suggestion.speakerId, name });
  }
  return { success: true, speakers };
}

function looksLikeRefusal(text: string): boolean {
  return /^\s*(?:i\s+(?:cannot|can't|won't|am unable to)|sorry,?\s+i\s+(?:cannot|can't|am unable to)|as an ai\b)/i.test(text);
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
