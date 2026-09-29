import type { MeetingTextConversation } from "./meetingSummary.js";

export type MeetingJsonValidation<T> =
  | { success: true; value: T }
  | { success: false; error: string };

export async function requestMeetingJson<T>(input: {
  conversation: MeetingTextConversation;
  prompt: string;
  refusalCode: string;
  invalidCode: string;
  validate: (text: string) => MeetingJsonValidation<T>;
}): Promise<T> {
  const first = await input.conversation.send(input.prompt);
  if (first.refusal || looksLikeRefusal(first.text)) throw codedError(input.refusalCode);

  const validation = input.validate(first.text);
  if (validation.success) return validation.value;

  const repaired = await input.conversation.send(
    `Correct your previous response. Previous response:\n${first.text}\n\nValidation error: ${validation.error}\nReturn only valid JSON in the requested shape.`
  );
  if (repaired.refusal || looksLikeRefusal(repaired.text)) throw codedError(input.refusalCode);
  const second = input.validate(repaired.text);
  if (second.success) return second.value;
  throw codedError(input.invalidCode);
}

function looksLikeRefusal(text: string): boolean {
  return /^\s*(?:i\s+(?:cannot|can't|won't|am unable to)|sorry,?\s+i\s+(?:cannot|can't|am unable to)|as an ai\b)/i.test(text);
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
