import {
  meetingTranscriptArtifactSchema,
  meetingSummaryArtifactSchema,
  meetingProcessingResultDtoSchema,
  type MeetingProcessingRunDto,
} from "../contracts/meetingRecording.js";
import type { DatabaseManager } from "./database.js";
import type { MeetingRecordingStorage } from "./meetingRecordingStorage.js";

/** Read saved run artifacts and resolve Summary-only source IDs without effects. */
export function readMeetingRunOutput(
  db: Pick<
    DatabaseManager,
    | "getMeetingProcessingRun"
    | "getMeetingRunSpeakerCorrections"
    | "getMeetingRunSpeakerCorrectionRevision"
  >,
  storage: Pick<MeetingRecordingStorage, "readRunArtifact">,
  run: MeetingProcessingRunDto
) {
  const transcriptRunId = run.kind === "summary" ? run.sourceRunId : run.id;
  const rawTranscript = transcriptRunId
    ? storage.readRunArtifact(transcriptRunId, "transcript")
    : null;
  const parsedTranscript = meetingTranscriptArtifactSchema.safeParse(rawTranscript);
  if (rawTranscript !== null && !parsedTranscript.success) {
    throw Object.assign(new Error("transcript-artifact-invalid"), {
      code: "transcript-artifact-invalid",
    });
  }
  const speakerCorrections = transcriptRunId
    ? db.getMeetingRunSpeakerCorrections(transcriptRunId)
    : [];
  // This includes cleared correction tombstones, unlike the visible list.
  const speakerCorrectionRevision = transcriptRunId
    ? db.getMeetingRunSpeakerCorrectionRevision(transcriptRunId)
    : 0;
  const summaryRun = run.hasSummary
    ? run
    : run.kind === "summary" && run.sourceRunId
      ? db.getMeetingProcessingRun(run.sourceRunId)
      : null;
  const summaryValue = summaryRun?.hasSummary
    ? storage.readRunArtifact(summaryRun.id, "summary")
    : null;
  const summary = summaryValue === null ? null : meetingSummaryArtifactSchema.parse(summaryValue);
  return {
    transcriptRunId,
    summaryRunId: summaryRun?.hasSummary ? summaryRun.id : null,
    result: meetingProcessingResultDtoSchema.parse({
      run,
      transcript: rawTranscript === null ? null : parsedTranscript.data,
      summary,
      speakerCorrections,
      speakerCorrectionRevision,
    }),
  };
}
