import { z } from "zod";
import {
  meetingCaptureStateSchema,
  meetingProcessingConfigErrorSchema,
  meetingProcessingConfigSchema,
  meetingProcessingResultDtoSchema,
  meetingRecordingIdSchema,
  type MeetingProcessingResultDto,
} from "./meetingRecording.js";

export const meetingProcessingChannels = {
  listForNote: "meeting-processing-list-for-note",
  createRun: "meeting-processing-create-run",
  retryRun: "meeting-processing-retry-run",
  updateBlockedRunConfig: "meeting-processing-update-blocked-run-config",
  setSpeakerCorrection: "meeting-processing-set-speaker-correction",
  runSummaryAction: "meeting-processing-run-summary-action",
  getPlaybackPath: "meeting-recording-get-playback-path",
  exportAudio: "meeting-recording-export-audio",
  deleteAudio: "meeting-recording-delete-audio",
  retryAudioDeletion: "meeting-recording-retry-audio-deletion",
} as const;

export const meetingProcessingUpdatedEvent = "meeting-processing-updated";
export const meetingProcessingUpdatedEventSchema = z.object({
  recordingId: meetingRecordingIdSchema,
  runId: meetingRecordingIdSchema,
});

export const meetingProcessingListRequestSchema = z.object({ noteId: z.number().int().positive() });
export const meetingProcessingCreateRunRequestSchema = z.object({
  recordingId: meetingRecordingIdSchema,
  sourceRecordingIds: z.array(meetingRecordingIdSchema).min(1).max(100).optional(),
  kind: z.enum(["reprocess", "summary"]),
  gateAfterStop: z.boolean().optional(),
  config: meetingProcessingConfigSchema.nullable(),
  configError: meetingProcessingConfigErrorSchema.nullable().optional(),
  sourceRunId: meetingRecordingIdSchema.nullable().optional(),
});
export const meetingProcessingRetryRequestSchema = z.object({ runId: meetingRecordingIdSchema });
export const meetingProcessingUpdateBlockedRunConfigRequestSchema = z.object({
  runId: meetingRecordingIdSchema,
  config: meetingProcessingConfigSchema.nullable(),
  configError: meetingProcessingConfigErrorSchema.nullable(),
});
export const meetingProcessingSpeakerCorrectionRequestSchema = z.object({
  runId: meetingRecordingIdSchema,
  speakerId: z.string().min(1).max(200),
  profileId: z.number().int().positive().nullable(),
  displayName: z.string().trim().min(1).max(200),
  participantEmail: z.string().trim().email().transform((email) => email.toLowerCase()).optional(),
});
export const meetingProcessingSummaryActionRequestSchema = z.object({
  runId: meetingRecordingIdSchema,
  action: z.enum(["tasks", "recap"]),
});
export const meetingRecordingPlaybackRequestSchema = z.object({
  recordingId: meetingRecordingIdSchema,
  runId: meetingRecordingIdSchema.optional(),
});
export const meetingRecordingExportRequestSchema = z.object({
  recordingId: meetingRecordingIdSchema,
  runId: meetingRecordingIdSchema.optional(),
  source: z.enum(["mixed", "mic", "system"]),
});
export const meetingRecordingAudioRequestSchema = z.object({ recordingId: meetingRecordingIdSchema });

export const meetingProcessingRecordingResultSchema = z.object({
  recording: z.object({
    id: meetingRecordingIdSchema,
    groupId: meetingRecordingIdSchema,
    captureState: meetingCaptureStateSchema,
    captureErrorCode: z.string().nullable(),
    audioState: z.enum(["available", "deleting", "deleted"]),
    audioErrorCode: z.string().nullable(),
    currentRunId: meetingRecordingIdSchema.nullable(),
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    durationSeconds: z.number().nonnegative().nullable(),
  }),
  runs: z.array(meetingProcessingResultDtoSchema),
});
export const meetingProcessingListResponseSchema = z.object({
  success: z.boolean(),
  recordings: z.array(meetingProcessingRecordingResultSchema).optional(),
  error: z.string().optional(),
});
export const meetingProcessingRunResponseSchema = z.object({
  success: z.boolean(),
  result: meetingProcessingResultDtoSchema.optional(),
  error: z.string().optional(),
});
export const meetingProcessingCorrectionResponseSchema = z.object({ success: z.boolean(), error: z.string().optional() });
export const meetingProcessingSummaryActionResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});
export const meetingRecordingPlaybackResponseSchema = z.object({
  success: z.boolean(),
  path: z.string().optional(),
  error: z.string().optional(),
});
export const meetingRecordingAudioOperationResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});
export const meetingRecordingExportResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

export type MeetingProcessingRecordingResult = z.infer<typeof meetingProcessingRecordingResultSchema>;
export type MeetingProcessingListResponse = z.infer<typeof meetingProcessingListResponseSchema>;
export type MeetingProcessingRunResponse = z.infer<typeof meetingProcessingRunResponseSchema>;

export interface MeetingProcessingApi {
  meetingProcessingListForNote(noteId: number): Promise<MeetingProcessingListResponse>;
  meetingProcessingCreateRun(input: z.infer<typeof meetingProcessingCreateRunRequestSchema>): Promise<MeetingProcessingRunResponse>;
  meetingProcessingRetryRun(runId: string): Promise<MeetingProcessingRunResponse>;
  meetingProcessingUpdateBlockedRunConfig(input: z.infer<typeof meetingProcessingUpdateBlockedRunConfigRequestSchema>): Promise<MeetingProcessingRunResponse>;
  meetingProcessingSetSpeakerCorrection(input: z.infer<typeof meetingProcessingSpeakerCorrectionRequestSchema>): Promise<z.infer<typeof meetingProcessingCorrectionResponseSchema>>;
  meetingProcessingRunSummaryAction(input: z.infer<typeof meetingProcessingSummaryActionRequestSchema>): Promise<z.infer<typeof meetingProcessingSummaryActionResponseSchema>>;
  meetingRecordingGetPlaybackPath(recordingId: string, runId?: string): Promise<z.infer<typeof meetingRecordingPlaybackResponseSchema>>;
  meetingRecordingExportAudio(input: z.infer<typeof meetingRecordingExportRequestSchema>): Promise<z.infer<typeof meetingRecordingExportResponseSchema>>;
  meetingRecordingDeleteAudio(recordingId: string): Promise<z.infer<typeof meetingRecordingAudioOperationResponseSchema>>;
  meetingRecordingRetryAudioDeletion(recordingId: string): Promise<z.infer<typeof meetingRecordingAudioOperationResponseSchema>>;
  onMeetingProcessingUpdated(callback: (data: z.infer<typeof meetingProcessingUpdatedEventSchema>) => void): () => void;
}

export function isMeetingProcessingResultDto(value: unknown): value is MeetingProcessingResultDto {
  return meetingProcessingResultDtoSchema.safeParse(value).success;
}
