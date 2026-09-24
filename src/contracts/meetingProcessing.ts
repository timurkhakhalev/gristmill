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
} as const;

export const meetingProcessingListRequestSchema = z.object({ noteId: z.number().int().positive() });
export const meetingProcessingCreateRunRequestSchema = z.object({
  recordingId: meetingRecordingIdSchema,
  kind: z.enum(["reprocess", "summary"]),
  config: meetingProcessingConfigSchema.nullable(),
  configError: meetingProcessingConfigErrorSchema.nullable().optional(),
  sourceRunId: meetingRecordingIdSchema.nullable().optional(),
});
export const meetingProcessingRetryRequestSchema = z.object({ runId: meetingRecordingIdSchema });

export const meetingProcessingRecordingResultSchema = z.object({
  recording: z.object({
    id: meetingRecordingIdSchema,
    captureState: meetingCaptureStateSchema,
    captureErrorCode: z.string().nullable(),
    audioState: z.enum(["available", "deleting", "deleted"]),
    currentRunId: meetingRecordingIdSchema.nullable(),
    startedAt: z.string(),
    endedAt: z.string().nullable(),
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

export type MeetingProcessingRecordingResult = z.infer<typeof meetingProcessingRecordingResultSchema>;
export type MeetingProcessingListResponse = z.infer<typeof meetingProcessingListResponseSchema>;
export type MeetingProcessingRunResponse = z.infer<typeof meetingProcessingRunResponseSchema>;

export interface MeetingProcessingApi {
  meetingProcessingListForNote(noteId: number): Promise<MeetingProcessingListResponse>;
  meetingProcessingCreateRun(input: z.infer<typeof meetingProcessingCreateRunRequestSchema>): Promise<MeetingProcessingRunResponse>;
  meetingProcessingRetryRun(runId: string): Promise<MeetingProcessingRunResponse>;
}

export function isMeetingProcessingResultDto(value: unknown): value is MeetingProcessingResultDto {
  return meetingProcessingResultDtoSchema.safeParse(value).success;
}
