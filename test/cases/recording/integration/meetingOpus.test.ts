const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const { createDb, DatabaseManager }: typeof import("../../../helpers/harness/db.ts") = require("../../../helpers/harness/db.ts");
const { getUserDataDir }: typeof import("../../../helpers/harness/electronStub.ts") = require("../../../helpers/harness/electronStub.ts");
const { MeetingRecordingStorage }: typeof import("../../../../src/helpers/meetingRecordingStorage.js") = require("../../../../src/helpers/meetingRecordingStorage.ts");
const { MeetingCaptureSession }: typeof import("../../../../src/helpers/meetingCaptureSession.js") = require("../../../../src/helpers/meetingCaptureSession.ts");
const { migrateMeetingAudio }: typeof import("../../../../src/helpers/meetingAudioMigration.js") = require("../../../../src/helpers/meetingAudioMigration.ts");
const { inspectMeetingOpus }: typeof import("../../../../src/helpers/meetingOpus.js") = require("../../../../src/helpers/meetingOpus.ts");
const { savePcmEpoch }: typeof import("../../../lib/meetingAudioFixture.js") = require("../../../lib/meetingAudioFixture.ts");
const { MeetingProcessingWorker }: typeof import("../../../../src/helpers/meetingProcessing.js") = require("../../../../src/helpers/meetingProcessing.ts");

test("live packets reach separate Opus files before Stop, then Stop flushes their exact duration", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const note = db.saveNote("Live encoding", "", "meeting").note!;
  const capture = MeetingCaptureSession.create(db, storage, note.id, null);
  t.after(() => storage.closeRecordingWriters(capture.recordingId));
  const packet = Buffer.alloc(4800);
  for (let i = 0; i < 2400; i++) packet.writeInt16LE(Math.round(8000 * Math.sin(i * Math.PI / 30)), i * 2);
  const started = performance.now();
  for (let sequence = 0; sequence < 22; sequence++) {
    for (const source of ["mic", "system"] as const) {
      capture.appendRendererSamples(source, {
        epochIndex: 0, epochSourceStartFrame: 0, sourceFrameStart: sequence * 2400,
        sourceGeneration: 1, alignment: null, alignmentErrorCode: "clock-unavailable", sequence, sampleOffset: sequence * 2400,
      }, packet);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const source of ["mic", "system"] as const) {
    assert.ok(storage.recoverEpoch(capture.recordingId, source, 0).frameCount > 0, "audio must reach disk during capture");
  }
  assert.equal((await capture.stop({ lastSequence: { mic: 21, system: 21 } })).captureState, "ready");
  for (const epoch of db.listMeetingRecordingEpochs(capture.recordingId)) {
    assert.equal(epoch.encoding, "opus");
    assert.equal(epoch.frameCount, 22 * 2400);
    assert.equal(epoch.state, "finalized");
    assert.ok(fs.statSync(storage.getEpochFilePath(capture.recordingId, epoch.source, 0)).size < epoch.frameCount * 2 / 5);
  }
  t.diagnostic(`Dual-track encoding + Stop: ${Math.round(performance.now() - started)}ms for 2200ms audio`);
});

test("resumed ASR rebuilds missing WAV inputs, reuses saved responses and removes WAV after speaker recognition", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const note = db.saveNote("Resume", "Manual notes", "meeting").note!;
  const config = { transcription: { mode: "providers", provider: "elevenlabs", model: "scribe_v2", language: "en" } } as const;
  const startedAt = "2026-09-30T10:00:00.000Z";
  const recording = db.createMeetingRecording(note.id, { config }, startedAt);
  const originals: Buffer[] = [];
  for (const source of ["mic", "system"] as const) {
    db.createMeetingRecordingEpoch(recording.id, source, 0, 1, 0, 0);
    savePcmEpoch(storage, recording.id, source, 0, Buffer.alloc(48000, 1));
    db.updateMeetingRecordingEpochRecovery(recording.id, source, 0, storage.recoverEpoch(recording.id, source, 0));
    originals.push(fs.readFileSync(storage.getEpochFilePath(recording.id, source, 0)));
  }
  const run = db.finalizeMeetingRecording(recording.id, {
    captureState: "ready", endedAt: "2026-09-30T10:00:01.000Z", processingNotBefore: new Date(0).toISOString(),
  }).initialRun;
  storage.writeRunArtifact(run.id, "provider-response-mic", { text: "", words: [] });
  db.setMeetingProcessingRunState(run.id, { stage: "asr", status: "pending", retryAt: null });
  let requests = 0;
  let recognition = false;
  const worker = new MeetingProcessingWorker({
    database: db, storage, isCaptureActive: () => false, getCredential: () => "test-key",
    transcribeRemote: async (request, saveRaw) => {
      requests++;
      assert.ok(request.filePath.endsWith("-system.wav"));
      assert.equal(fs.readFileSync(request.filePath).toString("ascii", 0, 4), "RIFF");
      await saveRaw({ text: "Hello", words: [{ type: "word", text: "Hello", start: 0.1, end: 0.5, speaker_id: "speaker_0" }] });
      return { success: true };
    },
    transcribeLocal: async () => ({ success: false }), diarizeLocal: async () => [], summarize: async () => "",
    recognizeSpeakers: async (_recording, _run, _transcript, audioPath) => {
      recognition = true;
      assert.ok(fs.existsSync(audioPath), "speaker recognition must finish before audio cleanup");
      return [];
    },
  });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(requests, 1, "the saved microphone response must not be billed again");
  assert.equal(recognition, true);
  assert.equal(db.getMeetingProcessingRun(run.id)!.hasTranscript, true);
  assert.deepEqual(fs.readdirSync(path.join(storage.recordingsRoot, recording.id, "derived")), []);
  for (const [index, source] of (["mic", "system"] as const).entries()) {
    assert.deepEqual(fs.readFileSync(storage.getEpochFilePath(recording.id, source, 0)), originals[index]);
  }
  fs.writeFileSync(storage.getDerivedAudioPath(recording.id, run.id), "abandoned WAV");
  storage.recover(db);
  assert.equal(fs.existsSync(path.join(storage.recordingsRoot, recording.id, "derived")), false);
  assert.ok(storage.hasRunArtifact(run.id, "provider-response"));
});

test("migration resumes after a failed cutover and preserves notes, results and backed-up PCM", (t) => {
  const db = createDb(t);
  if (!db) return;
  const root = getUserDataDir();
  const storage = new MeetingRecordingStorage({ userDataPath: root });
  const note = db.saveNote("Migration", "Manual notes", "meeting").note!;
  const blank = db.saveNote("Blank note", "", "meeting").note!;
  const recording = db.createMeetingRecording(note.id, { config: null });
  const run = db.finalizeMeetingRecording(recording.id, { captureState: "incomplete", endedAt: recording.startedAt }).initialRun;
  const artifact = storage.writeRunArtifact(run.id, "provider-response", { saved: "provider output" });
  db.setMeetingRunArtifact(run.id, "provider-response");
  const artifactBytes = fs.readFileSync(artifact);
  const schema = db.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'meeting_recording_epochs'").get() as { sql: string };
  db.db.exec("DROP TABLE meeting_recording_epochs");
  db.db.exec(schema.sql
    .replace(/ {10}(source_start_frame|source_generation|alignment_error_code)[^\n]*\n/g, "")
    .replace(/timeline_start_frame INTEGER[^,]*,/, "start_frame INTEGER NOT NULL CHECK(start_frame >= 0),")
    .replace("'opus'", "'pcm_s16le'").replace("ignored_trailing_bytes >= 0", "ignored_trailing_bytes BETWEEN 0 AND 1"));
  const original = path.join(storage.createRecordingDirectory(recording.id), "mic", "epoch-000000.pcm");
  fs.mkdirSync(path.dirname(original), { recursive: true });
  const pcm = Buffer.alloc(96000, 7);
  fs.writeFileSync(original, pcm);
  db.db.prepare("INSERT INTO meeting_recording_epochs (recording_id, source, epoch_index, start_frame, sample_rate, channels, encoding, relative_path, state, frame_count) VALUES (?, 'mic', 0, 0, 24000, 1, 'pcm_s16le', 'mic/epoch-000000.pcm', 'finalized', 48000)").run(recording.id);
  const sql = db.db;
  assert.throws(() => migrateMeetingAudio({
    pragma: sql.pragma.bind(sql), exec: sql.exec.bind(sql), prepare: sql.prepare.bind(sql), close: sql.close.bind(sql),
    transaction: () => () => { throw new Error("injected cutover failure"); },
  }, root), /injected cutover failure/);
  assert.deepEqual(fs.readFileSync(original), pcm);
  const destination = original.replace(/\.pcm$/, ".opus");
  assert.equal(inspectMeetingOpus(destination).frameCount, 48000);
  const encodedTime = fs.statSync(destination).mtimeMs;
  db.close();
  const reopened = new DatabaseManager();
  try {
    assert.equal(reopened.listMeetingRecordingEpochs(recording.id)[0].encoding, "opus");
    assert.equal(fs.statSync(destination).mtimeMs, encodedTime, "restart reuses validated converted audio");
    assert.equal(fs.existsSync(original), false);
    assert.deepEqual(fs.readFileSync(path.join(root, "meeting-audio-before-opus", recording.id, "mic", "epoch-000000.pcm")), pcm);
    assert.equal(reopened.getNote(note.id)!.content, "Manual notes");
    assert.equal(reopened.getNote(blank.id)!.content, "");
    assert.equal(reopened.getMeetingProcessingRun(run.id)!.hasRawProviderResponse, true);
    assert.deepEqual(fs.readFileSync(artifact), artifactBytes);
    const saved = path.join(root, "meeting-audio-before-opus", recording.id, "mic", "epoch-000000.pcm");
    fs.linkSync(saved, original); // Simulate interruption immediately after the SQL commit.
    migrateMeetingAudio(reopened.db, root);
    assert.equal(fs.existsSync(original), false);
    assert.equal(fs.statSync(destination).mtimeMs, encodedTime);
  } finally { reopened.close(); }
});
