const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");

// Meeting capture owns raw audio. Processing starts only after Stop through
// the persisted recording worker, so these checks pin the current capture
// boundary rather than the retired live-ASR wiring.
const source = fs.readFileSync(
  path.join(__dirname, "../../src/helpers/meetingCoordinatorIpcHandlers.ts"),
  "utf8"
);

function section(from: string, to: string) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `source section ${from}..${to} must exist`);
  return source.slice(start, end);
}

test("meeting start creates durable capture before selecting a local source", () => {
  const start = section("const startMeetingTranscription", "const sendMeetingAudio");
  const createCapture = start.indexOf("MeetingCaptureSession.create(");
  const selectSource = start.indexOf("getMeetingSystemAudioPlan()");
  assert.ok(createCapture >= 0 && selectSource > createCapture);
  assert.match(start, /recordingId:\s*capture\.recordingId/);
  assert.match(start, /originAt:\s*capture\.originAt/);
  assert.doesNotMatch(start, /fetchRealtimeToken|getMeetingStreamingClient|transcribeLocal/);
  assert.doesNotMatch(start, /meeting-transcription-segment/);
});

test("renderer PCM is validated and acknowledged only after the raw write", () => {
  const send = section("const sendMeetingAudio", "const startManagedMeetingSystemAudio");
  assert.match(send, /sessionId !== activeCaptureSessionId/);
  assert.match(send, /meetingCapturePacketSchema\.safeParse\(packet\)/);
  const write = send.indexOf("capture.appendRendererSamples(source, parsedPacket.data, raw)");
  const acknowledge = send.indexOf("return { success: true, sequence: parsedPacket.data.sequence }");
  assert.ok(write >= 0 && acknowledge > write);
});

test("native system PCM is persisted, watched for interruption, and drained before finalization", () => {
  const watchdog = section("const meetingSystemAudioWatchdog:", "let meetingStartedAt");
  assert.match(watchdog, /send\("meeting-system-audio-interrupted", payload\)/);

  const nativeStart = section("const startManagedMeetingSystemAudio", 'ipcMain.handle(\n    "meeting-transcription-send"');
  assert.match(nativeStart, /timeline\.write\(chunk, \(raw\) => \{/);
  assert.match(nativeStart, /capture\.appendNativeSamples\("system", raw\)/);
  assert.match(nativeStart, /meetingSystemAudioWatchdog\.recordChunk\(/);
  assert.match(nativeStart, /meetingSystemAudioWatchdog\.reportDeviceInvalidated\(\)/);
  assert.match(nativeStart, /stop: \(\) => manager\.stop\(\)/);

  const stop = section("const stopMeetingTranscription", "const meetingTranscriptionLifecycle");
  const stopTap = stop.indexOf("await audioTapManager?.stop()");
  const finalize = stop.indexOf("await capture.stop(");
  assert.ok(stopTap >= 0 && finalize > stopTap);
  assert.match(stop, /stopMeetingSystemAudioWatchdog\(\)/);
  assert.match(stop, /capture\.markCaptureFailure\(stopError\)/);
});
