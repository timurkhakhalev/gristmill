// @probe-name "session/note/detection id confusion fails compilation"
// @probe-codes [1309,1309,1309,1309,2322,2322,2345,2345]
// @probe-origin test/scripts/meetingCoordinatorTypeProbe.test.js
import type { MeetingCoordinatorApi } from "./src/contracts/meetingCoordinator.js";

declare const api: MeetingCoordinatorApi;

// sessionId is a string, noteId a number; a detection id is never a session id.
await api.meetingTranscriptionStart?.({ sessionId: 42, autoEndEligible: true });
await api.meetingTranscriptionStop?.(123);
await api.meetingAutoEndCompleted?.(42);
await api.setMeetingSessionSpeakerConfig?.({ enabled: true, expectedCount: "3" });
