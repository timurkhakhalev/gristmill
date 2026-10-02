const { savePcmEpoch }: typeof import("../lib/meetingAudioFixture.ts") = require("../lib/meetingAudioFixture.ts");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");
const { createDb } = require("./harness/db.ts");
const { getUserDataDir }: typeof import("./harness/electronStub.ts") = require("./harness/electronStub.ts");
const MeetingRecordingStorage: typeof import("../../src/helpers/meetingRecordingStorage.ts").MeetingRecordingStorage = require("../../src/helpers/meetingRecordingStorage.ts");
const DatabaseManager = require("../../src/helpers/database.ts");

const validConfig = {
  transcription: {
    mode: "providers",
    provider: "elevenlabs",
    model: "scribe_v2",
    language: "ru",
    vocabularyHints: ["Gristmill"],
    dictionaryHints: ["транскрипция"],
    credentialRef: "ELEVENLABS_API_KEY",
    apiKey: "must-not-be-stored",
  },
  summary: {
    actionId: "generate-notes",
    templateId: "default",
    instruction: "Create meeting notes from the transcript.",
    reasoningMode: "providers",
    provider: "openai",
    model: "gpt-4o-mini",
    credentialRef: "OPENAI_API_KEY",
    apiKey: "also-must-not-be-stored",
  },
  unknownTopLevel: "drop-me",
};

function saveMeetingNote(db: any, title = "Meeting") {
  return db.saveNote(title, "Manual note text", "meeting").note;
}

function createFinishedRecording(db: any, storage: any, note: any, config: typeof validConfig | null = validConfig) {
  const recording = db.createMeetingRecording(note.id, { config });
  db.createMeetingRecordingEpoch(recording.id, "mic", 0, 1, 0, 0);
  savePcmEpoch(storage, recording.id, "mic", 0, Buffer.from([1, 2, 3, 4]));
  const epoch = storage.recoverEpoch(recording.id, "mic", 0);
  db.updateMeetingRecordingEpochRecovery(recording.id, "mic", 0, epoch);
  db.markMeetingRecordingFinalizing(recording.id);
  const finalized = db.finalizeMeetingRecording(recording.id, {
    captureState: "ready",
    endedAt: new Date(Date.parse(recording.startedAt) + 1000).toISOString(),
  });
  return { recording: finalized.recording, initialRun: finalized.initialRun };
}

test("recording snapshots and initial run survive SQLite reopen without secrets or duplicate Stop", (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const root = getUserDataDir();
  const storage = new MeetingRecordingStorage({ userDataPath: root });
  const note = saveMeetingNote(db);
  const { recording, initialRun } = createFinishedRecording(db, storage, note);
  const serialized = JSON.stringify(recording.config);
  assert.equal(serialized.includes("must-not-be-stored"), false);
  assert.equal(serialized.includes("unknownTopLevel"), false);
  assert.equal(recording.config.transcription.apiKey, undefined);

  const duplicateStop = db.finalizeMeetingRecording(recording.id, {
    captureState: "ready",
    endedAt: recording.endedAt,
  });
  assert.equal(duplicateStop.initialRun.id, initialRun.id);
  assert.equal(db.listMeetingProcessingRuns(recording.id).length, 1);
  db.close();

  const reopened = new DatabaseManager();
  try {
    assert.equal(reopened.getMeetingRecording(recording.id).config.transcription.provider, "elevenlabs");
    assert.equal(reopened.listMeetingProcessingRuns(recording.id)[0].id, initialRun.id);
    assert.equal(reopened.getNote(note.id).content, "Manual note text");
  } finally {
    reopened.close();
  }
});

test("missing or invalid processing config records a blocked initial run but preserves capture", (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const note = saveMeetingNote(db);
  const missing = db.createMeetingRecording(note.id, { config: null, configError: { code: "unsupported-route" } });
  const invalid = db.createMeetingRecording(note.id, {
    config: {
      transcription: { mode: "providers", provider: "deepgram", model: "nova-3", language: "ru", credentialRef: "the-secret-itself" },
    },
  });
  for (const recording of [missing, invalid]) {
    db.createMeetingRecordingEpoch(recording.id, "system", 0, 1, 0, 0);
    db.updateMeetingRecordingEpochRecovery(recording.id, "system", 0, {
      frameCount: 1,
      ignoredTrailingBytes: 0,
    });
    db.markMeetingRecordingFinalizing(recording.id);
    const finalized = db.finalizeMeetingRecording(recording.id, {
      captureState: "ready",
      endedAt: recording.startedAt,
    });
    assert.equal(finalized.recording.captureState, "ready");
    assert.equal(finalized.recording.audioState, "available");
    assert.equal(finalized.initialRun.status, "blocked");
    if (recording.id === missing.id) {
      const resumed = db.updateBlockedMeetingRunConfig(finalized.initialRun.id, validConfig);
      assert.equal(resumed.id, finalized.initialRun.id);
      assert.equal(resumed.status, "pending");
      assert.equal(resumed.config.transcription.provider, "elevenlabs");
    }
  }
  assert.equal(missing.configError.code, "unsupported-route");
  assert.equal(invalid.config, null);
  assert.equal(invalid.configError.code, "invalid-config");
  db.close();
});

test("blocked config correction cannot change a route after its raw response is saved", (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const note = saveMeetingNote(db);
  const { recording, initialRun } = createFinishedRecording(db, storage, note, null);
  storage.writeRunArtifact(initialRun.id, "provider-response", { text: "response from saved route" });
  assert.equal(db.setMeetingRunArtifact(initialRun.id, "provider-response").success, true);
  assert.equal(db.setMeetingProcessingRunState(initialRun.id, {
    stage: "normalize",
    status: "blocked",
    errorCode: "local-diarization-unavailable",
  }).success, true);

  assert.equal(db.updateBlockedMeetingRunConfig(initialRun.id, validConfig), null);
  assert.equal(db.getMeetingProcessingRun(initialRun.id).config, null);
  assert.deepEqual(storage.readRunArtifact(initialRun.id, "provider-response"), { text: "response from saved route" });
  assert.equal(db.getMeetingRecording(recording.id).audioState, "available");
  db.close();
});

test("audio deletion blocks ASR retry but keeps text and summary; note deletion preserves shared speakers", (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const root = getUserDataDir();
  const storage = new MeetingRecordingStorage({ userDataPath: root });
  const note = saveMeetingNote(db, "Audio only");
  const { recording, initialRun } = createFinishedRecording(db, storage, note);
  storage.writeRunArtifact(initialRun.id, "provider-response", { raw: true });
  assert.equal(db.setMeetingRunArtifact(initialRun.id, "provider-response").success, true);
  storage.writeRunArtifact(initialRun.id, "transcript", { text: "Recognized words" });
  assert.equal(db.setMeetingRunArtifact(initialRun.id, "transcript").success, true);

  const audioIntent = db.beginMeetingAudioDeletion(recording.id);
  assert.equal(db.getMeetingRecording(recording.id).audioState, "deleting");
  assert.throws(() => db.createMeetingProcessingRun(recording.id, { kind: "reprocess", config: validConfig }));
  const audioCleanup = storage.recover(db);
  assert.deepEqual(audioCleanup.deleted, [audioIntent.id]);
  assert.equal(db.getMeetingRecording(recording.id).audioState, "deleted");
  assert.equal(fs.existsSync(path.join(root, "audio", "meetings", recording.id)), false);
  assert.deepEqual(storage.readRunArtifact(initialRun.id, "provider-response"), { raw: true });
  assert.deepEqual(storage.readRunArtifact(initialRun.id, "transcript"), { text: "Recognized words" });

  assert.throws(
    () => db.createMeetingProcessingRun(recording.id, { kind: "reprocess", config: validConfig }),
    /audio is unavailable/
  );
  assert.equal(db.getMeetingProcessingRun(initialRun.id).hasTranscript, true);

  const summaryRun = db.createMeetingProcessingRun(recording.id, {
    kind: "summary",
    sourceRunId: initialRun.id,
    config: validConfig,
  });
  assert.equal(summaryRun.status, "pending");

  const secondNote = saveMeetingNote(db, "Delete note");
  const second = createFinishedRecording(db, storage, secondNote);
  storage.writeRunArtifact(second.initialRun.id, "provider-response", { raw: "private" });
  db.setMeetingRunArtifact(second.initialRun.id, "provider-response");
  storage.writeRunArtifact(second.initialRun.id, "transcript", { text: "private transcript" });
  db.setMeetingRunArtifact(second.initialRun.id, "transcript");
  const profileId = Number(
    db.db.prepare("INSERT INTO speaker_profiles (display_name, embedding) VALUES (?, ?)").run("Shared voice", Buffer.from([1, 2])).lastInsertRowid
  );
  assert.equal(db.setMeetingRunSpeakerCorrection(second.initialRun.id, "speaker-1", profileId, "Shared voice").success, true);

  const noteIntent = db.beginMeetingNoteDeletion(secondNote.id);
  assert.equal(db.deleteNote(secondNote.id).success, false);
  const noteCleanup = storage.recover(db);
  assert.deepEqual(noteCleanup.deleted, [noteIntent.id]);
  assert.equal(db.getNote(secondNote.id), null);
  assert.equal(db.getMeetingRecording(second.recording.id), null);
  assert.equal(db.getMeetingProcessingRun(second.initialRun.id), null);
  assert.equal(db.db.prepare("SELECT display_name FROM speaker_profiles WHERE id = ?").get(profileId).display_name, "Shared voice");
  assert.deepEqual(storage.readRunArtifact(initialRun.id, "transcript"), { text: "Recognized words" });
  db.close();
});

test("failed file deletion keeps a durable intent and retries successfully after restart", (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const root = getUserDataDir();
  const storage = new MeetingRecordingStorage({ userDataPath: root });
  const note = saveMeetingNote(db);
  const { recording } = createFinishedRecording(db, storage, note);
  const audioDirectory = path.join(root, "audio", "meetings", recording.id);
  fs.rmSync(audioDirectory, { recursive: true, force: true });
  fs.writeFileSync(audioDirectory, "not a managed directory");
  const intent = db.beginMeetingAudioDeletion(recording.id);

  const failed = storage.recover(db);
  assert.deepEqual(failed.errors, [{ id: intent.id, code: "file-operation-failed" }]);
  assert.equal(db.getMeetingRecording(recording.id).audioState, "deleting");
  assert.equal(db.listMeetingDeletionIntents()[0].status, "failed");

  fs.rmSync(audioDirectory);
  db.close();
  const reopened = new DatabaseManager();
  try {
    const retried = new MeetingRecordingStorage({ userDataPath: root }).recover(reopened);
    assert.deepEqual(retried.deleted, [intent.id]);
    assert.equal(reopened.getMeetingRecording(recording.id).audioState, "deleted");
    assert.deepEqual(reopened.listMeetingDeletionIntents(), []);
  } finally {
    reopened.close();
  }
});
