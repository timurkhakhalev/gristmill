const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs = require("node:fs");

const path: typeof import("node:path") = require("node:path");

const test: typeof import("node:test") = require("node:test");

const { createDb } = require("./harness/db.ts");

const {
  getUserDataDir,
}: typeof import("./harness/electronStub.ts") = require("./harness/electronStub.ts");

const MeetingRecordingStorage = require("../../src/helpers/meetingRecordingStorage.ts");

const DatabaseManager = require("../../src/helpers/database.ts");

const config = {
  transcription: {
    mode: "providers",
    provider: "deepgram",
    model: "nova-3",
    language: "ru",
    credentialRef: "DEEPGRAM_API_KEY",
  },
};

function createRecording(db: any) {
  const note = db.saveNote("Meeting", "", "meeting").note;

  return db.createMeetingRecording(note.id, { config });
}

test("recording epochs append complete Opus pages through short writes", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const root = getUserDataDir();
  const recording = createRecording(db);
  db.createMeetingRecordingEpoch(recording.id, "mic", 0, 1, 0, 0);
  let writes = 0;

  const storage = new MeetingRecordingStorage({
    userDataPath: root,
    writeSync(fd: number, buffer: unknown, offset: number, length: number, position: number) {
      writes += 1;

      return fs.writeSync(fd, buffer, offset, Math.min(length, 1), position);
    },
  });

  storage.openEpochWriter(recording.id, "mic", 0);
  storage.appendEpochSamples(recording.id, "mic", 0, Buffer.from([1, 2, 3, 4]));
  await storage.closeEpochWriter(recording.id, "mic", 0);

  assert.ok(writes > 4);
  assert.deepEqual(storage.recoverEpoch(recording.id, "mic", 0), {
    frameCount: 2,
    ignoredTrailingBytes: 0,
    errorCode: null,
  });
  assert.throws(() => storage.appendEpochSamples(recording.id, "mic", 0, Buffer.from([5])));
  db.close();
});

test("write failure leaves a partial Ogg page that recovery ignores without rewriting original audio", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const root = getUserDataDir();
  const recording = createRecording(db);
  db.createMeetingRecordingEpoch(recording.id, "mic", 0, 1, 0, 0);
  let calls = 0;

  const storage = new MeetingRecordingStorage({
    userDataPath: root,
    writeSync(fd: number, buffer: unknown, offset: number, length: number, position: number) {
      calls += 1;

      if (calls > 1) throw new Error("disk full");

      return fs.writeSync(fd, buffer, offset, Math.min(length, 1), position);
    },
  });

  storage.openEpochWriter(recording.id, "mic", 0);
  storage.appendEpochSamples(recording.id, "mic", 0, Buffer.from([9, 8, 7, 6]));
  await assert.rejects(storage.closeEpochWriter(recording.id, "mic", 0), /encoder failed/);
  const filePath = path.join(root, "audio", "meetings", recording.id, "mic", "epoch-000000.opus");
  const originalBytes = fs.readFileSync(filePath);

  const recovered = storage.recoverEpoch(recording.id, "mic", 0);
  assert.deepEqual(recovered, { frameCount: 0, ignoredTrailingBytes: 1, errorCode: "empty-epoch" });
  assert.deepEqual(fs.readFileSync(filePath), originalBytes);
  db.close();
});

test("recovery finalizes both source epochs, keeps timeline gaps, and creates one initial run", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const root = getUserDataDir();
  const recording = createRecording(db);
  db.createMeetingRecordingEpoch(recording.id, "mic", 0, 1, 0, 0);
  db.createMeetingRecordingEpoch(recording.id, "mic", 1, 1, 8, 8);
  db.createMeetingRecordingEpoch(recording.id, "system", 0, 1, 0, 0);
  const storage = new MeetingRecordingStorage({ userDataPath: root });
  storage.openEpochWriter(recording.id, "mic", 0);
  storage.appendEpochSamples(recording.id, "mic", 0, Buffer.from([1, 2, 3, 4]));
  storage.openEpochWriter(recording.id, "mic", 1);
  storage.appendEpochSamples(recording.id, "mic", 1, Buffer.from([4, 5, 6, 7]));
  storage.openEpochWriter(recording.id, "system", 0);
  storage.appendEpochSamples(recording.id, "system", 0, Buffer.from([8, 9, 10, 11]));

  await storage.closeRecordingWriters(recording.id);
  const recovered = storage.recover(db);
  const saved = db.getMeetingRecording(recording.id);
  const runs = db.listMeetingProcessingRuns(recording.id);

  assert.equal(saved.captureState, "incomplete");
  assert.equal(saved.audioState, "available");
  assert.equal(recovered.finalized[0], recording.id);
  assert.deepEqual(
    runs.map((run: any) => run.kind),
    ["initial"]
  );
  assert.equal(runs[0].status, "pending");
  assert.equal(runs[0].config.transcription.provider, "deepgram");
  assert.deepEqual(
    db
      .listMeetingRecordingEpochs(recording.id)
      .map(
        ({
          source,
          epochIndex,
          timelineStartFrame,
          frameCount,
          ignoredTrailingBytes,
        }: import("../../src/contracts/meetingRecording.ts").MeetingRecordingEpochDto) => ({
          sourceGeneration: null,
          sourceStartFrame: null,
          alignmentSegments: [],
          alignmentErrorCode: null,
          source,
          epochIndex,
          timelineStartFrame,
          frameCount,
          ignoredTrailingBytes,
        })
      ),
    [
      {
        sourceGeneration: null,
        sourceStartFrame: null,
        alignmentSegments: [],
        alignmentErrorCode: null,
        source: "mic",
        epochIndex: 0,
        timelineStartFrame: 0,
        frameCount: 2,
        ignoredTrailingBytes: 0,
      },
      {
        sourceGeneration: null,
        sourceStartFrame: null,
        alignmentSegments: [],
        alignmentErrorCode: null,
        source: "system",
        epochIndex: 0,
        timelineStartFrame: 0,
        frameCount: 2,
        ignoredTrailingBytes: 0,
      },
      {
        sourceGeneration: null,
        sourceStartFrame: null,
        alignmentSegments: [],
        alignmentErrorCode: null,
        source: "mic",
        epochIndex: 1,
        timelineStartFrame: 8,
        frameCount: 2,
        ignoredTrailingBytes: 0,
      },
    ]
  );

  const bytesBeforeSecondRecovery = fs.statSync(
    path.join(root, "audio", "meetings", recording.id, "mic", "epoch-000000.opus")
  ).size;

  storage.recover(db);

  const repeated = db.finalizeMeetingRecording(recording.id, {
    captureState: "incomplete",
    endedAt: saved.endedAt,
  });

  assert.equal(db.listMeetingProcessingRuns(recording.id).length, 1);
  assert.equal(repeated.initialRun.id, runs[0].id);
  assert.equal(
    fs.statSync(path.join(root, "audio", "meetings", recording.id, "mic", "epoch-000000.opus"))
      .size,
    bytesBeforeSecondRecovery
  );
  db.close();
});

test("run JSON recovers after rename and a failed replacement keeps the last valid result", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const root = getUserDataDir();
  const recording = createRecording(db);
  const storage = new MeetingRecordingStorage({ userDataPath: root });

  const run = db.finalizeMeetingRecording(recording.id, {
    captureState: "incomplete",
    endedAt: recording.startedAt,
    errorCode: "recording-audio-unavailable",
  }).initialRun;

  const destination = storage.writeRunArtifact(run.id, "provider-response", {
    transcript: "saved",
  });

  assert.equal(path.relative(path.join(root, "audio"), destination).startsWith(".."), true);
  db.close();
  const reopened = new DatabaseManager();

  try {
    storage.recover(reopened);
    assert.equal(reopened.getMeetingProcessingRun(run.id).hasRawProviderResponse, true);
    assert.deepEqual(storage.readRunArtifact(run.id, "provider-response"), { transcript: "saved" });
    assert.throws(() =>
      storage.writeRunArtifact(run.id, "provider-response", { transcript: "new" })
    );

    const transcriptPath = storage.writeRunArtifact(run.id, "transcript", {
      text: "saved transcript",
    });

    assert.equal(reopened.setMeetingRunArtifact(run.id, "transcript").success, true);
    const oldBytes = fs.readFileSync(transcriptPath);

    const failingStorage = new MeetingRecordingStorage({
      userDataPath: root,
      writeSync() {
        throw new Error("disk full");
      },
    });

    assert.throws(() =>
      failingStorage.writeRunArtifact(run.id, "transcript", { text: "new transcript" })
    );
    assert.deepEqual(fs.readFileSync(transcriptPath), oldBytes);
    assert.deepEqual(storage.readRunArtifact(run.id, "provider-response"), { transcript: "saved" });
    assert.deepEqual(storage.readRunArtifact(run.id, "transcript"), { text: "saved transcript" });
    assert.throws(() => storage.createRecordingDirectory("../outside"));
  } finally {
    reopened.close();
  }
});
