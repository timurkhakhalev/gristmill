// @probe-name "wrong event callback payloads fail compilation"
// @probe-codes [2322,2322]
// @probe-origin test/scripts/meetingCoordinatorTypeProbe.test.js
import type { MeetingCoordinatorApi } from "./src/contracts/meetingCoordinator.js";

declare const api: MeetingCoordinatorApi;

api.onMeetingTranscriptionSegment?.((data) => {
  const text: number = data.text;
});
api.onMeetingAutoEndRequested?.((request) => {
  const reason: "mic-released" | undefined = request.reason;
});
