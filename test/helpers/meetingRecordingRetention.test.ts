const {
  savePcmEpoch,
}: typeof import("../lib/meetingAudioFixture.ts") = require("../lib/meetingAudioFixture.ts");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const path: typeof import("node:path") = require("node:path");

const test: typeof import("node:test") = require("node:test");

const { createDb } = require("./harness/db.ts");

const {
  getUserDataDir,
}: typeof import("./harness/electronStub.ts") = require("./harness/electronStub.ts");

const DatabaseManager: typeof import("../../src/helpers/database.ts").DatabaseManager = require("../../src/helpers/database.ts");

const MeetingRecordingStorage: typeof import("../../src/helpers/meetingRecordingStorage.ts").MeetingRecordingStorage = require("../../src/helpers/meetingRecordingStorage.ts");

const IPCHandlers: typeof import("../../src/helpers/ipcHandlers.ts").IPCHandlers = require("../../src/helpers/ipcHandlers.ts");

const {
  DEFAULT_RETENTION_SETTINGS,
}: typeof import("../../src/helpers/retentionSettings.ts") = require("../../src/helpers/retentionSettings.ts");

const {
  createMeetingAudioOperationRegistry,
}: typeof import("../../src/helpers/meetingAudioExport.ts") = require("../../src/helpers/meetingAudioExport.ts");

import type { DatabaseManager as Database } from "../../src/helpers/database.ts";
import type { MeetingRecordingStorage as RecordingStorage } from "../../src/helpers/meetingRecordingStorage.ts";
import type { RetentionSettings } from "../../src/helpers/retentionSettings.ts";

const DAY = 86_400_000;

const config = {
  transcription: { mode: "providers", provider: "deepgram", model: "nova-3", language: "en" },
};

function createFinishedRecording(
  db: Database,
  storage: RecordingStorage,
  anchor: number,
  ageDays: number
) {
  const note = db.saveNote("Retention test", "Manual note stays", "meeting").note;
  assert.ok(note);
  const startedAt = new Date(anchor - (ageDays + 1) * DAY).toISOString();
  const recording = db.createMeetingRecording(note.id, { config }, startedAt);
  db.createMeetingRecordingEpoch(recording.id, "mic", 0, 1, 0, 0);
  savePcmEpoch(storage, recording.id, "mic", 0, Buffer.from([1, 2, 3, 4]));
  db.updateMeetingRecordingEpochRecovery(
    recording.id,
    "mic",
    0,
    storage.recoverEpoch(recording.id, "mic", 0)
  );
  db.markMeetingRecordingFinalizing(recording.id);

  const finalized = db.finalizeMeetingRecording(recording.id, {
    captureState: "ready",
    endedAt: new Date(anchor - ageDays * DAY).toISOString(),
  });

  assert.ok(finalized.initialRun, "finalizing a ready recording creates its first processing run");

  return { note, recording: finalized.recording, initialRun: finalized.initialRun };
}

function storeTranscript(
  db: Database,
  storage: RecordingStorage,
  run: { id: string },
  text: string
) {
  storage.writeRunArtifact(run.id, "provider-response", { runId: run.id });
  assert.equal(db.setMeetingRunArtifact(run.id, "provider-response").success, true);
  storage.writeRunArtifact(run.id, "transcript", { text });
  assert.equal(db.setMeetingRunArtifact(run.id, "transcript").success, true);
}

function runCleanup(
  db: Database,
  storage: RecordingStorage,
  settings: Partial<RetentionSettings>,
  overrides = {}
) {
  const context = {
    databaseManager: db,
    audioStorageManager: {
      meetingRecordings: storage,
      cleanupExpiredAudio: () => ({ deleted: 0, kept: 0 }),
      deleteAudio: () => ({ success: true }),
    },
    _retentionSettings: { ...DEFAULT_RETENTION_SETTINGS, ...settings },
    _meetingProcessing: {
      cancelRecordingForDeletion: async () => {},
      cancelNoteForDeletion: async () => {},
    },
    _meetingAudioOperations: createMeetingAudioOperationRegistry(),
    _processMeetingDeletionIntents: IPCHandlers.prototype._processMeetingDeletionIntents,
    _finishMeetingDeletion: IPCHandlers.prototype._finishMeetingDeletion,
    ...overrides,
  };

  return IPCHandlers.prototype._runRetentionCleanup.call(context);
}

function holdAudioOperation(
  registry: ReturnType<typeof createMeetingAudioOperationRegistry>,
  recordingId: string
) {
  let start!: () => void;

  const started = new Promise<void>((resolve) => {
    start = resolve;
  });

  let closed = false;

  const operation = registry.run(
    recordingId,
    (signal) =>
      new Promise<void>((resolve) => {
        start();
        signal.addEventListener(
          "abort",
          () => {
            closed = true;
            resolve();
          },
          { once: true }
        );
      })
  );

  return { started, operation, isClosed: () => closed };
}

function withClock(t: import("node:test").TestContext, timestamp: number) {
  const original = Date.now;
  Date.now = () => timestamp;
  t.after(() => {
    Date.now = original;
  });
}

test("default 7 days, saved 30 days, and 0-day retention behave independently", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const anchor = Date.parse("2026-09-25T00:00:00.000Z");
  withClock(t, anchor);

  assert.equal(DEFAULT_RETENTION_SETTINGS.audioRetentionDays, 7);

  const { recording: thirtyDayRecording, initialRun: thirtyDayRun } = createFinishedRecording(
    db,
    storage,
    anchor,
    20
  );

  storeTranscript(db, storage, thirtyDayRun, "Saved transcript");
  assert.equal(
    await runCleanup(db, storage, { audioRetentionDays: 30, transcriptRetentionDays: 0 }),
    true
  );
  assert.equal(db.getMeetingRecording(thirtyDayRecording.id).audioState, "available");

  const { recording: sevenDayRecording, initialRun: sevenDayRun } = createFinishedRecording(
    db,
    storage,
    anchor,
    8
  );

  storeTranscript(db, storage, sevenDayRun, "Transcript remains");
  assert.equal(
    await runCleanup(db, storage, { audioRetentionDays: 7, transcriptRetentionDays: 0 }),
    true
  );
  assert.equal(db.getMeetingRecording(sevenDayRecording.id).audioState, "deleted");
  assert.equal(
    db.getNote(db.getMeetingRecording(sevenDayRecording.id).noteId).content,
    "Manual note stays"
  );
  assert.equal(db.getMeetingProcessingRun(sevenDayRun.id).hasTranscript, true);
  assert.deepEqual(storage.readRunArtifact(sevenDayRun.id, "provider-response"), {
    runId: sevenDayRun.id,
  });
  assert.deepEqual(storage.readRunArtifact(sevenDayRun.id, "transcript"), {
    text: "Transcript remains",
  });

  const unlimitedRecording = createFinishedRecording(db, storage, anchor, 400).recording;
  assert.equal(
    await runCleanup(db, storage, { audioRetentionDays: 0, transcriptRetentionDays: 0 }),
    true
  );
  assert.equal(db.getMeetingRecording(unlimitedRecording.id).audioState, "available");
});

test("delete-all safely stops active capture, waits for processing, and removes only audio", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const root = getUserDataDir();
  const storage = new MeetingRecordingStorage({ userDataPath: root });
  const { note, recording, initialRun } = createFinishedRecording(db, storage, Date.now(), 1);
  storeTranscript(db, storage, initialRun, "Saved words");
  const audioOperations = createMeetingAudioOperationRegistry();
  const audioRead = holdAudioOperation(audioOperations, recording.id);
  await audioRead.started;
  let safeStop = false;
  let waited = false;

  const context = {
    _meetingCoordinator: {
      isRecording: () => true,
      currentRecordingScope: () => ({ recordingId: recording.id, sessionId: "active" }),
      requestSafeStop: async (options: unknown) => {
        assert.deepEqual(options, {
          expected: { recordingId: recording.id, sessionId: "active" },
          reason: "delete-audio",
          suppressProcessing: true,
        });
        safeStop = true;

        return { success: true };
      },
    },
    audioStorageManager: {
      meetingRecordings: storage,
      deleteAllAudio: () => ({ deleted: 0, failed: 0 }),
    },
    databaseManager: db,
    _meetingAudioOperations: audioOperations,
    _meetingProcessing: {
      cancelRecordingForDeletion: async (id: unknown) => {
        assert.equal(id, recording.id);
        assert.equal(
          audioRead.isClosed(),
          true,
          "active audio operations close before processing/deletion proceeds"
        );
        waited = true;
      },
    },
    _finishMeetingDeletion: IPCHandlers.prototype._finishMeetingDeletion,
  };

  const result = await IPCHandlers.prototype._deleteAllAudio.call(context);
  assert.equal(safeStop, true);
  assert.equal(waited, true);
  await audioRead.operation;
  assert.deepEqual(result, { deleted: 1, failed: 0 });
  assert.equal(db.getMeetingRecording(recording.id).audioState, "deleted");
  assert.equal(db.getNote(note.id).content, "Manual note stays");
  assert.deepEqual(storage.readRunArtifact(initialRun.id, "provider-response"), {
    runId: initialRun.id,
  });
  assert.deepEqual(storage.readRunArtifact(initialRun.id, "transcript"), { text: "Saved words" });
});

test("note deletion waits for the active reader before removing its Note and run files", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const root = getUserDataDir();
  const storage = new MeetingRecordingStorage({ userDataPath: root });
  const { note, recording, initialRun } = createFinishedRecording(db, storage, Date.now(), 1);
  storeTranscript(db, storage, initialRun, "Saved words");
  const audioOperations = createMeetingAudioOperationRegistry();
  const audioRead = holdAudioOperation(audioOperations, recording.id);
  await audioRead.started;
  const intent = db.beginMeetingNoteDeletion(note.id);
  assert.ok(intent, "note deletion must persist an intent before removing files");
  let releaseReader!: () => void;
  let readerStarted!: () => void;

  const readerWait = new Promise<void>((resolve) => {
    readerStarted = resolve;
  });

  const release = new Promise<void>((resolve) => {
    releaseReader = resolve;
  });

  const context = {
    databaseManager: db,
    audioStorageManager: { meetingRecordings: storage },
    _meetingAudioOperations: audioOperations,
    _meetingProcessing: {
      cancelNoteForDeletion: async (id: unknown) => {
        assert.equal(id, note.id);
        assert.equal(
          audioRead.isClosed(),
          true,
          "audio operations must settle before Note cleanup proceeds"
        );
        readerStarted();
        await release;
      },
    },
    _asyncMirrorDelete: () => {},
  };

  const deletion = IPCHandlers.prototype._finishMeetingDeletion.call(context, intent);
  await readerWait;
  assert.ok(db.getNote(note.id), "note remains while an active processor is still settling");
  assert.deepEqual(storage.readRunArtifact(initialRun.id, "provider-response"), {
    runId: initialRun.id,
  });
  assert.deepEqual(storage.readRunArtifact(initialRun.id, "transcript"), { text: "Saved words" });
  releaseReader();
  assert.equal(await deletion, true);
  await audioRead.operation;
  assert.equal(db.getNote(note.id), null);
  assert.equal(db.getMeetingRecording(recording.id), null);
  assert.equal(storage.readRunArtifact(initialRun.id, "transcript"), null);
});

test("expiry uses recording end time and waits for readers before deleting source files", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const root = getUserDataDir();
  const storage = new MeetingRecordingStorage({ userDataPath: root });
  const anchor = Date.parse("2026-09-25T00:00:00.000Z");
  withClock(t, anchor);
  const { recording } = createFinishedRecording(db, storage, anchor, 10);
  const filePath = storage.getEpochFilePath(recording.id, "mic", 0);
  const stat = fs.statSync(filePath);
  fs.utimesSync(filePath, new Date(anchor), new Date(anchor));

  let releaseReader!: () => void;
  let readerStarted!: () => void;

  const readerWait = new Promise<void>((resolve) => {
    readerStarted = resolve;
  });

  const release = new Promise<void>((resolve) => {
    releaseReader = resolve;
  });

  const cleanup = runCleanup(
    db,
    storage,
    { audioRetentionDays: 7, transcriptRetentionDays: 0 },
    {
      _meetingProcessing: {
        cancelRecordingForDeletion: async (id: unknown) => {
          assert.equal(id, recording.id);
          readerStarted();
          await release;
        },
      },
    }
  );

  await readerWait;
  assert.equal(db.getMeetingRecording(recording.id).audioState, "deleting");
  assert.equal(fs.existsSync(filePath), true, "the open reader must settle before source removal");
  assert.ok(fs.statSync(filePath).mtimeMs >= anchor - 1);
  assert.ok(stat.size > 4);
  releaseReader();
  assert.equal(await cleanup, true);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(db.getMeetingRecording(recording.id).audioState, "deleted");
});

test("a deletion failure holds processing readiness and remains retryable", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const root = getUserDataDir();
  const storage = new MeetingRecordingStorage({ userDataPath: root });
  const anchor = Date.parse("2026-09-25T00:00:00.000Z");
  withClock(t, anchor);
  const { recording } = createFinishedRecording(db, storage, anchor, 20);
  const managedDir = path.join(root, "audio", "meetings", recording.id);
  fs.rmSync(managedDir, { recursive: true, force: true });
  fs.writeFileSync(managedDir, "not a directory");

  assert.equal(
    await runCleanup(db, storage, { audioRetentionDays: 7, transcriptRetentionDays: 0 }),
    false
  );
  assert.equal(db.getMeetingRecording(recording.id).audioState, "deleting");
  assert.equal(db.listMeetingDeletionIntents()[0].status, "failed");

  fs.rmSync(managedDir);
  assert.equal(
    await runCleanup(db, storage, { audioRetentionDays: 7, transcriptRetentionDays: 0 }),
    true
  );
  assert.equal(db.getMeetingRecording(recording.id).audioState, "deleted");
  assert.deepEqual(db.listMeetingDeletionIntents(), []);
});

test("reopened SQLite preserves a failed deletion intent for the next startup sweep", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const root = getUserDataDir();
  const storage = new MeetingRecordingStorage({ userDataPath: root });
  const anchor = Date.parse("2026-09-25T00:00:00.000Z");
  withClock(t, anchor);
  const { recording } = createFinishedRecording(db, storage, anchor, 30);
  const managedDir = path.join(root, "audio", "meetings", recording.id);
  fs.rmSync(managedDir, { recursive: true, force: true });
  fs.writeFileSync(managedDir, "not a directory");
  assert.equal(
    await runCleanup(db, storage, { audioRetentionDays: 7, transcriptRetentionDays: 0 }),
    false
  );
  const intentId = db.listMeetingDeletionIntents()[0].id;
  db.close();

  fs.rmSync(managedDir);
  const reopened = new DatabaseManager();

  try {
    const reopenedStorage = new MeetingRecordingStorage({ userDataPath: root });
    assert.equal(
      await runCleanup(reopened, reopenedStorage, {
        audioRetentionDays: 7,
        transcriptRetentionDays: 0,
      }),
      true
    );
    const reopenedRecording = reopened.getMeetingRecording(recording.id);
    assert.ok(reopenedRecording);
    assert.equal(reopenedRecording.audioState, "deleted");
    assert.equal(
      reopened.listMeetingDeletionIntents().some((intent) => intent.id === intentId),
      false
    );
  } finally {
    reopened.close();
  }
});

test("audio retention keeps platform names and observations; Note deletion removes them", async (t) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const anchor = Date.parse("2026-10-01T00:00:00Z");
  withClock(t, anchor);
  const { note, recording, initialRun } = createFinishedRecording(db, storage, anchor, 10);

  const {
    zoomSpeakerFixture,
  }: typeof import("../lib/zoomSpeakerFixture.ts") = require("../lib/zoomSpeakerFixture.ts");

  const fixture = zoomSpeakerFixture(recording.id);

  const observation = {
    ...fixture.observations[0],
    platform: "google-meet" as const,
    clockGeneration: fixture.anchors[0].clock.generation,
  };

  db.saveMeetingPlatformObservation(observation);
  assert.equal(
    db.setMeetingRunSpeakerCorrection(
      initialRun.id,
      "system:guest",
      null,
      "Guest",
      "platform",
      undefined,
      "google-meet"
    ).success,
    true
  );
  storeTranscript(db, storage, initialRun, "Saved words");
  await runCleanup(db, storage, {});
  assert.equal(db.getMeetingRecording(recording.id)?.audioState, "deleted");
  assert.deepEqual(db.listMeetingPlatformObservations(recording.id), [observation]);
  assert.equal(db.getMeetingRunSpeakerCorrections(initialRun.id)[0].platform, "google-meet");
  assert.equal(db.getNote(note.id)?.content, "Manual note stays");
  db.beginMeetingNoteDeletion(note.id);
  await runCleanup(db, storage, {}, { _asyncMirrorDelete: () => {} });
  assert.equal(db.getNote(note.id), null);
  assert.deepEqual(db.listMeetingPlatformObservations(recording.id), []);
  assert.deepEqual(db.getMeetingRunSpeakerCorrections(initialRun.id), []);
});
