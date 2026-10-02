// @probe-name "unsupported platform is rejected by coordinator Notes and prompt types"
// @probe-codes [2322,2322,2322]
import type { MeetingTranscriptSegment } from "./src/contracts/meetingCoordinator.js";
import type { NoteTranscriptSpeaker } from "./src/contracts/noteRead.js";
import type { PromptTranscriptSegment } from "./src/helpers/meetingPromptMaterial.js";
const coordinator: MeetingTranscriptSegment["speakerPlatform"] = "teams";
const note: NoteTranscriptSpeaker["name_platform"] = "teams";
const prompt: PromptTranscriptSegment["speakerNamePlatform"] = "teams";
