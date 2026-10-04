import {
  meetingProcessingChannels,
  meetingProcessingCreateRunRequestSchema,
  meetingProcessingListRequestSchema,
  meetingProcessingListResponseSchema,
  meetingProcessingRetryRequestSchema,
  meetingProcessingCancelRequestSchema,
  meetingProcessingUpdateBlockedRunConfigRequestSchema,
  meetingProcessingRunResponseSchema,
  meetingProcessingSpeakerCorrectionRequestSchema,
  meetingProcessingCorrectionResponseSchema,
  meetingProcessingSummaryActionRequestSchema,
  meetingProcessingSummaryActionResponseSchema,
  meetingProcessingUpdatedEvent,
  meetingProcessingUpdatedEventSchema,
  meetingRecordingPlaybackRequestSchema,
  meetingRecordingPlaybackReleaseSchema,
  meetingRecordingPlaybackResponseSchema,
  meetingRecordingExportRequestSchema,
  meetingRecordingExportResponseSchema,
  meetingRecordingAudioRequestSchema,
  meetingRecordingAudioOperationResponseSchema,
  type MeetingProcessingApi,
} from "../contracts/meetingProcessing.js";
import type { ZodType } from "zod";

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
}

function parse<T>(schema: ZodType<T>, raw: unknown, channel: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new Error(`Unexpected response shape from ${channel}`);
  return result.data;
}

export function createMeetingProcessingBridge(ipcRenderer: IpcRendererLike): MeetingProcessingApi {
  return {
    meetingProcessingListForNote(noteId) {
      const input = meetingProcessingListRequestSchema.parse({ noteId });
      return ipcRenderer.invoke(meetingProcessingChannels.listForNote, input).then((raw) =>
        parse(meetingProcessingListResponseSchema, raw, meetingProcessingChannels.listForNote)
      );
    },
    meetingProcessingCreateRun(input) {
      const parsed = meetingProcessingCreateRunRequestSchema.parse(input);
      return ipcRenderer.invoke(meetingProcessingChannels.createRun, parsed).then((raw) =>
        parse(meetingProcessingRunResponseSchema, raw, meetingProcessingChannels.createRun)
      );
    },
    meetingProcessingFinishForNote(noteId) {
      const input = meetingProcessingListRequestSchema.parse({ noteId });
      return ipcRenderer.invoke(meetingProcessingChannels.finishForNote, input).then((raw) =>
        parse(meetingProcessingRunResponseSchema, raw, meetingProcessingChannels.finishForNote)
      );
    },
    meetingProcessingRetryRun(runId) {
      const input = meetingProcessingRetryRequestSchema.parse({ runId });
      return ipcRenderer.invoke(meetingProcessingChannels.retryRun, input).then((raw) =>
        parse(meetingProcessingRunResponseSchema, raw, meetingProcessingChannels.retryRun)
      );
    },
    meetingProcessingCancelRun(runId) {
      const input = meetingProcessingCancelRequestSchema.parse({ runId });
      return ipcRenderer.invoke(meetingProcessingChannels.cancelRun, input).then((raw) =>
        parse(meetingProcessingRunResponseSchema, raw, meetingProcessingChannels.cancelRun)
      );
    },
    meetingProcessingUpdateBlockedRunConfig(input) {
      const parsed = meetingProcessingUpdateBlockedRunConfigRequestSchema.parse(input);
      return ipcRenderer.invoke(meetingProcessingChannels.updateBlockedRunConfig, parsed).then((raw) =>
        parse(meetingProcessingRunResponseSchema, raw, meetingProcessingChannels.updateBlockedRunConfig)
      );
    },
    meetingProcessingSetSpeakerCorrection(input) {
      const parsed = meetingProcessingSpeakerCorrectionRequestSchema.parse(input);
      return ipcRenderer.invoke(meetingProcessingChannels.setSpeakerCorrection, parsed).then((raw) =>
        parse(meetingProcessingCorrectionResponseSchema, raw, meetingProcessingChannels.setSpeakerCorrection)
      );
    },
    meetingProcessingRunSummaryAction(input) {
      const parsed = meetingProcessingSummaryActionRequestSchema.parse(input);
      return ipcRenderer.invoke(meetingProcessingChannels.runSummaryAction, parsed).then((raw) =>
        parse(meetingProcessingSummaryActionResponseSchema, raw, meetingProcessingChannels.runSummaryAction)
      );
    },
    meetingRecordingGetPlaybackPath(recordingId, runId) {
      const input = meetingRecordingPlaybackRequestSchema.parse({ recordingId, runId });
      return ipcRenderer.invoke(meetingProcessingChannels.getPlaybackPath, input).then((raw) =>
        parse(meetingRecordingPlaybackResponseSchema, raw, meetingProcessingChannels.getPlaybackPath)
      );
    },
    meetingRecordingReleasePlayback(leaseId) {
      const input = meetingRecordingPlaybackReleaseSchema.parse({ leaseId });
      return ipcRenderer.invoke(meetingProcessingChannels.releasePlayback, input).then((raw) =>
        parse(meetingRecordingAudioOperationResponseSchema, raw, meetingProcessingChannels.releasePlayback)
      );
    },
    meetingRecordingExportAudio(input) {
      const parsed = meetingRecordingExportRequestSchema.parse(input);
      return ipcRenderer.invoke(meetingProcessingChannels.exportAudio, parsed).then((raw) =>
        parse(meetingRecordingExportResponseSchema, raw, meetingProcessingChannels.exportAudio)
      );
    },
    meetingRecordingDeleteAudio(recordingId) {
      const input = meetingRecordingAudioRequestSchema.parse({ recordingId });
      return ipcRenderer.invoke(meetingProcessingChannels.deleteAudio, input).then((raw) =>
        parse(meetingRecordingAudioOperationResponseSchema, raw, meetingProcessingChannels.deleteAudio)
      );
    },
    meetingRecordingRetryAudioDeletion(recordingId) {
      const input = meetingRecordingAudioRequestSchema.parse({ recordingId });
      return ipcRenderer.invoke(meetingProcessingChannels.retryAudioDeletion, input).then((raw) =>
        parse(meetingRecordingAudioOperationResponseSchema, raw, meetingProcessingChannels.retryAudioDeletion)
      );
    },
    onMeetingProcessingUpdated(callback) {
      const listener = (_event: unknown, ...args: unknown[]) => {
        const parsed = meetingProcessingUpdatedEventSchema.safeParse(args[0]);
        if (parsed.success) callback(parsed.data);
      };
      ipcRenderer.on(meetingProcessingUpdatedEvent, listener);
      return () => ipcRenderer.removeListener(meetingProcessingUpdatedEvent, listener);
    },
  };
}
