import type { MeetingFrameAlignmentSegment } from "../../../../src/contracts/meetingRecording.js";

const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const {
  createDb,
  DatabaseManager,
}: typeof import("../../../helpers/harness/db.ts") = require("../../../helpers/harness/db.ts");

const {
  getUserDataDir,
}: typeof import("../../../helpers/harness/electronStub.ts") = require("../../../helpers/harness/electronStub.ts");

const {
  MeetingRecordingStorage,
}: typeof import("../../../../src/helpers/meetingRecordingStorage.ts") = require("../../../../src/helpers/meetingRecordingStorage.ts");

const {
  MeetingCaptureSession,
}: typeof import("../../../../src/helpers/meetingCaptureSession.ts") = require("../../../../src/helpers/meetingCaptureSession.ts");

const {
  alignedAudioRanges,
}: typeof import("../../../../src/helpers/meetingAudioAlignment.ts") = require("../../../../src/helpers/meetingAudioAlignment.ts");

function alignment(end: number, offset = 0): MeetingFrameAlignmentSegment {
  return {
    sourceGeneration: 1,
    sourceStartFrame: 0,
    sourceEndFrame: end,
    timelineStartFrame: offset,
    rate: 1,
    uncertaintyStartFrames: 2,
    uncertaintyEndFrames: 2,
    helperGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sourceStartNs: "1000000000",
    sourceEndNs: String(1_000_000_000 + Math.round((end / 24_000) * 1e9)),
    helperStartNs: "1000000000",
    helperEndNs: String(1_000_000_000 + Math.round((end / 24_000) * 1e9)),
    sampledSourceStartNs: "1000000000",
    sampledSourceEndNs: "1300000000",
    freshnessSourceNs: "1300000000",
  };
}

for (const resolved of [false, true]) {
  test(`raw capture survives missing alignment; late calibration ${resolved ? "resolves" : "leaves blocked"} prepare after reopen`, async (t) => {
    const db = createDb(t);

    if (!db) return;
    const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
    const note = db.saveNote("Alignment regression", "", "meeting").note!;
    const capture = MeetingCaptureSession.create(db, storage, note.id, null);
    const pcm = Buffer.alloc(4_800, 3);

    for (let sequence = 0; sequence < 3; sequence++) {
      capture.appendRendererSamples(
        "mic",
        {
          epochIndex: 0,
          epochSourceStartFrame: 0,
          sourceFrameStart: sequence * 2_400,
          sourceGeneration: 1,
          sequence,
          sampleOffset: sequence * 2_400,
          alignment: resolved && sequence > 0 ? alignment((sequence + 1) * 2_400, sequence) : null,
          alignmentErrorCode: "clock-unavailable",
        },
        pcm
      );
      capture.appendNativeSamples("system", 1, pcm, sequence * 2_400, sequence * 2_400);
    }

    assert.equal((await capture.stop({ lastSequence: { mic: 2 } })).captureState, "ready");
    const rawPath = storage.getEpochFilePath(capture.recordingId, "mic", 0);
    const original = fs.readFileSync(rawPath);
    assert.ok(original.length > 0);
    db.close();
    const reopened = new DatabaseManager();

    try {
      const epoch = reopened
        .listMeetingRecordingEpochs(capture.recordingId)
        .find((value) => value.source === "mic")!;

      assert.equal(
        epoch.frameCount,
        7_200,
        "calibration changes never change raw append continuity"
      );
      assert.equal(epoch.timelineStartFrame, null, "source zero is not a fabricated common origin");

      if (resolved)
        assert.deepEqual(alignedAudioRanges(epoch).map(({ provenance, ...numeric }) => numeric), [
          { fileStartFrame: 0, frameCount: 7_200, timelineStartFrame: 2, rate: 1 },
        ]);
      else assert.throws(() => alignedAudioRanges(epoch), { code: "audio-alignment-unavailable" });
      assert.deepEqual(fs.readFileSync(rawPath), original, "prepare never mutates raw capture");

      if (resolved) {
        const uncertain = {
          ...epoch,
          alignmentSegments: epoch.alignmentSegments.map((segment) => ({
            ...segment,
            uncertaintyEndFrames: 601,
          })),
        };

        assert.throws(() => alignedAudioRanges(uncertain), { code: "audio-alignment-unavailable" });
      }
    } finally {
      reopened.close();
    }
  });
}

test("clock schema migration preserves historical offsets and permits unresolved new epochs", (t) => {
  const db = createDb(t);

  if (!db) return;
  const note = db.saveNote("Historical recording", "Keep note", "meeting").note!;
  const recording = db.createMeetingRecording(note.id, { config: null });
  db.close();
  const path: typeof import("node:path") = require("node:path");

  const filename = fs
    .readdirSync(getUserDataDir())
    .find((name) => /^transcriptions.*\.db$/.test(name));

  assert.ok(filename);
  const Sqlite = require("better-sqlite3");
  const raw = new Sqlite(path.join(getUserDataDir(), filename));

  try {
    raw.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE meeting_recording_epochs;
      CREATE TABLE meeting_recording_epochs (
        recording_id TEXT NOT NULL REFERENCES meeting_recordings(id) ON DELETE CASCADE,
        source TEXT NOT NULL, epoch_index INTEGER NOT NULL, start_frame INTEGER NOT NULL CHECK(start_frame >= 0),
        sample_rate INTEGER NOT NULL, channels INTEGER NOT NULL, encoding TEXT NOT NULL, relative_path TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'open', frame_count INTEGER NOT NULL DEFAULT 0, ignored_trailing_bytes INTEGER NOT NULL DEFAULT 0,
        error_code TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(recording_id, source, epoch_index)
      );
      DROP TABLE meeting_recording_intentional_intervals;
      CREATE TABLE meeting_recording_intentional_intervals (
        id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES meeting_recordings(id) ON DELETE CASCADE,
        source TEXT NOT NULL, start_frame INTEGER NOT NULL CHECK(start_frame >= 0), end_frame INTEGER,
        reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    raw
      .prepare(`INSERT INTO meeting_recording_epochs
      (recording_id, source, epoch_index, start_frame, sample_rate, channels, encoding, relative_path, frame_count)
      VALUES (?, 'system', 0, 12000, 24000, 1, 'opus', 'system/epoch-000000.opus', 2400)`)
      .run(recording.id);
    raw
      .prepare(`INSERT INTO meeting_recording_intentional_intervals
      (id, recording_id, source, start_frame, end_frame, reason) VALUES (?, ?, 'mic', 0, 14400, 'manual-muted')`)
      .run("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", recording.id);
  } finally {
    raw.close();
  }

  const reopened = new DatabaseManager();

  try {
    const epoch = reopened.listMeetingRecordingEpochs(recording.id)[0];
    assert.equal(epoch.sourceGeneration, null);
    assert.deepEqual(alignedAudioRanges(epoch).map(({ provenance, ...numeric }) => numeric), [
      { fileStartFrame: 0, frameCount: 2400, timelineStartFrame: 12000, rate: 1 },
    ]);
    assert.equal(reopened.listMeetingIntentionalIntervals(recording.id)[0].timelineEndFrame, 14400);
    reopened.createMeetingRecordingEpoch(recording.id, "mic", 0, 1, 0, null);
    reopened.addMeetingRecordingEpochAlignment(recording.id, "mic", 0, alignment(2400));
    assert.equal(
      reopened.listMeetingRecordingEpochs(recording.id).find((value) => value.source === "mic")
        ?.alignmentSegments.length,
      1
    );
    reopened.openMeetingIntentionalInterval(recording.id, "mic", 1, 2400, "manual-muted", null);
    assert.equal(reopened.getNote(note.id)?.content, "Keep note");
  } finally {
    reopened.close();
  }
});
