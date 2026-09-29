import { formatMeetingMaterial, meetingPromptSpeakerIds } from "./meetingPromptMaterial.js";
import { z } from "zod";
import type { MeetingTextConversation } from "./meetingSummary.js";
import { requestMeetingJson } from "./meetingJsonRepair.js";

const participantSchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
}).strict();

const segmentSchema = z.object({
  id: z.string().min(1),
  speakerId: z.string().nullable(),
  speakerName: z.string().nullable(),
  text: z.string(),
  start: z.number().nonnegative().optional(),
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

export const MEETING_SPEAKER_NAMING_INSTRUCTION = `Name an unknown meeting speaker only when the supplied transcript segments show either that the speaker introduces themself by that name, or that another participant addresses that speaker by name and the speaker unambiguously answers that address. An incidental name mention is not evidence: do not use a speaker naming somebody else, a third-party mention, or a name spoken without an addressed-and-answered exchange to identify the unknown speaker. The evidence must uniquely identify that speaker. A calendar participant name is a candidate spelling only; it does not prove that person spoke. Never infer a name from an email address, attendee order, organizer role, or implied identity. Omit ambiguous speaker IDs or names that could refer to more than one person. Return only a JSON object with exactly this shape: {"speakers":[{"speakerId":"...","name":"..."}]}. Do not include Markdown fences or extra fields. Copy speakerId exactly from the allowed output IDs in the actual request. Return only unknown speakers; omit known speakers. If none can be identified, return {"speakers":[]}.

The following examples are fictional and independent. Never copy their names into the actual meeting result.

Example 1: self-introduction. Allowed output IDs: Speaker 2.
Calendar candidates: Maya Solano.
<transcript>
Speaker 2: "Hello, I am Maya Solano. I lead design."
</transcript>
Expected response: {"speakers":[{"speakerId":"Speaker 2","name":"Maya Solano"}]}

Example 2: an unambiguous address and answer. Allowed output IDs: Speaker 2, Speaker 3.
Calendar candidates: Leo Ardent.
<transcript>
Speaker 2: "Leo, can you prepare the mockups?"
Speaker 3: "Yes, I will prepare them by Friday."
</transcript>
Expected response: {"speakers":[{"speakerId":"Speaker 3","name":"Leo Ardent"}]}

Example 3: mentioning someone does not identify a speaker. Allowed output IDs: Speaker 2, Speaker 3.
Calendar candidates: Maya Solano.
<transcript>
Speaker 2: "Maya sent the mockups yesterday."
Speaker 3: "I reviewed them."
</transcript>
Expected response: {"speakers":[]}

Example 4: a known local user must not be returned. Speaker 1 is already identified as Nora Vale from Profile. Allowed output IDs: Speaker 2.
<transcript>
Speaker 1: "I will send the document."
Speaker 2: "Thank you."
</transcript>
Expected response: {"speakers":[]}`;

export async function suggestMeetingSpeakerNames(input: unknown, conversation: MeetingTextConversation): Promise<Array<{ speakerId: string; name: string }>> {
  const parsedInput = meetingSpeakerNamingInputSchema.parse(input);
  const unknownSpeakerIds = [...new Set(parsedInput.segments
    .filter((segment) => segment.speakerId !== null && segment.speakerName === null)
    .map((segment) => segment.speakerId as string))];
  const ids = meetingPromptSpeakerIds(parsedInput.segments);
  const sourceIds = new Map(unknownSpeakerIds.map((id) => [ids.get(id)!, id]));
  const allowed = new Set(sourceIds.keys());
  return requestMeetingJson({
    conversation,
    prompt: `Actual meeting. Allowed output IDs: ${[...allowed].join(", ") || "none"}.\nReturn only these IDs, omitting uncertain matches.\n\n${formatMeetingMaterial({ ...parsedInput, transcriptSegments: parsedInput.segments })}`,
    refusalCode: "speaker-name-refused",
    invalidCode: "speaker-name-json-invalid",
    validate: (text) => {
      const result = validateResponse(text, allowed);
      return result.success
        ? { success: true, value: result.speakers.map((speaker) => ({ ...speaker, speakerId: sourceIds.get(speaker.speakerId)! })) }
        : { success: false, error: result.error };
    },
  });
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
    if (!allowed.has(suggestion.speakerId)) return { success: false, error: `Invalid speakerId ${JSON.stringify(suggestion.speakerId)}. Allowed unknown IDs: ${[...allowed].join(", ") || "none"}. Copy an allowed ID exactly, or omit the uncertain match. Known speakers must not be returned.` };
    if (seen.has(suggestion.speakerId)) return { success: false, error: "Each speaker ID may appear only once." };
    const name = suggestion.name.trim();
    if (!name) return { success: false, error: "Speaker names must not be empty." };
    seen.add(suggestion.speakerId);
    speakers.push({ speakerId: suggestion.speakerId, name });
  }
  return { success: true, speakers };
}
