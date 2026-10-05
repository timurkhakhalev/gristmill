// @probe-name "canonical platform flows through coordinator Notes and prompt contracts"
// @probe-codes []
import type { MeetingPlatform } from "./src/contracts/meetingRecording.js";
import type { MeetingTranscriptSegment } from "./src/contracts/meetingCoordinator.js";
import type { NoteTranscriptSpeaker } from "./src/contracts/noteRead.js";
import type { PromptTranscriptSegment } from "./src/helpers/meetingPromptMaterial.js";

declare const platform: MeetingPlatform;
const coordinator: MeetingTranscriptSegment = {
  id: "turn",
  text: "Hello",
  source: "system",
  speakerPlatform: platform,
};
const note: NoteTranscriptSpeaker = {
  id: "remote",
  name: "Guest",
  name_platform: coordinator.speakerPlatform,
  email: null,
  source: "system",
};
const prompt: PromptTranscriptSegment = {
  speakerId: "remote",
  speakerName: "Guest",
  speakerNamePlatform: note.name_platform,
  text: "Hello",
};
const result: MeetingPlatform | undefined = prompt.speakerNamePlatform;
