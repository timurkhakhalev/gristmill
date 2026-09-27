const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const load = () => import("../../src/utils/transcriptSpeakerState.js");
type TranscriptSegment = import("../../src/contracts/meetingCoordinator.js").MeetingTranscriptSegment;

const seg = (segment: Omit<TranscriptSegment, "id" | "text" | "source">): TranscriptSegment => ({ id: "seg", text: "hi", source: "system", ...segment });

const userAssigned = (speaker: string, speakerName: string) =>
  seg({
    source: "system",
    speaker,
    speakerName,
    speakerLocked: true,
    speakerLockSource: "user",
    speakerStatus: "locked",
  });

const clusterOnly = (speaker: string) => seg({ source: "system", speaker });

test("a user-assigned segment name outranks the cluster mapping", async () => {
  const { resolveSegmentSpeakerName } = await load();
  const segment = userAssigned("speaker_0", "Bob");

  assert.equal(resolveSegmentSpeakerName(segment, { speaker_0: "Alice" }), "Bob");
});

test("the cluster mapping still names segments the user has not touched", async () => {
  const { resolveSegmentSpeakerName } = await load();

  assert.equal(
    resolveSegmentSpeakerName(clusterOnly("speaker_0"), { speaker_0: "Alice" }),
    "Alice"
  );
});

test("an auto-assigned name does not outrank the mapping", async () => {
  const { resolveSegmentSpeakerName } = await load();
  // Diarization sets confirmed, not locked; only a user edit should win.
  const segment = seg({
    source: "system",
    speaker: "speaker_0",
    speakerName: "Speaker 1",
    speakerStatus: "confirmed",
  });

  assert.equal(resolveSegmentSpeakerName(segment, { speaker_0: "Alice" }), "Alice");
});

test("falls back to the segment name, then to nothing", async () => {
  const { resolveSegmentSpeakerName } = await load();

  assert.equal(resolveSegmentSpeakerName(seg({ source: "system", speakerName: "Bob" }), {}), "Bob");
  assert.equal(resolveSegmentSpeakerName(clusterOnly("speaker_0"), {}), undefined);
  assert.equal(resolveSegmentSpeakerName(seg({ source: "mic" }), undefined), undefined);
});

test("own-voice segments are unaffected by a mapping on another cluster", async () => {
  const { resolveSegmentSpeakerName } = await load();
  const you = seg({ source: "mic", speaker: "you" });

  assert.equal(resolveSegmentSpeakerName(you, { speaker_0: "Alice" }), undefined);
});
