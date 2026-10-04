// @probe-name "Finish accepts only Note identity and cannot expose processing gate configuration"
// @probe-codes [2353]
import type { MeetingProcessingApi } from "./src/contracts/meetingProcessing.js";
declare const api: MeetingProcessingApi;
api.meetingProcessingFinishForNote(1);
api.meetingProcessingCreateRun({
  recordingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  kind: "reprocess",
  config: null,
  gateAfterStop: true,
});
