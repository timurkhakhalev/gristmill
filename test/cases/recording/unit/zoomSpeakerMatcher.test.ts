import type { MeetingAudioClockAnchor, MeetingRecordingEpochDto, ZoomSpeakerObservation } from "../../../../src/contracts/meetingRecording.js";
const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { randomUUID }: typeof import("node:crypto") = require("node:crypto");
const { matchZoomSpeakers }: typeof import("../../../../src/helpers/zoomSpeakerMatcher.ts") = require("../../../../src/helpers/zoomSpeakerMatcher.ts");
const recordingId = randomUUID();
const sessionId = randomUUID();
const generation = randomUUID();
function observation(seconds: number, overrides: Partial<ZoomSpeakerObservation> = {}): ZoomSpeakerObservation {
  return { id: randomUUID(), recordingId, sessionId, instanceKey: "tile-1", nameRevision: 1, episodeId: randomUUID(), displayName: "Synthetic Remote", windowMode: "full", activity: "explicit", readStartHostNs: String(seconds * 1e9), readEndHostNs: String((seconds + 3) * 1e9), self: "unknown", singleSpeaker: null, provenance: "system-wide", reason: null, ...overrides };
}
function anchor(start: number, end: number, overrides: Partial<MeetingAudioClockAnchor> = {}): MeetingAudioClockAnchor {
  return { id: randomUUID(), recordingId, epochIndex: 0, epochStartFrame: 0, clock: { type: "clock", generation, startFrame: start * 24_000, endFrame: end * 24_000, hostStartNs: String(start * 1e9), hostEndNs: String(end * 1e9), timebaseNumer: 1, timebaseDenom: 1, conversion: "uncalibrated", reason: null }, ...overrides };
}
function fixture() {
  return { transcript: { text: "Synthetic speech", segments: [1, 5, 9].map((start) => ({ start: start - 0.5, end: start + 2.5, speaker: "system:provider-a", text: "Speech" })) }, observations: [observation(1), observation(5), observation(9)], anchors: Array.from({ length: 14 }, (_, i) => anchor(i, i + 1)), epochs: [{  recordingId, source: "system", epochIndex: 0, timelineStartFrame: 0, frameCount: 14 * 24_000, state: "finalized" } satisfies Pick<MeetingRecordingEpochDto, "recordingId" | "source" | "epochIndex" | "timelineStartFrame" | "frameCount" | "state">], partOffsets: [{ recordingId, startFrame: 0, frameCount: 14 * 24_000 }] };
}

test("production policy accepts repeated unknown-self remote activity, names only system and preserves ASR", () => {
  const input = fixture();
  input.transcript.segments.push({ start: 13, end: 14, speaker: "mic", text: "Local later" });
  const before = JSON.stringify(input.transcript);
  const decisions = matchZoomSpeakers(input);
  assert.ok(decisions.every((d) => d.status === "accepted" && d.speakerId === "system:provider-a"));
  assert.equal(decisions[0].timingPolicy?.origin, "initial-lag-hypothesis");
  assert.equal(decisions[0].clockAnchorIds.length, 3);
  assert.equal(JSON.stringify(input.transcript), before);
});

test("own participant, local overlap, simultaneous speech and short activity cannot name", () => {
  for (const local of [false, true]) {
    const input = fixture();
    if (local) input.observations.forEach((o) => { o.self = "local"; });
    else input.transcript.segments.push({ start: 1.5, end: 2, speaker: "mic", text: "Own speech" });
    const decisions = matchZoomSpeakers(input);
    assert.ok(decisions.every((d) => d.status === "rejected"));
    assert.equal(decisions[0].reason, local ? "local-participant" : "local-speech-overlap");
  }
  const input = fixture();
  input.transcript.segments.push({ start: 1.2, end: 2, speaker: "system:other", text: "Overlap" });
  assert.equal(matchZoomSpeakers(input)[0].reason, "ambiguous-asr-window");
  input.observations = input.observations.map((o) => ({ ...o, readEndHostNs: String(BigInt(o.readStartHostNs) + 500000000n) }));
  assert.ok(matchZoomSpeakers(input).every((d) => d.status === "rejected"));
  assert.ok(matchZoomSpeakers({ ...fixture(), transcript: { text: "Silence", segments: [] } }).every((d) => d.reason === "no-system-speech"));
});

test("AX unknown span and missing clocks remain local; later episodes and late speaker still work", () => {
  const input = fixture();
  input.observations.unshift(observation(0, { activity: "unavailable", displayName: "", reason: "accessibility", readEndHostNs: "500000000" }));
  input.observations.push(...[14, 18, 22].map((s) => observation(s, { instanceKey: "late-tile", displayName: "Late Guest" })));
  input.transcript.segments.push(...[14, 18, 22].map((start) => ({ start: start - 0.5, end: start + 2.5, speaker: "system:late", text: "Late" })));
  input.anchors.push(...Array.from({ length: 12 }, (_, i) => anchor(14 + i, 15 + i)));
  input.epochs[0].frameCount = input.partOffsets[0].frameCount = 26 * 24_000;
  const decisions = matchZoomSpeakers(input);
  assert.equal(decisions[0].status, "rejected");
  assert.equal(decisions.filter((d) => d.status === "accepted").length, 6);
  assert.equal(matchZoomSpeakers({ ...input, anchors: [] })[1].reason, "clock-coverage-gap");
});

test("recreated instances and sessions may agree; names or clusters in conflict cannot", () => {
  const input = fixture();
  input.observations[1].instanceKey = "recreated";
  input.observations[2].sessionId = randomUUID();
  assert.ok(matchZoomSpeakers(input).every((d) => d.status === "accepted"));
  input.observations[1].displayName = "Other Name";
  assert.ok(matchZoomSpeakers(input).every((d) => d.reason === "conflicting-names"));
  const differentCluster = fixture();
  differentCluster.transcript.segments[1].speaker = "system:other";
  assert.ok(matchZoomSpeakers(differentCluster).every((d) => d.reason === "name-multiple-clusters"));
});

test("simultaneous duplicate display names abstain while sequential recreation does not", () => {
  const input = fixture();
  input.observations.push(observation(1.5, { instanceKey: "different-tile", activity: "clear", readEndHostNs: "1510000000" }));
  assert.ok(matchZoomSpeakers(input).filter((d) => d.speakerId).every((d) => d.reason === "duplicate-display-name"));
});

test("continued confirmations are one episode and clock gaps/invalid ranges cannot count", () => {
  const input = fixture();
  input.observations.forEach((o) => { o.episodeId = input.observations[0].episodeId; });
  assert.ok(matchZoomSpeakers(input).every((d) => d.reason === "insufficient-independent-episodes"));
  const missing = fixture();
  missing.anchors = missing.anchors.filter((a) => a.clock.startFrame !== 2 * 24_000);
  assert.equal(matchZoomSpeakers(missing)[0].reason, "clock-coverage-gap");
  const outside = fixture();
  outside.epochs[0].frameCount = 24_000;
  assert.ok(matchZoomSpeakers(outside).every((d) => d.reason === "clock-outside-audio"));
  const wrongRate = fixture();
  wrongRate.anchors[1].clock.endFrame += 1000;
  assert.equal(matchZoomSpeakers(wrongRate)[0].reason, "clock-rate-mismatch");
  const restarted = fixture();
  restarted.anchors[2].clock.generation = randomUUID();
  assert.equal(matchZoomSpeakers(restarted)[0].reason, "clock-discontinuity");
});

test("shared multipart offsets and provider-normalized IDs use the production matcher", () => {
  const shifted = fixture();
  shifted.partOffsets[0].startFrame = shifted.epochs[0].timelineStartFrame = 60 * 24_000;
  shifted.transcript.segments = shifted.transcript.segments.map((s) => ({ ...s, start: s.start + 60, end: s.end + 60 }));
  assert.ok(matchZoomSpeakers(shifted).every((d) => d.status === "accepted"));
  assert.equal(matchZoomSpeakers(shifted)[0].intervals[0].start, 61);
  const { parseElevenLabsFileResponse }: typeof import("../../../../src/helpers/elevenLabsFileTranscription.ts") = require("../../../../src/helpers/elevenLabsFileTranscription.ts");
  const { parseDeepgramFileResponse }: typeof import("../../../../src/helpers/deepgramFileTranscription.ts") = require("../../../../src/helpers/deepgramFileTranscription.ts");
  const { parseGeminiFileResponse }: typeof import("../../../../src/helpers/geminiFileTranscription.ts") = require("../../../../src/helpers/geminiFileTranscription.ts");
  const starts = [0.5, 4.5, 8.5];
  const replies = [
    parseElevenLabsFileResponse({ text: "One Two Three", words: starts.map((start) => ({ type: "word", text: "Speech", start, end: start + 3, speaker_id: "fixture_7" })) }, true),
    parseDeepgramFileResponse({ results: { channels: [{ alternatives: [{ transcript: "Speech" }] }], utterances: starts.map((start) => ({ transcript: "Speech", start, end: start + 3, speaker: 11 })) } }, true),
    parseGeminiFileResponse({ status: "completed", output_text: "Speech", steps: [{ content: [{ type: "text", text: "Speech", annotations: starts.map((start) => ({ type: "word_info", text: "Speech", start_offset: `${start}s`, end_offset: `${start + 3}s`, speaker: "spk_4" })) }] }] }, true),
  ];
  const ids = new Set<string>();
  for (const reply of replies) {
    assert.equal(reply.success, true);
    assert.ok(reply.segments?.length);
    const decisions = matchZoomSpeakers({ ...fixture(), transcript: { text: reply.text!, segments: reply.segments.map((s) => ({ ...s, speaker: `system:${s.speaker}` })) } });
    assert.ok(decisions.every((d) => d.status === "accepted"));
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

test("a recreated tile inside continuous ASR speech is not another independent speech episode", () => {
  const input = fixture();
  input.observations[1].instanceKey = "new-tile";
  input.observations[2].sessionId = randomUUID();
  input.transcript.segments = [{ start: 0.5, end: 11.5, speaker: "system:provider-a", text: "One long speech bout" }];
  assert.ok(matchZoomSpeakers(input).every((d) => d.reason === "insufficient-independent-episodes"));
});

test("a known local candidate excludes its own name even when later activity says unknown self", () => {
  const input = fixture();
  input.observations.unshift(observation(0, { activity: "clear", self: "local", readEndHostNs: "10000000" }));
  assert.ok(matchZoomSpeakers(input).filter((d) => d.speakerId).every((d) => d.reason === "local-participant"));
  const compact = fixture();
  compact.observations.forEach((o) => { o.activity = "candidate"; o.windowMode = "compact"; o.reason = "activity-unconfirmed"; });
  assert.ok(matchZoomSpeakers(compact).every((d) => d.reason === "activity-unconfirmed"));
});

test("unknown or missing clock inside one turn cannot poison three usable later episodes", () => {
  for (const gap of ["ax", "clock"] as const) {
    const input = fixture();
    input.observations.push(observation(13));
    input.transcript.segments.push({ start: 12.5, end: 15.5, speaker: "system:provider-a", text: "Fourth" });
    input.anchors.push(...Array.from({ length: 4 }, (_, i) => anchor(14 + i, 15 + i)));
    input.epochs[0].frameCount = input.partOffsets[0].frameCount = 18 * 24_000;
    if (gap === "clock") input.anchors = input.anchors.filter((a) => a.clock.startFrame !== 2 * 24_000);
    else input.observations.push(observation(2, { activity: "unavailable", displayName: "", readEndHostNs: "2500000000", reason: "ax-incomplete" }));
    const decisions = matchZoomSpeakers(input);
    assert.equal(decisions[0].reason, gap === "clock" ? "clock-coverage-gap" : "activity-coverage-gap");
    assert.equal(decisions.filter((d) => d.status === "accepted").length, 3);
  }
});
