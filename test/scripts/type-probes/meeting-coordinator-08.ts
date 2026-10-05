// @probe-name "desktop Companion methods are required and reject invalid requests"
// @probe-codes [2322,2322,2345]
import type { MeetingCoordinatorApi } from "./src/contracts/meetingCoordinator.js";
declare const api: MeetingCoordinatorApi;
const status: () => ReturnType<MeetingCoordinatorApi["getMeetCompanionStatus"]> =
  api.getMeetCompanionStatus;
const mute: MeetingCoordinatorApi["onMeetManualMute"] = api.onMeetManualMute;
api.configureMeetIntegration("install");
api.respondMeetContextReminder({
  recordingId: "recording",
  sessionId: "session",
  action: "restart",
});
api.onMeetPlatformMute((request) => {
  const muted: string = request.muted;
});
