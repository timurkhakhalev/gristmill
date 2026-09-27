// @probe-name "the meeting picker rejects a dictation-only provider id"
// @probe-codes [2322]
// @probe-origin test/scripts/realtimeStreamingTypeProbe.test.js
import type { MeetingStreamingProviderId } from "./src/helpers/meetingTranscriptionRouting.ts";
const provider: MeetingStreamingProviderId = "gemini";
void provider;
