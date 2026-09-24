import {
  meetingProcessingChannels,
  meetingProcessingCreateRunRequestSchema,
  meetingProcessingListRequestSchema,
  meetingProcessingListResponseSchema,
  meetingProcessingRetryRequestSchema,
  meetingProcessingRunResponseSchema,
  type MeetingProcessingApi,
} from "../contracts/meetingProcessing.js";
import type { ZodType } from "zod";

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
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
    meetingProcessingRetryRun(runId) {
      const input = meetingProcessingRetryRequestSchema.parse({ runId });
      return ipcRenderer.invoke(meetingProcessingChannels.retryRun, input).then((raw) =>
        parse(meetingProcessingRunResponseSchema, raw, meetingProcessingChannels.retryRun)
      );
    },
  };
}
