import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MeetSpeakerEvidence } from "../../../../src/helpers/meetSpeakerEvidence.ts";
import type { MeetingPlatformObservation } from "../../../../src/contracts/meetingRecording.ts";
import type { MeetingClockMapping } from "../../../../src/helpers/meetingClockSync.ts";
import type { CompanionBinding, CompanionContext } from "../../../../src/contracts/companion.ts";
const generation = randomUUID();
const binding: CompanionBinding = { id: randomUUID(), generation: 0, recordingId: randomUUID(), sessionId: randomUUID(), connectionId: randomUUID(),
  ref: { platform: "google-meet", installationId: randomUUID(), sessionId: randomUUID(), tabId: 1, documentId: randomUUID().replaceAll("-", "").toUpperCase(), callId: "abc-defg-hij" } };
const context = (seconds: number, active = ["alice"]): CompanionContext => ({ sourceNs: String(seconds * 1e9), presence: "in-call", health: "recognized", reason: null,
  mode: "standard", micMuted: false, rosterComplete: false, confirmedLeave: false, activeParticipantIds: active,
  participants: [{ id: "alice", name: "Alice", self: "remote" }, { id: "bob", name: "Bob", self: "remote" }] });
function mapping(seconds: number): MeetingClockMapping {
  const value = String(seconds * 1e9 + 1e12);
  return { generation, rate: 1, offsetNs: 1e12, uncertaintyNs: 100, sampledAtSourceNs: String(seconds * 1e9),
    sourceStartNs: "0", sourceEndNs: "10000000000", helperStartNs: "1000000000000", helperEndNs: "1010000000000",
    helperEstimateNs: value, helperMinimumNs: String(BigInt(value) - 100n), helperMaximumNs: String(BigInt(value) + 100n), sampleCount: 3 };
}
test("single snapshot never names; continued calibrated active set retains bounded ranges and independent episodes", () => {
  const rows: MeetingPlatformObservation[] = []; const evidence = new MeetSpeakerEvidence((row) => rows.push(row));
  evidence.observe(binding, context(1), mapping(1)); assert.equal(rows.length, 0);
  evidence.observe(binding, context(2), mapping(2));
  assert.equal(rows[0].activity, "explicit"); assert.equal(rows[1].activity, "candidate");
  assert.equal(rows[0].readStartHostNs, mapping(1).helperMaximumNs);
  assert.equal(rows[0].readEndHostNs, mapping(2).helperMinimumNs);
  const first = rows[0].episodeId;
  evidence.observe(binding, context(3, []), mapping(3));
  evidence.observe(binding, context(4), mapping(4)); evidence.observe(binding, context(5), mapping(5));
  assert.notEqual(rows.at(-2)?.episodeId, first);
});
test("missing/stale/high-uncertainty clocks and generation changes break activity continuity", () => {
  for (const invalid of [null, { ...mapping(2), uncertaintyNs: 25_000_001 }]) {
    const rows: MeetingPlatformObservation[] = []; const evidence = new MeetSpeakerEvidence((row) => rows.push(row));
    evidence.observe(binding, context(1), mapping(1)); evidence.observe(binding, context(2), invalid);
    evidence.observe(binding, context(3), mapping(3)); assert.equal(rows.length, 0);
    evidence.observe({ ...binding, generation: 1 }, context(4), mapping(4)); assert.equal(rows.length, 0);
    evidence.observe({ ...binding, generation: 1 }, context(8), mapping(8)); assert.equal(rows.length, 0);
  }
});
test("multi-active observations remain ambiguous instead of choosing a tile", () => {
  const rows: MeetingPlatformObservation[] = []; const evidence = new MeetSpeakerEvidence((row) => rows.push(row));
  evidence.observe(binding, context(1, ["alice", "bob"]), mapping(1)); evidence.observe(binding, context(2, ["alice", "bob"]), mapping(2));
  assert.equal(rows.length, 2); assert.ok(rows.every((row) => row.activity === "ambiguous" && row.activeParticipantIds.length === 2));
});


test("shared browser evidence preserves Telemost provenance without inventing activity", () => {
  const rows: MeetingPlatformObservation[] = []; const evidence = new MeetSpeakerEvidence(row => rows.push(row));
  const telemost: CompanionBinding = { ...binding, ref: { ...binding.ref, platform: "telemost", callId: "12345678901234" } };
  evidence.observe(telemost, context(1, []), mapping(1));
  evidence.observe(telemost, context(2, []), mapping(2));
  assert.ok(rows.every(row => row.platform === "telemost" && row.activity === "candidate"));
});
