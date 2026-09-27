const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/transcriptSpeakerState.ts");

const userAssigned = (speaker, speakerName) => ({
  source: "system",
  speaker,
  speakerName,
  speakerLocked: true,
  speakerLockSource: "user",
  speakerStatus: "locked",
});

const clusterOnly = (speaker) => ({ source: "system", speaker });

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
  const segment = {
    source: "system",
    speaker: "speaker_0",
    speakerName: "Speaker 1",
    speakerStatus: "confirmed",
  };

  assert.equal(resolveSegmentSpeakerName(segment, { speaker_0: "Alice" }), "Alice");
});

test("falls back to the segment name, then to nothing", async () => {
  const { resolveSegmentSpeakerName } = await load();

  assert.equal(resolveSegmentSpeakerName({ source: "system", speakerName: "Bob" }, {}), "Bob");
  assert.equal(resolveSegmentSpeakerName(clusterOnly("speaker_0"), {}), undefined);
  assert.equal(resolveSegmentSpeakerName({ source: "mic" }, undefined), undefined);
});

test("own-voice segments are unaffected by a mapping on another cluster", async () => {
  const { resolveSegmentSpeakerName } = await load();
  const you = { source: "mic", speaker: "you" };

  assert.equal(resolveSegmentSpeakerName(you, { speaker_0: "Alice" }), undefined);
});
