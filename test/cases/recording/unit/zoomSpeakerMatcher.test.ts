import type { MeetingAudioClockAnchor, MeetingRecordingEpochDto, ZoomSpeakerObservation, ZoomSpeakerCalibration } from "../../../../src/contracts/meetingRecording.js";
const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { randomUUID }: typeof import("node:crypto") = require("node:crypto");
const { matchZoomSpeakers }: typeof import("../../../../src/helpers/zoomSpeakerMatcher.ts") = require("../../../../src/helpers/zoomSpeakerMatcher.ts");

const recordingId = randomUUID();
const sessionId = randomUUID();
const generation = randomUUID();
const calibration: ZoomSpeakerCalibration = { measurementId: "synthetic-fixture-only", indicatorDelayMinSeconds: 0.1, indicatorDelayMaxSeconds: 0.2, conversionErrorSeconds: 0.01, minimumEpisodeSeconds: 0.5, minimumIndependentEpisodes: 2 };
function observation(seconds: number, overrides: Partial<ZoomSpeakerObservation> = {}): ZoomSpeakerObservation {
  return { id: randomUUID(), recordingId, sessionId, instanceKey: "tile-1", nameRevision: 1, episodeId: randomUUID(), displayName: "Synthetic Remote", windowMode: "full", activity: "explicit", readStartHostNs: String(seconds * 1e9), readEndHostNs: String(seconds * 1e9 + 1e7), self: "remote", singleSpeaker: true, provenance: "zoom-only", reason: null, ...overrides };
}
function anchor(start: number, end: number, overrides: Partial<MeetingAudioClockAnchor> = {}): MeetingAudioClockAnchor {
  return { id: randomUUID(), recordingId, epochIndex: 0, epochStartFrame: 0, clock: { type: "clock", generation, startFrame: start * 24_000, endFrame: end * 24_000, hostStartNs: String(start * 1e9), hostEndNs: String(end * 1e9), timebaseNumer: 1, timebaseDenom: 1, conversion: "uncalibrated", reason: null }, ...overrides };
}
function fixture() {
  return { transcript: { text: "Synthetic speech", segments: [{ start: 0, end: 3, speaker: "system:provider-a", text: "One" }, { start: 4, end: 7, speaker: "system:provider-a", text: "Two" }, { start: 0, end: 8, speaker: "mic", text: "Local" }] }, observations: [observation(1), observation(5)], anchors: [anchor(0, 3), anchor(4, 7)], epochs: [{ recordingId, source: "system", epochIndex: 0, startFrame: 0, frameCount: 8 * 24_000, state: "finalized" } satisfies Pick<MeetingRecordingEpochDto, "recordingId" | "source" | "epochIndex" | "startFrame" | "frameCount" | "state">], partOffsets: [{ recordingId, startFrame: 0, frameCount: 8 * 24_000 }], calibration };
}

test("validated independent episodes assign only run-local system IDs and keep transcript unchanged", () => {
  for (const providerId of ["eleven-id", "deepgram-id", "gemini-id"]) {
    const input = fixture();
    input.transcript.segments[0].speaker = input.transcript.segments[1].speaker = `system:${providerId}`;
    const before = JSON.stringify(input.transcript);
    const decisions = matchZoomSpeakers(input);
    assert.equal(decisions.length, 2);
    assert.ok(decisions.every((item) => item.status === "accepted" && item.speakerId === `system:${providerId}`));
    assert.equal(JSON.stringify(input.transcript), before);
  }
});

test("uncalibrated capture produces candidates, never names; silence and mic are not Zoom speech", () => {
  const input = fixture();
  assert.ok(matchZoomSpeakers({ ...input, calibration: undefined }).every((item) => item.reason === "uncalibrated-timing" && item.status === "rejected"));
  assert.ok(matchZoomSpeakers({ ...input, transcript: { text: "Local", segments: input.transcript.segments.filter((item) => item.speaker === "mic") } }).every((item) => item.reason === "no-system-speech"));
});

test("self/source/compact/metadata ambiguity remains an explicit rejection", () => {
  for (const [override, reason] of [
    [{ self: "unknown" }, "unknown-self"], [{ self: "local" }, "local-participant"],
    [{ provenance: "system-wide" }, "unproven-system-source"], [{ singleSpeaker: null }, "unproven-single-speaker"],
    [{ activity: "candidate", windowMode: "compact", reason: "activity-unconfirmed" }, "activity-unconfirmed"],
  ] as Array<[Partial<ZoomSpeakerObservation>, string]>) {
    const input = fixture();
    input.observations = input.observations.map((item) => ({ ...item, ...override }));
    assert.ok(matchZoomSpeakers(input).every((item) => item.reason === reason));
  }
  assert.ok(matchZoomSpeakers({ ...fixture(), incompleteRecordingIds: [recordingId] }).every((item) => item.reason === "metadata-incomplete"));
});

test("read window across ASR transition, missing clocks and shifted uncertainty cannot assign", () => {
  const input = fixture();
  input.transcript.segments.push({ start: 0.8, end: 1.2, speaker: "system:other", text: "Overlap" });
  assert.equal(matchZoomSpeakers(input)[0].reason, "ambiguous-asr-window");
  assert.ok(matchZoomSpeakers({ ...fixture(), anchors: [] }).every((item) => item.reason === "clock-coverage-gap"));
  const shifted = fixture();
  shifted.calibration = { ...calibration, indicatorDelayMaxSeconds: 2 };
  assert.equal(matchZoomSpeakers(shifted)[0].reason, "unstable-timing-window");
});

test("same name never merges instances; rename or several ASR clusters rejects entire cluster", () => {
  for (const overrides of [{ displayName: "Renamed", nameRevision: 2 }, { instanceKey: "tile-2" }, { sessionId: randomUUID() }]) {
    const input = fixture();
    Object.assign(input.observations[1], overrides);
    assert.ok(matchZoomSpeakers(input).every((item) => item.status === "rejected" && item.reason.startsWith("conflicting")));
  }
  const input = fixture();
  input.transcript.segments[1].speaker = "system:second-person-at-device";
  assert.ok(matchZoomSpeakers(input).every((item) => item.reason === "instance-multiple-clusters"));
});

test("duplicate reads are one episode, later parts use the exact mixer offset", () => {
  const input = fixture();
  input.observations[1].episodeId = input.observations[0].episodeId;
  assert.ok(matchZoomSpeakers(input).every((item) => item.reason === "insufficient-independent-episodes"));
  const shifted = fixture();
  shifted.partOffsets[0].startFrame = 60 * 24_000;
  shifted.epochs[0].startFrame = 60 * 24_000;
  shifted.transcript.segments = shifted.transcript.segments.map((item) => ({ ...item, start: item.start + 60, end: item.end + 60 }));
  assert.ok(matchZoomSpeakers(shifted).every((item) => item.status === "accepted"));
  assert.equal(matchZoomSpeakers(shifted)[0].intervals[0].start, 61);
  assert.ok(matchZoomSpeakers({ ...shifted, anchors: [...shifted.anchors].reverse() }).every((item) => item.status === "accepted"));
});

test("normalized ElevenLabs, Deepgram and Gemini responses share the matcher and reprocessing changes IDs", () => {
  const { parseElevenLabsFileResponse }: typeof import("../../../../src/helpers/elevenLabsFileTranscription.ts") = require("../../../../src/helpers/elevenLabsFileTranscription.ts");
  const { parseDeepgramFileResponse }: typeof import("../../../../src/helpers/deepgramFileTranscription.ts") = require("../../../../src/helpers/deepgramFileTranscription.ts");
  const { parseGeminiFileResponse }: typeof import("../../../../src/helpers/geminiFileTranscription.ts") = require("../../../../src/helpers/geminiFileTranscription.ts");
  const replies = [
    parseElevenLabsFileResponse({ text: "One Two", words: [{ type: "word", text: "One", start: 0, end: 3, speaker_id: "fixture_7" }, { type: "word", text: "Two", start: 4, end: 7, speaker_id: "fixture_7" }] }, true),
    parseDeepgramFileResponse({ results: { channels: [{ alternatives: [{ transcript: "One Two" }] }], utterances: [{ transcript: "One", start: 0, end: 3, speaker: 11 }, { transcript: "Two", start: 4, end: 7, speaker: 11 }] } }, true),
    parseGeminiFileResponse({ status: "completed", output_text: "One Two", steps: [{ content: [{ type: "text", text: "One Two", annotations: [{ type: "word_info", text: "One", start_offset: "0s", end_offset: "3s", speaker: "spk_4" }, { type: "word_info", text: "Two", start_offset: "4s", end_offset: "7s", speaker: "spk_4" }] }] }] }, true),
  ];
  const ids = new Set<string>();
  for (const result of replies) {
    assert.equal(result.success, true);
    assert.ok(result.segments?.length);
    const segments = result.segments.map((segment) => ({ ...segment, speaker: `system:${segment.speaker}` }));
    const decisions = matchZoomSpeakers({ ...fixture(), transcript: { text: result.text!, segments } });
    assert.ok(decisions.every((item) => item.status === "accepted"));
    ids.add(decisions[0].speakerId!);
  }
  assert.equal(ids.size, 3);
});

test("platform provenance reaches prompts and cannot enter the model naming target list", () => {
  const { formatMeetingMaterial }: typeof import("../../../../src/helpers/meetingPromptMaterial.ts") = require("../../../../src/helpers/meetingPromptMaterial.ts");
  const { meetingSpeakerNamingInputSchema }: typeof import("../../../../src/helpers/meetingSpeakerNaming.ts") = require("../../../../src/helpers/meetingSpeakerNaming.ts");
  const segment = { id: "fixture-segment", speakerId: "system:fixture", speakerName: "Synthetic Guest", speakerNameSource: "platform" as const, text: "Fixture" };
  const prompt = formatMeetingMaterial({ meetingTitle: "Fixture", transcriptSegments: [segment] });
  assert.match(prompt, /name source=platform/);
  assert.match(prompt, /matched from Zoom evidence/);
  const parsed = meetingSpeakerNamingInputSchema.safeParse({ meetingTitle: "Fixture", participants: [], segments: [segment] });
  assert.equal(parsed.success, true);
  const { meetingNamingInstruction, MEETING_TITLE_INSTRUCTION }: typeof import("../../../../src/helpers/meetingSpeakerNaming.ts") = require("../../../../src/helpers/meetingSpeakerNaming.ts");
  assert.equal(meetingNamingInstruction({ meetingTitle: "Fixture", participants: [], segments: [segment], generateTitle: true }), MEETING_TITLE_INSTRUCTION);
});

test("clock protocol rejects malformed ranges and unsafe timestamps without changing PCM contracts", () => {
  const { meetingAudioClockMessageSchema }: typeof import("../../../../src/contracts/meetingRecording.ts") = require("../../../../src/contracts/meetingRecording.ts");
  const valid = anchor(0, 3).clock;
  assert.equal(meetingAudioClockMessageSchema.safeParse(valid).success, true);
  for (const invalid of [
    { ...valid, endFrame: valid.startFrame }, { ...valid, endFrame: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, hostEndNs: null }, { ...valid, hostEndNs: "0" }, { ...valid, hostStartNs: "NaN" },
    { ...valid, timebaseDenom: 0 }, { ...valid, generation: "pid-123" },
  ]) assert.equal(meetingAudioClockMessageSchema.safeParse(invalid).success, false);
});


test("clock ranges extending past saved raw frames cannot attribute speech", () => {
  const input = fixture();
  input.epochs[0].frameCount = 24_000;
  assert.ok(matchZoomSpeakers(input).every((item) => item.reason === "clock-outside-audio"));
});


test("invalid observation clocks and nullable clock pairs fail validation without throwing", () => {
  const { zoomSpeakerObservationSchema, meetingAudioClockMessageSchema }: typeof import("../../../../src/contracts/meetingRecording.ts") = require("../../../../src/contracts/meetingRecording.ts");
  for (const invalid of [
    { ...observation(1), readStartHostNs: "NaN" }, { ...observation(1), readEndHostNs: "invalid" },
    { ...observation(1), readEndHostNs: "0" }, { ...observation(1), readStartHostNs: "1e9" },
  ]) assert.equal(zoomSpeakerObservationSchema.safeParse(invalid).success, false);
  const valid = anchor(0, 3).clock;
  assert.equal(meetingAudioClockMessageSchema.safeParse({ ...valid, hostStartNs: null, hostEndNs: null }).success, true);
  assert.equal(meetingAudioClockMessageSchema.safeParse({ ...valid, hostStartNs: null }).success, false);
  assert.equal(meetingAudioClockMessageSchema.safeParse({ ...valid, hostEndNs: "NaN" }).success, false);
});
