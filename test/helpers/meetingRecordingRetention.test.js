const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createDb } = require("./harness/db.js");
const { getUserDataDir } = require("./harness/electronStub.js");
const DatabaseManager = require("../../src/helpers/database.ts");
const MeetingRecordingStorage = require("../../src/helpers/meetingRecordingStorage.ts");
const IPCHandlers = require("../../src/helpers/ipcHandlers.ts");
const { DEFAULT_RETENTION_SETTINGS } = require("../../src/helpers/retentionSettings.ts");

const DAY = 86_400_000;
const config = { transcription: { mode: "providers", provider: "deepgram", model: "nova-3", language: "en" } };

function createFinishedRecording(db, storage, anchor, ageDays) {
  const note = db.saveNote("Retention test", "Manual note stays", "meeting").note;
  const startedAt = new Date(anchor - (ageDays + 1) * DAY).toISOString();
  const recording = db.createMeetingRecording(note.id, { config }, startedAt);
  db.createMeetingRecordingEpoch(recording.id, "mic", 0, 0);
  storage.openEpochWriter(recording.id, "mic", 0);
  storage.appendEpochSamples(recording.id, "mic", 0, Buffer.from([1, 2, 3, 4]));
  storage.closeEpochWriter(recording.id, "mic", 0);
  db.updateMeetingRecordingEpochRecovery(recording.id, "mic", 0, storage.recoverEpoch(recording.id, "mic", 0));
  db.markMeetingRecordingFinalizing(recording.id);
  const finalized = db.finalizeMeetingRecording(recording.id, {
    captureState: "ready",
    endedAt: new Date(anchor - ageDays * DAY).toISOString(),
  });
  assert.ok(finalized.initialRun, "finalizing a ready recording creates its first processing run");
  return { note, recording: finalized.recording, initialRun: finalized.initialRun };
}

function storeTranscript(db, storage, run, text) {
  storage.writeRunArtifact(run.id, "provider-response", { runId: run.id });
  assert.equal(db.setMeetingRunArtifact(run.id, "provider-response").success, true);
  storage.writeRunArtifact(run.id, "transcript", { text });
  assert.equal(db.setMeetingRunArtifact(run.id, "transcript").success, true);
}

function runCleanup(db, storage, settings, overrides = {}) {
  const context = {
    databaseManager: db,
    audioStorageManager: {
      meetingRecordings: storage,
      cleanupExpiredAudio: () => ({ deleted: 0, kept: 0 }),
      deleteAudio: () => ({ success: true }),
    },
    _retentionSettings: { ...DEFAULT_RETENTION_SETTINGS, ...settings },
    _meetingProcessing: { cancelRecordingForDeletion: async () => {} },
    _processMeetingDeletionIntents: IPCHandlers.prototype._processMeetingDeletionIntents,
    _finishMeetingDeletion: IPCHandlers.prototype._finishMeetingDeletion,
    ...overrides,
  };
  return IPCHandlers.prototype._runRetentionCleanup.call(context);
}

function withClock(t, timestamp) {
  const original = Date.now;
  Date.now = () => timestamp;
  t.after(() => { Date.now = original; });
}

test("default 7 days, saved 30 days, and 0-day retention behave independently", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const anchor = Date.parse("2026-09-25T00:00:00.000Z");
  withClock(t, anchor);

  assert.equal(DEFAULT_RETENTION_SETTINGS.audioRetentionDays, 7);
  const { recording: thirtyDayRecording, initialRun: thirtyDayRun } = createFinishedRecording(db, storage, anchor, 20);
  storeTranscript(db, storage, thirtyDayRun, "Saved transcript");
  assert.equal(await runCleanup(db, storage, { audioRetentionDays: 30, transcriptRetentionDays: 0 }), true);
  assert.equal(db.getMeetingRecording(thirtyDayRecording.id).audioState, "available");

  const { recording: sevenDayRecording, initialRun: sevenDayRun } = createFinishedRecording(db, storage, anchor, 8);
  storeTranscript(db, storage, sevenDayRun, "Transcript remains");
  assert.equal(await runCleanup(db, storage, { audioRetentionDays: 7, transcriptRetentionDays: 0 }), true);
  assert.equal(db.getMeetingRecording(sevenDayRecording.id).audioState, "deleted");
  assert.equal(db.getNote(db.getMeetingRecording(sevenDayRecording.id).noteId).content, "Manual note stays");
  assert.equal(db.getMeetingProcessingRun(sevenDayRun.id).hasTranscript, true);
  assert.deepEqual(storage.readRunArtifact(sevenDayRun.id, "provider-response"), { runId: sevenDayRun.id });
  assert.deepEqual(storage.readRunArtifact(sevenDayRun.id, "transcript"), { text: "Transcript remains" });

  const unlimitedRecording = createFinishedRecording(db, storage, anchor, 400).recording;
  assert.equal(await runCleanup(db, storage, { audioRetentionDays: 0, transcriptRetentionDays: 0 }), true);
  assert.equal(db.getMeetingRecording(unlimitedRecording.id).audioState, "available");
});

test("delete-all safely stops active capture, waits for processing, and removes only audio", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const root = getUserDataDir();
  const storage = new MeetingRecordingStorage({ userDataPath: root });
  const { note, recording, initialRun } = createFinishedRecording(db, storage, Date.now(), 1);
  storeTranscript(db, storage, initialRun, "Saved words");
  let safeStop = false;
  let waited = false;
  const context = {
    _meetingCoordinator: {
      isRecording: () => true,
      requestSafeStop: async (suppressProcessing) => {
        assert.equal(suppressProcessing, true);
        safeStop = true;
        return { success: true };
      },
    },
    audioStorageManager: {
      meetingRecordings: storage,
      deleteAllAudio: () => ({ deleted: 0, failed: 0 }),
    },
    databaseManager: db,
    _meetingProcessing: {
      cancelRecordingForDeletion: async (id) => {
        assert.equal(id, recording.id);
        waited = true;
      },
    },
    _finishMeetingDeletion: IPCHandlers.prototype._finishMeetingDeletion,
  };

  const result = await IPCHandlers.prototype._deleteAllAudio.call(context);
  assert.equal(safeStop, true);
  assert.equal(waited, true);
  assert.deepEqual(result, { deleted: 1, failed: 0 });
  assert.equal(db.getMeetingRecording(recording.id).audioState, "deleted");
  assert.equal(db.getNote(note.id).content, "Manual note stays");
  assert.deepEqual(storage.readRunArtifact(initialRun.id, "provider-response"), { runId: initialRun.id });
  assert.deepEqual(storage.readRunArtifact(initialRun.id, "transcript"), { text: "Saved words" });
});

test("note deletion waits for the active reader before removing its Note and run files", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const root = getUserDataDir();
  const storage = new MeetingRecordingStorage({ userDataPath: root });
  const { note, recording, initialRun } = createFinishedRecording(db, storage, Date.now(), 1);
  storeTranscript(db, storage, initialRun, "Saved words");
  const intent = db.beginMeetingNoteDeletion(note.id);
  assert.ok(intent, "note deletion must persist an intent before removing files");
  let releaseReader;
  let readerStarted;
  const readerWait = new Promise((resolve) => { readerStarted = resolve; });
  const release = new Promise((resolve) => { releaseReader = resolve; });
  const context = {
    databaseManager: db,
    audioStorageManager: { meetingRecordings: storage },
    _meetingProcessing: {
      cancelRecordingForDeletion: async (id, includeNonAudio) => {
        assert.equal(id, recording.id);
        assert.equal(includeNonAudio, true);
        readerStarted();
        await release;
      },
    },
    _asyncMirrorDelete: () => {},
  };

  const deletion = IPCHandlers.prototype._finishMeetingDeletion.call(context, intent);
  await readerWait;
  assert.ok(db.getNote(note.id), "note remains while an active processor is still settling");
  assert.deepEqual(storage.readRunArtifact(initialRun.id, "provider-response"), { runId: initialRun.id });
  assert.deepEqual(storage.readRunArtifact(initialRun.id, "transcript"), { text: "Saved words" });
  releaseReader();
  assert.equal(await deletion, true);
  assert.equal(db.getNote(note.id), null);
  assert.equal(db.getMeetingRecording(recording.id), null);
  assert.equal(storage.readRunArtifact(initialRun.id, "transcript"), null);
});

test("expiry uses recording end time and waits for readers before deleting source files", async (t) => {
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

  let releaseReader;
  let readerStarted;
  const readerWait = new Promise((resolve) => { readerStarted = resolve; });
  const release = new Promise((resolve) => { releaseReader = resolve; });
  const cleanup = runCleanup(db, storage, { audioRetentionDays: 7, transcriptRetentionDays: 0 }, {
    _meetingProcessing: {
      cancelRecordingForDeletion: async (id) => {
        assert.equal(id, recording.id);
        readerStarted();
        await release;
      },
    },
  });
  await readerWait;
  assert.equal(db.getMeetingRecording(recording.id).audioState, "deleting");
  assert.equal(fs.existsSync(filePath), true, "the open reader must settle before source removal");
  assert.ok(fs.statSync(filePath).mtimeMs >= anchor - 1);
  assert.equal(stat.size, 4);
  releaseReader();
  assert.equal(await cleanup, true);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(db.getMeetingRecording(recording.id).audioState, "deleted");
});

test("a deletion failure holds processing readiness and remains retryable", async (t) => {
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

  assert.equal(await runCleanup(db, storage, { audioRetentionDays: 7, transcriptRetentionDays: 0 }), false);
  assert.equal(db.getMeetingRecording(recording.id).audioState, "deleting");
  assert.equal(db.listMeetingDeletionIntents()[0].status, "failed");

  fs.rmSync(managedDir);
  assert.equal(await runCleanup(db, storage, { audioRetentionDays: 7, transcriptRetentionDays: 0 }), true);
  assert.equal(db.getMeetingRecording(recording.id).audioState, "deleted");
  assert.deepEqual(db.listMeetingDeletionIntents(), []);
});

test("reopened SQLite preserves a failed deletion intent for the next startup sweep", async (t) => {
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
  assert.equal(await runCleanup(db, storage, { audioRetentionDays: 7, transcriptRetentionDays: 0 }), false);
  const intentId = db.listMeetingDeletionIntents()[0].id;
  db.close();

  fs.rmSync(managedDir);
  const reopened = new DatabaseManager();
  try {
    const reopenedStorage = new MeetingRecordingStorage({ userDataPath: root });
    assert.equal(await runCleanup(reopened, reopenedStorage, { audioRetentionDays: 7, transcriptRetentionDays: 0 }), true);
    assert.equal(reopened.getMeetingRecording(recording.id).audioState, "deleted");
    assert.equal(reopened.listMeetingDeletionIntents().some((intent) => intent.id === intentId), false);
  } finally {
    reopened.close();
  }
});
