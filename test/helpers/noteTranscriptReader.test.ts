const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { readNoteTranscript, filterNoteTranscript } = require("../../src/helpers/noteTranscriptReader.ts");

const MIN = 60_000;
const base = Date.parse("2026-09-25T10:00:00.000Z");
const iso = (ms: number) => new Date(base + ms).toISOString();

interface PartSpec { id: string; group: string; startMin: number; minutes: number; state?: string; run?: string | null }
function part(spec: PartSpec) {
  return {
    id: spec.id,
    groupId: spec.group,
    noteId: 42,
    captureState: spec.state ?? "ready",
    startedAt: iso(spec.startMin * MIN),
    endedAt: spec.state === "recording" ? null : iso((spec.startMin + spec.minutes) * MIN),
    currentRunId: spec.run ?? null,
  };
}
function run(id: string, sources: string[], extra: Record<string, unknown> = {}) {
  return { id, sourceRecordingIds: sources, kind: "reprocess", sourceRunId: null, status: "complete", hasTranscript: true, createdAt: "2026-09-25T12:00:00.000Z", ...extra };
}
function deps(parts: unknown[], runs: unknown[], transcripts: Record<string, unknown>, options: { corrections?: Record<string, unknown[]>; projection?: string | null; epochs?: Record<string, Array<{ startFrame: number; frameCount: number }>> } = {}) {
  return {
    listRecordings: () => parts,
    listEpochs: (id: string) => options.epochs?.[id] ?? [],
    getRun: (id: string) => (runs as Array<{ id: string }>).find((item) => item.id === id) ?? null,
    readTranscript: (id: string) => transcripts[id] ?? null,
    getCorrections: (id: string) => options.corrections?.[id] ?? [],
    profileEmail: (id: number) => (id === 7 ? "anna@example.org" : null),
    getProjection: () => options.projection ?? null,
  };
}
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const G1 = "00000000-0000-4000-8000-0000000000a1";
const G2 = "00000000-0000-4000-8000-0000000000a2";

test("separate part runs are shifted once by recorded length; the pause is excluded", () => {
  const parts = [
    part({ id: A, group: G1, startMin: 0, minutes: 10, run: "ra" }),
    part({ id: B, group: G1, startMin: 13, minutes: 8, run: "rb" }),
  ];
  const runs = [run("ra", [A], { kind: "initial" }), run("rb", [B], { kind: "initial" })];
  const result = readNoteTranscript(deps(parts, runs, {
    ra: { text: "one", segments: [{ speaker: "s1", text: "one", start: 1, end: 2 }] },
    rb: { text: "two", segments: [{ speaker: "s1", text: "two", start: 134.2, end: 139.7 }] },
  }), 42);
  assert.equal(result.status, "ready");
  assert.equal(result.timeline.duration_ms, 18 * MIN);
  assert.deepEqual(result.segments.map((s: { start_ms: number }) => s.start_ms), [1000, 10 * MIN + 134_200]);
  // Same provider label in independent runs is not merged into one person.
  assert.notEqual(result.segments[0].speaker_id, result.segments[1].speaker_id);
});

test("a combined run over both parts is not shifted again and hides its per-part runs", () => {
  const parts = [
    part({ id: A, group: G1, startMin: 0, minutes: 10, run: "ra" }),
    part({ id: B, group: G1, startMin: 13, minutes: 8, run: "combined" }),
  ];
  const runs = [run("ra", [A], { kind: "initial" }), run("combined", [A, B])];
  const result = readNoteTranscript(deps(parts, runs, {
    ra: { text: "old", segments: [{ text: "old", start: 1, end: 2 }] },
    combined: { text: "x", segments: [{ text: "x", start: 734.2, end: 739.7 }] },
  }), 42);
  assert.deepEqual(result.segments.map((s: { start_ms: number }) => s.start_ms), [734_200]);
  assert.equal(result.text, "x");
});

test("later groups continue after earlier groups", () => {
  const parts = [
    part({ id: A, group: G1, startMin: 0, minutes: 10, run: "ra" }),
    part({ id: B, group: G2, startMin: 60, minutes: 5, run: "rb" }),
  ];
  const runs = [run("ra", [A]), run("rb", [B])];
  const result = readNoteTranscript(deps(parts, runs, {
    ra: { text: "a", segments: [{ text: "a", start: 0, end: 1 }] },
    rb: { text: "b", segments: [{ text: "b", start: 2, end: 3 }] },
  }), 42);
  assert.deepEqual(result.segments.map((s: { start_ms: number }) => s.start_ms), [0, 10 * MIN + 2000]);
  assert.equal(result.timeline.duration_ms, 15 * MIN);
});

test("a combined initial run across groups replaces the earlier transcript once", () => {
  const parts = [
    part({ id: B, group: G2, startMin: 13, minutes: 8, run: "combined" }),
    part({ id: A, group: G1, startMin: 0, minutes: 10, run: "ra" }),
  ];
  const result = readNoteTranscript(deps(parts, [run("ra", [A]), run("combined", [A, B], { kind: "initial" })], {
    ra: { text: "old", segments: [{ text: "old", start: 1, end: 2 }] },
    combined: { text: "beginning ending", segments: [
      { text: "beginning", start: 1, end: 2 },
      { text: "ending", start: 601, end: 602 },
    ] },
  }), 42);
  assert.equal(result.status, "ready");
  assert.equal(result.text, "beginning\nending");
  assert.deepEqual(result.segments.map((segment: { start_ms: number }) => segment.start_ms), [1000, 601000]);
  assert.equal(result.timeline.duration_ms, 18 * MIN);
});

test("sub-millisecond capture frames produce integer offsets and total duration", () => {
  const parts = [
    part({ id: A, group: G1, startMin: 0, minutes: 0, run: "ra" }),
    part({ id: B, group: G1, startMin: 1, minutes: 0, run: "rb" }),
  ];
  const result = readNoteTranscript(deps(parts, [run("ra", [A]), run("rb", [B])], {
    ra: { text: "a", segments: [{ text: "a", start: 0, end: 0.001 }] },
    rb: { text: "b", segments: [{ text: "b", start: 0.001, end: 0.002 }] },
  }, { epochs: { [A]: [{ startFrame: 0, frameCount: 25 }], [B]: [{ startFrame: 0, frameCount: 25 }] } }), 42);
  assert.deepEqual(result.segments.map((s: { start_ms: number; end_ms: number }) => [s.start_ms, s.end_ms]), [[0, 1], [2, 3]]);
  assert.equal(result.timeline.duration_ms, 2);
});

test("an uncovered part makes the transcript partial, not ready", () => {
  const parts = [
    part({ id: A, group: G1, startMin: 0, minutes: 10, run: "ra" }),
    part({ id: B, group: G1, startMin: 13, minutes: 8 }),
  ];
  const result = readNoteTranscript(deps(parts, [run("ra", [A])], { ra: { text: "a", segments: [{ text: "a", start: 0, end: 1 }] } }), 42);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.diagnostics, [`part-uncovered:${B}`]);
});

test("a recording in progress reports pending and never invents text", () => {
  const result = readNoteTranscript(deps([part({ id: A, group: G1, startMin: 0, minutes: 0, state: "recording" })], [], {}), 42);
  assert.equal(result.status, "pending");
  assert.equal(result.text, null);
  assert.equal(result.segments, null);
});

test("overlapping segments are kept in deterministic order and email comes only from a saved profile", () => {
  const parts = [part({ id: A, group: G1, startMin: 0, minutes: 10, run: "ra" })];
  const result = readNoteTranscript(deps(parts, [run("ra", [A])], {
    ra: { text: "", segments: [
      { speaker: "s2", text: "second", start: 1, end: 5 },
      { speaker: "s1", text: "first", start: 1, end: 3 },
      { speaker: "s3", text: "third", start: 2, end: 4 },
    ] },
  }, { corrections: { ra: [{ speakerId: "s1", profileId: 7, participantEmail: null, displayName: "Anna", source: "user", revision: 1 }, { speakerId: "s2", profileId: null, participantEmail: null, displayName: "Bob", source: "user", revision: 1 }] } }), 42);
  assert.deepEqual(result.segments.map((s: { text: string }) => s.text), ["first", "second", "third"]);
  const byName = Object.fromEntries(result.speakers.map((s: { name: string | null; email: string | null }) => [s.name, s.email]));
  assert.equal(byName.Anna, "anna@example.org");
  assert.equal(byName.Bob, null);
});

test("filters return intersecting segments with original times; text mirrors segments", () => {
  const parts = [part({ id: A, group: G1, startMin: 0, minutes: 10, run: "ra" })];
  const full = readNoteTranscript(deps(parts, [run("ra", [A])], {
    ra: { text: "", segments: [
      { speaker: "s1", text: "before", start: 0, end: 10 },
      { speaker: "s1", text: "crosses", start: 55, end: 65 },
      { speaker: "s2", text: "inside", start: 70, end: 75 },
      { speaker: "s1", text: "after", start: 120, end: 130 },
    ] },
  }), 42);
  const filtered = filterNoteTranscript(full, { fromMs: 60_000, toMs: 100_000 });
  assert.deepEqual(filtered.segments.map((s: { text: string }) => s.text), ["crosses", "inside"]);
  assert.equal(filtered.text, "crosses\ninside");
  assert.equal(filtered.segments[0].start_ms, 55_000);
  assert.equal(filtered.timeline.duration_ms, full.timeline.duration_ms);
  const speaker = full.speakers[1].id;
  assert.deepEqual(filterNoteTranscript(full, { speaker }).segments.map((s: { text: string }) => s.text), ["inside"]);
  assert.throws(() => filterNoteTranscript(full, { speaker: "speaker_99" }), { code: "speaker_not_found" });
});

test("text-only transcripts are available but cannot be filtered", () => {
  const parts = [part({ id: A, group: G1, startMin: 0, minutes: 10, run: "ra" })];
  const result = readNoteTranscript(deps(parts, [run("ra", [A])], { ra: { text: "plain words" } }), 42);
  assert.equal(result.status, "ready");
  assert.equal(result.text, "plain words");
  assert.equal(result.segments, null);
  assert.throws(() => filterNoteTranscript(result, { fromMs: 0 }), { code: "transcript_filter_unavailable" });
});

test("notes without recordings fall back to the stored projection; empty means absent", () => {
  const projection = JSON.stringify([{ text: "hello", timestamp: 1.5, endTimestamp: 2, speaker: "s1", speakerName: "Ann" }]);
  const result = readNoteTranscript(deps([], [], {}, { projection }), 42);
  assert.equal(result.status, "ready");
  assert.equal(result.segments[0].start_ms, 1500);
  assert.equal(result.speakers[0].email, null);
  assert.equal(readNoteTranscript(deps([], [], {}), 42).status, "absent");
});


test("shared Note transcript preserves platform provenance without creating profile/email identity", () => {
  const parts = [part({ id: A, group: G1, startMin: 0, minutes: 10, run: "ra" })];
  const result = readNoteTranscript(deps(parts, [run("ra", [A])], {
    ra: { text: "Fixture", segments: [{ speaker: "system:fixture", text: "Fixture", start: 1, end: 2 }] },
  }, { corrections: { ra: [{ speakerId: "system:fixture", profileId: null, participantEmail: null, displayName: "Synthetic Guest", source: "platform", revision: 1 }] } }), 42);
  assert.equal(result.speakers[0].name, "Synthetic Guest");
  assert.equal(result.speakers[0].name_source, "platform");
  assert.equal(result.speakers[0].email, null);
  assert.equal(result.speakers[0].source, "system");
});
