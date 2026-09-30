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
  speakerNameSource: z.enum(["user", "model", "voice"]).nullable().optional(),
  text: z.string(),
  start: z.number().nonnegative().optional(),
  end: z.number().nonnegative().optional(),
}).strict();

export const meetingSpeakerNamingInputSchema = z.object({
  meetingTitle: z.string().nullable(),
  transcriptSourceId: z.string().min(1).optional(),
  participants: z.array(participantSchema),
  segments: z.array(segmentSchema).min(1),
}).strict();

const responseSchema = z.object({
  speakers: z.array(z.object({
    speakerId: z.string().min(1).max(200),
    name: z.string().max(200),
  }).strict()),
}).strict();

export const MEETING_SPEAKER_NAMING_INSTRUCTION = `Assign a name only when the conversation establishes that the named person attended and spoke under that speaker label. Calendar invitations and mentions of absent people do not establish attendance. Surname and email may remain unknown. Different speaker IDs may share the same first name; duplicate calendar names are not a reason to reject a supported first name. Calendar candidates supply spellings only. Never infer a name from email, attendee order, organizer role or the mere existence of a calendar contact.

Evidence may be a self-introduction, an address followed by a substantive response, an unambiguous handoff of the floor, or addressed thanks immediately after that speaker's contribution. No separate "yes, that is me" or response to every thanks is required. Third-party mentions alone never identify the speaker. Omit uncertain addressees and conflicting names: do not choose a confident identity when the same label appears to answer different names.

User-confirmed names: preserve, do not override. Model-proposed names: verify against transcript evidence and reconsider contradictions. Include an existing model proposal only if the transcript supports it; omission withdraws that proposal. Voice-recognition names are separate voice matches and must not be overridden by this request. Return only the allowed output IDs (unknown speakers and revisitable model suggestions). Copy speakerId exactly. Return JSON only: {"speakers":[{"speakerId":"...","name":"..."}]}. No fences or extra fields. If evidence is insufficient, return {"speakers":[]}.

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
Expected response: {"speakers":[{"speakerId":"Speaker 3","name":"Leo"}]}

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
Expected response: {"speakers":[]}

Example 5: duplicate first names. Calendar candidates: Max Smith, Max Jones. Allowed output IDs: Speaker 2, Speaker 3.
Speaker 1: "Max, what did the benchmark show?"
Speaker 2: "Latency fell by ten percent."
Speaker 3: "I am also Max, from design."
Expected response: {"speakers":[{"speakerId":"Speaker 2","name":"Max"},{"speakerId":"Speaker 3","name":"Max"}]}. Do not choose either surname from the calendar.

Example 6: handoff. Allowed output IDs: Speaker 3.
Speaker 1: "Leo, the floor is yours for the release update."
Speaker 3: "We shipped the new build yesterday."
Expected response: {"speakers":[{"speakerId":"Speaker 3","name":"Leo"}]}

Example 7: addressed thanks after speech. Allowed output IDs: Speaker 2.
Speaker 2: "The migration completed without errors."
Speaker 1: "Thank you, Maya, for that update."
Expected response: {"speakers":[{"speakerId":"Speaker 2","name":"Maya"}]}. Maya need not answer the thanks.

Example 8: absent person. Calendar candidates include Nora. Allowed output IDs: Speaker 2, Speaker 3.
Speaker 2: "Nora could not attend. She sent the mockups."
Speaker 3: "I reviewed them."
Expected response: {"speakers":[]}

Example 9: conflicting addresses. Allowed output IDs: Speaker 2.
Speaker 1: "Max, what changed?"
Speaker 2: "We fixed the build."
Speaker 1: "Dan, what happens next?"
Speaker 2: "We deploy tomorrow."
Expected response: {"speakers":[]}`;

export async function suggestMeetingSpeakerNames(input: unknown, conversation: MeetingTextConversation): Promise<Array<{ speakerId: string; name: string }>> {
  const parsedInput = meetingSpeakerNamingInputSchema.parse(input);
  const unknownSpeakerIds = [...new Set(parsedInput.segments
    .filter((segment) => segment.speakerId !== null && (segment.speakerName === null || segment.speakerNameSource === "model"))
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
