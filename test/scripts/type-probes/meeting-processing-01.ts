// @probe-name "a meeting processing result carries the authoritative speaker correction revision"
// @probe-codes []
import {
  meetingProcessingResultDtoSchema,
  type MeetingProcessingResultDto,
} from "./src/contracts/meetingRecording.js";

// The result DTO exposes the authoritative revision as a plain number, so a
// consumer compares against it instead of summing the visible corrections.
declare const result: MeetingProcessingResultDto;
const revision: number = result.speakerCorrectionRevision;
void revision;

// The schema accepts the required field and rejects nothing here.
const parsed = meetingProcessingResultDtoSchema.safeParse({
  run: {},
  transcript: null,
  summary: null,
  speakerCorrections: [],
  speakerCorrectionRevision: 2,
});
void parsed;
