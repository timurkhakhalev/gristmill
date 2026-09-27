// @probe-name "Gemini cannot enter the finite meeting client registry"
// @probe-codes [2345]
// @probe-origin test/scripts/realtimeStreamingTypeProbe.test.js
import { getMeetingStreamingClient } from "./src/helpers/meetingStreamingProviders.ts";
getMeetingStreamingClient("gemini-realtime");
