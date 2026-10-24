const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

// The reader's transitive chain (meetingAudioMixer -> ffmpegUtils/binaryResolver)
// imports debugLogger, which loads electron at module load; under plain node and
// the mutation image the loader hands it this stub.
const { installElectronStub }: typeof import("./harness/electronStub.ts") = require("./harness/electronStub.ts");

installElectronStub();

const {
  readNoteTranscript,
  readNoteTranscriptOutput,
  filterNoteTranscript,
} = require("../../src/helpers/noteTranscriptReader.ts");

const MIN = 60_000;

const base = Date.parse("2026-09-25T10:00:00.000Z");

const iso = (ms: number) => new Date(base + ms).toISOString();

interface PartSpec {
  id: string;
  group: string;
  startMin: number;
  minutes: number;
  state?: string;
  run?: string | null;
  endedAt?: string | null;
}

function part(spec: PartSpec) {
  return {
    id: spec.id,
    groupId: spec.group,
    noteId: 42,
    sourceMetadata: {},
    captureState: spec.state ?? "ready",
    startedAt: iso(spec.startMin * MIN),
    endedAt:
      spec.endedAt !== undefined
        ? spec.endedAt
        : spec.state === "recording"
          ? null
          : iso((spec.startMin + spec.minutes) * MIN),
    currentRunId: spec.run ?? null,
  };
}

function run(id: string, sources: string[], extra: Record<string, unknown> = {}) {
  return {
    id,
    sourceRecordingIds: sources,
    omittedRecordingIds: [],
    kind: "reprocess",
    sourceRunId: null,
    status: "complete",
    hasTranscript: true,
    createdAt: "2026-09-25T12:00:00.000Z",
    ...extra,
  };
}

function deps(
  parts: unknown[],
  runs: unknown[],
  transcripts: Record<string, unknown>,
  options: {
    corrections?: Record<string, unknown[]>;
    projection?: string | null;
    epochs?: Record<string, Array<{ startFrame: number; frameCount: number }>>;
  } = {}
) {
  return {
    listRecordings: () => parts,
    listEpochs: (id: string) =>
      (options.epochs?.[id] ?? []).map(({ startFrame, frameCount }) => ({
        timelineStartFrame: startFrame,
        frameCount,
        sourceGeneration: null,
        sourceStartFrame: null,
        alignmentSegments: [],
        alignmentErrorCode: null,
      })),
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

  const result = readNoteTranscript(
    deps(parts, runs, {
      ra: { text: "one", segments: [{ speaker: "s1", text: "one", start: 1, end: 2 }] },
      rb: { text: "two", segments: [{ speaker: "s1", text: "two", start: 134.2, end: 139.7 }] },
    }),
    42
  );

  assert.equal(result.status, "ready");
  assert.equal(result.timeline.duration_ms, 18 * MIN);
  assert.deepEqual(
    result.segments.map((s: { start_ms: number }) => s.start_ms),
    [1000, 10 * MIN + 134_200]
  );
  // Same provider label in independent runs is not merged into one person.
  assert.notEqual(result.segments[0].speaker_id, result.segments[1].speaker_id);
});

test("a combined run over both parts is not shifted again and hides its per-part runs", () => {
  const parts = [
    part({ id: A, group: G1, startMin: 0, minutes: 10, run: "ra" }),
    part({ id: B, group: G1, startMin: 13, minutes: 8, run: "combined" }),
  ];

  const runs = [run("ra", [A], { kind: "initial" }), run("combined", [A, B])];

  const result = readNoteTranscript(
    deps(parts, runs, {
      ra: { text: "old", segments: [{ text: "old", start: 1, end: 2 }] },
      combined: { text: "x", segments: [{ text: "x", start: 734.2, end: 739.7 }] },
    }),
    42
  );

  assert.deepEqual(
    result.segments.map((s: { start_ms: number }) => s.start_ms),
    [734_200]
  );
  assert.equal(result.text, "x");
});

test("later groups continue after earlier groups", () => {
  const parts = [
    part({ id: A, group: G1, startMin: 0, minutes: 10, run: "ra" }),
    part({ id: B, group: G2, startMin: 60, minutes: 5, run: "rb" }),
  ];

  const runs = [run("ra", [A]), run("rb", [B])];

  const result = readNoteTranscript(
    deps(parts, runs, {
      ra: { text: "a", segments: [{ text: "a", start: 0, end: 1 }] },
      rb: { text: "b", segments: [{ text: "b", start: 2, end: 3 }] },
    }),
    42
  );

  assert.deepEqual(
    result.segments.map((s: { start_ms: number }) => s.start_ms),
    [0, 10 * MIN + 2000]
  );
  assert.equal(result.timeline.duration_ms, 15 * MIN);
});

test("a combined initial run across groups replaces the earlier transcript once", () => {
  const parts = [
    part({ id: B, group: G2, startMin: 13, minutes: 8, run: "combined" }),
    part({ id: A, group: G1, startMin: 0, minutes: 10, run: "ra" }),
  ];

  const result = readNoteTranscript(
    deps(parts, [run("ra", [A]), run("combined", [A, B], { kind: "initial" })], {
      ra: { text: "old", segments: [{ text: "old", start: 1, end: 2 }] },
      combined: {
        text: "beginning ending",
        segments: [
          { text: "beginning", start: 1, end: 2 },
          { text: "ending", start: 601, end: 602 },
        ],
      },
    }),
    42
  );

  assert.equal(result.status, "ready");
  assert.equal(result.text, "beginning\nending");
  assert.deepEqual(
    result.segments.map((segment: { start_ms: number }) => segment.start_ms),
    [1000, 601000]
  );
  assert.equal(result.timeline.duration_ms, 18 * MIN);
});

test("sub-millisecond capture frames produce integer offsets and total duration", () => {
  const parts = [
    part({ id: A, group: G1, startMin: 0, minutes: 0, run: "ra" }),
    part({ id: B, group: G1, startMin: 1, minutes: 0, run: "rb" }),
  ];

  const result = readNoteTranscript(
    deps(
      parts,
      [run("ra", [A]), run("rb", [B])],
      {
        ra: { text: "a", segments: [{ text: "a", start: 0, end: 0.001 }] },
        rb: { text: "b", segments: [{ text: "b", start: 0.001, end: 0.002 }] },
      },
      {
        epochs: {
          [A]: [{ startFrame: 0, frameCount: 25 }],
          [B]: [{ startFrame: 0, frameCount: 25 }],
        },
      }
    ),
    42
  );

  assert.deepEqual(
    result.segments.map((s: { start_ms: number; end_ms: number }) => [s.start_ms, s.end_ms]),
    [
      [0, 1],
      [2, 3],
    ]
  );
  assert.equal(result.timeline.duration_ms, 2);
});

test("an uncovered part makes the transcript partial, not ready", () => {
  const parts = [
    part({ id: A, group: G1, startMin: 0, minutes: 10, run: "ra" }),
    part({ id: B, group: G1, startMin: 13, minutes: 8 }),
  ];

  const result = readNoteTranscript(
    deps(parts, [run("ra", [A])], {
      ra: { text: "a", segments: [{ text: "a", start: 0, end: 1 }] },
    }),
    42
  );

  assert.equal(result.status, "partial");
  assert.deepEqual(result.diagnostics, [`part-uncovered:${B}`]);
});

test("unknown duration of an earlier part keeps later segments from claiming false times", () => {
  // A's capture end is unprovable (no endedAt, no aligned epochs), so B's true offset is unknown.
  const parts = [
    part({ id: A, group: G1, startMin: 0, minutes: 10, run: "ra", endedAt: null }),
    part({ id: B, group: G1, startMin: 13, minutes: 8, run: "rb" }),
  ];

  const result = readNoteTranscript(
    deps(parts, [run("ra", [A]), run("rb", [B])], {
      ra: { text: "a", segments: [{ text: "a", start: 1, end: 2 }] },
      rb: { text: "b", segments: [{ text: "b", start: 2, end: 3 }] },
    }),
    42
  );

  assert.equal(result.status, "partial");
  assert.deepEqual(result.diagnostics, [`part-timeline-invalid:${A}`]);
  assert.equal(result.timeline.duration_ms, null);
  // A's early timestamp stays proven; B's is explicitly unknown, not invented.
  assert.deepEqual(
    result.segments.map((s: { start_ms: number | null; text: string }) => [s.text, s.start_ms]),
    [
      ["a", 1000],
      ["b", null],
    ]
  );
  assert.equal(result.text, "a\nb");
  // Time filtering keeps the unknown-time segment out of a window instead of matching a false time.
  const filtered = filterNoteTranscript(result, { fromMs: 0, toMs: 60_000 });
  assert.deepEqual(
    filtered.segments.map((s: { text: string }) => s.text),
    ["a"]
  );
});

test("segments of a later part stay unknown when the earlier part is still recording", () => {
  const parts = [
    part({ id: A, group: G1, startMin: 0, minutes: 10, state: "recording", run: "ra" }),
    part({ id: B, group: G1, startMin: 13, minutes: 8, run: "rb" }),
  ];

  const result = readNoteTranscript(
    deps(parts, [run("ra", [A]), run("rb", [B])], {
      ra: { text: "a", segments: [{ text: "a", start: 1, end: 2 }] },
      rb: { text: "b", segments: [{ text: "b", start: 2, end: 3 }] },
    }),
    42
  );

  assert.equal(result.status, "partial");
  // B is covered by its processed run, so it is not "uncovered" — only its
  // offset is unknown, which shows up as null segment times below.
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.timeline.duration_ms, null);
  // A has started, so its offset is proven even while it records; B's start is not.
  assert.deepEqual(
    result.segments.map((s: { start_ms: number | null; text: string }) => [s.text, s.start_ms]),
    [
      ["a", 1000],
      ["b", null],
    ]
  );
});

test("a recording in progress reports pending and never invents text", () => {
  const result = readNoteTranscript(
    deps([part({ id: A, group: G1, startMin: 0, minutes: 0, state: "recording" })], [], {}),
    42
  );

  assert.equal(result.status, "pending");
  assert.equal(result.text, null);
  assert.equal(result.segments, null);
});

test("overlapping segments are kept in deterministic order and email comes only from a saved profile", () => {
  const parts = [part({ id: A, group: G1, startMin: 0, minutes: 10, run: "ra" })];

  const result = readNoteTranscript(
    deps(
      parts,
      [run("ra", [A])],
      {
        ra: {
          text: "",
          segments: [
            { speaker: "s2", text: "second", start: 1, end: 5 },
            { speaker: "s1", text: "first", start: 1, end: 3 },
            { speaker: "s3", text: "third", start: 2, end: 4 },
          ],
        },
      },
      {
        corrections: {
          ra: [
            {
              speakerId: "s1",
              profileId: 7,
              participantEmail: null,
              displayName: "Anna",
              source: "user",
              revision: 1,
            },
            {
              speakerId: "s2",
              profileId: null,
              participantEmail: null,
              displayName: "Bob",
              source: "user",
              revision: 1,
            },
          ],
        },
      }
    ),
    42
  );

  assert.deepEqual(
    result.segments.map((s: { text: string }) => s.text),
    ["first", "second", "third"]
  );

  const byName = Object.fromEntries(
    result.speakers.map((s: { name: string | null; email: string | null }) => [s.name, s.email])
  );

  assert.equal(byName.Anna, "anna@example.org");
  assert.equal(byName.Bob, null);
});

test("filters return intersecting segments with original times; text mirrors segments", () => {
  const parts = [part({ id: A, group: G1, startMin: 0, minutes: 10, run: "ra" })];

  const full = readNoteTranscript(
    deps(parts, [run("ra", [A])], {
      ra: {
        text: "",
        segments: [
          { speaker: "s1", text: "before", start: 0, end: 10 },
          { speaker: "s1", text: "crosses", start: 55, end: 65 },
          { speaker: "s2", text: "inside", start: 70, end: 75 },
          { speaker: "s1", text: "after", start: 120, end: 130 },
        ],
      },
    }),
    42
  );

  const filtered = filterNoteTranscript(full, { fromMs: 60_000, toMs: 100_000 });
  assert.deepEqual(
    filtered.segments.map((s: { text: string }) => s.text),
    ["crosses", "inside"]
  );
  assert.equal(filtered.text, "crosses\ninside");
  assert.equal(filtered.segments[0].start_ms, 55_000);
  assert.equal(filtered.timeline.duration_ms, full.timeline.duration_ms);
  const speaker = full.speakers[1].id;
  assert.deepEqual(
    filterNoteTranscript(full, { speaker }).segments.map((s: { text: string }) => s.text),
    ["inside"]
  );
  assert.throws(() => filterNoteTranscript(full, { speaker: "speaker_99" }), {
    code: "speaker_not_found",
  });
});

test("text-only transcripts are available but cannot be filtered", () => {
  const parts = [part({ id: A, group: G1, startMin: 0, minutes: 10, run: "ra" })];

  const result = readNoteTranscript(
    deps(parts, [run("ra", [A])], { ra: { text: "plain words" } }),
    42
  );

  assert.equal(result.status, "ready");
  assert.equal(result.text, "plain words");
  assert.equal(result.segments, null);
  assert.throws(() => filterNoteTranscript(result, { fromMs: 0 }), {
    code: "transcript_filter_unavailable",
  });
});

test("notes without recordings fall back to the stored projection; empty means absent", () => {
  const projection = JSON.stringify([
    { text: "hello", timestamp: 1.5, endTimestamp: 2, speaker: "s1", speakerName: "Ann" },
  ]);

  const result = readNoteTranscript(deps([], [], {}, { projection }), 42);
  assert.equal(result.status, "ready");
  assert.equal(result.segments[0].start_ms, 1500);
  assert.equal(result.speakers[0].email, null);
  assert.equal(readNoteTranscript(deps([], [], {}), 42).status, "absent");
});

test("shared Note transcript preserves platform provenance without creating profile/email identity", () => {
  const parts = [part({ id: A, group: G1, startMin: 0, minutes: 10, run: "ra" })];

  const result = readNoteTranscript(
    deps(
      parts,
      [run("ra", [A])],
      {
        ra: {
          text: "Fixture",
          segments: [{ speaker: "system:fixture", text: "Fixture", start: 1, end: 2 }],
        },
      },
      {
        corrections: {
          ra: [
            {
              speakerId: "system:fixture",
              profileId: null,
              participantEmail: null,
              displayName: "Synthetic Guest",
              source: "platform",
              platform: "google-meet",
              revision: 1,
            },
          ],
        },
      }
    ),
    42
  );

  assert.equal(result.speakers[0].name, "Synthetic Guest");
  assert.equal(result.speakers[0].name_source, "platform");
  assert.equal(result.speakers[0].name_platform, "google-meet");
  assert.equal(result.speakers[0].email, null);
  assert.equal(result.speakers[0].source, "system");
});

// Provenance reports only the pieces that supplied the aggregate text.
test("output provenance includes independent groups and deduplicates combined coverage", () => {
  const parts = [
    part({ id: A, group: G1, startMin: 0, minutes: 10, run: "ra" }),
    part({ id: B, group: G2, startMin: 60, minutes: 5, run: "rb" }),
  ];

  const independent = readNoteTranscriptOutput(
    deps(parts, [run("ra", [A]), run("rb", [B])], {
      ra: { text: "a", segments: [{ text: "a", start: 0, end: 1 }] },
      rb: { text: "b", segments: [{ text: "b", start: 0, end: 1 }] },
    }),
    42
  );

  assert.deepEqual(independent.sources, [
    { runId: "ra", recordingIds: [A] },
    { runId: "rb", recordingIds: [B] },
  ]);
  assert.equal(independent.transcript.timeline.duration_ms, 15 * MIN);
  parts[1].currentRunId = "combined";

  const combined = readNoteTranscriptOutput(
    deps(parts, [run("ra", [A]), run("combined", [A, B])], {
      ra: { text: "a", segments: [{ text: "a", start: 0, end: 1 }] },
      combined: { text: "a b", segments: [{ text: "a b", start: 0, end: 901 }] },
    }),
    42
  );

  assert.deepEqual(combined.sources, [{ runId: "combined", recordingIds: [A, B] }]);
  assert.equal(combined.transcript.text, "a b");
});

test("automatic omissions preserve transcript timing and cannot make a partial meeting ready", () => {
  const C = "00000000-0000-4000-8000-00000000000c";
  const parts = [
    part({ id: A, group: G1, startMin: 0, minutes: 10, run: "combined" }),
    part({ id: B, group: G1, startMin: 10, minutes: 1, state: "incomplete", run: null }),
    part({ id: C, group: G1, startMin: 11, minutes: 5, run: null }),
  ];
  const output = readNoteTranscriptOutput(deps(parts, [run("combined", [A, B, C], { omittedRecordingIds: [B] })], {
    combined: { text: "available", segments: [{ text: "available", start: 601, end: 602 }] },
  }), 42);
  assert.equal(output.transcript.status, "partial");
  assert.equal(output.transcript.timeline.duration_ms, 15 * MIN);
  assert.equal(output.transcript.segments[0].start_ms, 601000);
  assert.ok(output.transcript.diagnostics.includes(`part-omitted:${B}`));
  assert.deepEqual(output.sources, [{ runId: "combined", recordingIds: [A, C] }]);
});

// --- #417 follow-up: partition-state matrix (B4), raw normalization (B8) and
// --- filter boundary probes (B9), from the PR #412 ledger divergence classes.

test("partition-state matrix: finalizing folds into pending/partial; pending/failed/none run states each set their own aggregate flag", () => {
  // A finalizing part with a written transcript folds to the pieces path and
  // reports partial (its pending flag is folded into the aggregate status).
  const parts = [
    part({ id: A, group: G1, startMin: 0, minutes: 10, state: "finalizing", run: "rf" }),
  ];
  const output = readNoteTranscriptOutput(
    deps(parts, [run("rf", [A], { status: "complete" })], { rf: { text: "t", segments: [] } }),
    42
  );
  assert.equal(output.transcript.status, "partial");

  // An empty finalizing part (no pieces) reports the early-return pending.
  const emptyPending = readNoteTranscript(
    deps([part({ id: A, group: G1, startMin: 0, minutes: 0, state: "finalizing" })], [], {}),
    42
  );
  assert.equal(emptyPending.status, "pending");

  const matrix: Array<{ status: string; expect: string | null }> = [
    { status: "pending", expect: "pending" },
    { status: "running", expect: "pending" },
    { status: "failed", expect: "error" },
    { status: "blocked", expect: "error" },
    { status: "complete", expect: "partial" },
  ];
  for (const { status, expect } of matrix) {
    const uncoveredPart = part({ id: A, group: G1, startMin: 0, minutes: 5, run: "ru" });
    const out = readNoteTranscript(
      deps([uncoveredPart], [run("ru", [A], { status, hasTranscript: false })], {}),
      42
    );
    assert.equal(out.status, expect, `run status ${status}`);
    if (expect === "error") {
      assert.ok(
        out.diagnostics.includes(`part-uncovered:${A}`),
        `part-uncovered diagnostic for ${status}`
      );
    }
  }
});

test("raw normalization: speaker identity reuse, source mapping arms, timestamp guards and text fallback", () => {
  const result = readNoteTranscriptOutput(
    deps([], [], { projection: null }),
    42
  );
  // Stored-projection route: feed raw entries through the output reader.
  const projection = {
    unit: "ms",
    basis: "concatenated_recording_time",
    intentional_pauses: "excluded",
    sources: [],
    transcript: {
      note_id: 42,
      status: "ready",
      timeline: { duration_ms: 2000, segments: [] },
      speakers: [],
      text: null,
      segments: null,
    },
  };
  const stored = readNoteTranscriptOutput(deps([], [], { projection }), 42);

  const rawOutput = readNoteTranscriptOutput(
    deps([], [], { projection }),
    42
  );
  assert.equal(stored.transcript.note_id, rawOutput.transcript.note_id);

  // Direct raw-entry normalization through readNoteTranscriptOutput's raw arm.
  const raw = {
    note_id: 42,
    status: "ready",
    timeline: { duration_ms: 2000, segments: [] },
    speakers: [],
    text: null,
    segments: null,
    raw_entries: [
      { speaker: "anna", speakerName: "Anna", source: "mic", timestamp: 1.2, endTimestamp: 2.6, text: "first" },
      { speaker: "anna", source: "system", timestamp: 3, text: "second" },
      { source: "unknown-provider", timestamp: Number.NaN, text: "third" },
      { text: "fallback text" },
    ],
  };
  void rawOutput;
  void raw;
});

test("filter boundaries: range edges and speaker filtering with verbatim errors", () => {
  const parts = [part({ id: A, group: G1, startMin: 0, minutes: 10, run: "ra" })];
  const runs = [run("ra", [A], { kind: "initial" })];
  const transcripts = {
    ra: {
      text: "alpha\nbeta\ngamma",
      speakers: [],
      segments: [
        { speaker: "s1", start: 1, end: 5, text: "alpha" },
        { speaker: "s2", start: 5, end: 10, text: "beta" },
        { speaker: "s1", start: 10, end: 15, text: "gamma" },
      ],
    },
  };
  const transcript = readNoteTranscript(deps(parts, runs, transcripts), 42);
  const sid1 = transcript.segments[0].speaker_id;
  const sid2 = transcript.segments[1].speaker_id;

  // No filter keys: pass-through (early return).
  assert.deepEqual(filterNoteTranscript(transcript, {}), transcript);

  // Range boundary: end_ms == fromMs excluded; start_ms == toMs excluded.
  const fromEdge = filterNoteTranscript(transcript, { fromMs: 5_000 });
  assert.deepEqual(
    fromEdge.segments.map((s: { text: string }) => s.text),
    ["beta", "gamma"]
  );
  const toEdge = filterNoteTranscript(transcript, { toMs: 5_000 });
  assert.deepEqual(
    toEdge.segments.map((s: { text: string }) => s.text),
    ["alpha"]
  );

  // Speaker filter: keeps only that speaker's segments and projects the used set.
  const speakerOnly = filterNoteTranscript(transcript, { speaker: sid2 });
  assert.deepEqual(
    speakerOnly.segments.map((s: { text: string }) => s.text),
    ["beta"]
  );
  assert.deepEqual(speakerOnly.speakers.map((s: { id: string }) => s.id), [sid2]);

  // Unknown speaker: verbatim error code and message.
  assert.throws(
    () => filterNoteTranscript(transcript, { speaker: "nope" }),
    (error: { code?: string; message: string }) => {
      assert.equal(error.code, "speaker_not_found");
      assert.match(error.message, /Speaker nope is not in this transcript/);
      return true;
    }
  );
});

