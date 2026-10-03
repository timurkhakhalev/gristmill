// @probe-name "a meeting processing result without the authoritative revision fails compilation"
// @probe-codes [2741]
import type {
  MeetingProcessingResultDto,
  MeetingProcessingRunDto,
} from "./src/contracts/meetingRecording.js";

declare const run: MeetingProcessingRunDto;

// Omitting the authoritative revision must be rejected: the display list cannot
// reconstruct it, so the field is required on the DTO.
const missing: MeetingProcessingResultDto = {
  run,
  transcript: null,
  summary: null,
  speakerCorrections: [],
};

void missing;
