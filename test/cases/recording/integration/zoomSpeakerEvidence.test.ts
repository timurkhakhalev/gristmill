import type { MeetingAudioClockAnchor, ZoomSpeakerObservation, ZoomSpeakerDecision } from "../../../../src/contracts/meetingRecording.js";
const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { randomUUID }: typeof import("node:crypto") = require("node:crypto");
const { createDb, DatabaseManager }: typeof import("../../../helpers/harness/db.ts") = require("../../../helpers/harness/db.ts");
const { ZoomSpeakerCollector }: typeof import("../../../../src/helpers/zoomSpeakerCollector.ts") = require("../../../../src/helpers/zoomSpeakerCollector.ts");

function evidence(recordingId: string) {
  const observation: ZoomSpeakerObservation = { id: randomUUID(), recordingId, sessionId: randomUUID(), instanceKey: "fixture-tile", nameRevision: 1, episodeId: randomUUID(), displayName: "Synthetic Guest", windowMode: "full", activity: "explicit", readStartHostNs: "1000000000", readEndHostNs: "1010000000", self: "remote", singleSpeaker: true, provenance: "zoom-only", reason: null };
  const anchor: MeetingAudioClockAnchor = { id: randomUUID(), recordingId, epochIndex: 0, epochStartFrame: 0, clock: { type: "clock", generation: randomUUID(), startFrame: 0, endFrame: 48_000, hostStartNs: "0", hostEndNs: "2000000000", timebaseNumer: 1, timebaseDenom: 1, conversion: "uncalibrated", reason: null } };
  const calibration = { measurementId: "synthetic-only", indicatorDelayMinSeconds: 0, indicatorDelayMaxSeconds: 0, conversionErrorSeconds: 0, minimumEpisodeSeconds: 0.5, minimumIndependentEpisodes: 1 };
  const decision: ZoomSpeakerDecision = { speakerId: "system:fixture", displayName: observation.displayName, status: "accepted", reason: "validated-evidence", observationIds: [observation.id], clockAnchorIds: [anchor.id], intervals: [{ start: 1, end: 1.01 }], measurementId: calibration.measurementId, calibration };
  return { observation, anchor, decision };
}
function finished(db: InstanceType<typeof DatabaseManager>) {
  const note = db.saveNote("Synthetic Zoom", "", "meeting").note!;
  const recording = db.createMeetingRecording(note.id, { config: { transcription: { mode: "providers", provider: "elevenlabs", model: "scribe_v2", language: "en" } } }, "2026-09-30T10:00:00.000Z");
  for (const source of ["mic", "system"] as const) {
    db.createMeetingRecordingEpoch(recording.id, source, 0, 0);
    db.updateMeetingRecordingEpochRecovery(recording.id, source, 0, { frameCount: 48_000, ignoredTrailingBytes: 0 });
  }
  db.markMeetingRecordingFinalizing(recording.id);
  const { initialRun } = db.finalizeMeetingRecording(recording.id, { captureState: "ready", endedAt: "2026-09-30T10:00:02.000Z", processingNotBefore: "2026-09-30T10:00:02.000Z" });
  assert.equal(db.claimMeetingProcessingRun(initialRun.id, "2026-09-30T10:00:03.000Z"), true);
  return { note, recording, runId: initialRun.id };
}

test("evidence, atomic decisions and platform corrections survive reopen; stale/manual/voice guards win", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { recording, runId } = finished(db);
  const { observation, anchor, decision } = evidence(recording.id);
  db.saveMeetingZoomObservation(observation);
  db.saveMeetingAudioClockAnchor(anchor);
  db.setMeetingPlatformCoverage(recording.id, { reads: 30, samples: 1, state: "complete", reason: null });
  assert.equal(db.applyMeetingPlatformDecisions(runId, 0, [decision, { ...decision }]), true);
  assert.equal(db.getMeetingRunSpeakerCorrections(runId)[0].source, "platform");
  assert.equal(db.getMeetingRunSpeakerCorrectionRevision(runId), 1);
  assert.equal(db.applyMeetingPlatformDecisions(runId, 1, [decision]), true);
  assert.equal(db.getMeetingRunSpeakerCorrectionRevision(runId), 1);
  assert.equal(db.applyAutomaticMeetingSpeakerCorrections(runId, runId, 1, [{ speakerId: "system:fixture", profileId: null, displayName: "Model" }], "model"), false);
  assert.equal(db.applyAutomaticMeetingSpeakerCorrections(runId, runId, 1, [{ speakerId: "system:fixture", profileId: null, displayName: "Voice" }], "voice"), true);
  assert.equal(db.applyMeetingPlatformDecisions(runId, 2, [decision]), true);
  assert.equal(db.getMeetingRunPlatformDecisions(runId)[0].reason, "voice-precedence");
  db.setMeetingRunSpeakerCorrection(runId, "system:fixture", null, "Manual");
  assert.equal(db.applyMeetingPlatformDecisions(runId, 2, [decision]), false);
  assert.equal(db.applyMeetingPlatformDecisions(runId, 3, [decision]), true);
  assert.equal(db.getMeetingRunPlatformDecisions(runId)[0].reason, "user-precedence");
  db.close();
  const reopened = new DatabaseManager();
  t.after(() => reopened.close());
  assert.equal(reopened.listMeetingZoomObservations(recording.id)[0].displayName, "Synthetic Guest");
  assert.equal(reopened.listMeetingAudioClockAnchors(recording.id).length, 1);
  assert.equal(reopened.getMeetingRunSpeakerCorrections(runId)[0].displayName, "Manual");
  assert.equal(reopened.getMeetingPlatformCoverage(recording.id)?.state, "complete");
});

test("old CHECK migration preserves source/revision and cascade deletes recording evidence", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { recording, runId } = finished(db);
  db.setMeetingRunSpeakerCorrection(runId, "system:fixture", null, "Original", "user");
  const sql = db.db!;
  sql.exec(`CREATE TABLE old_corrections (
    run_id TEXT NOT NULL REFERENCES meeting_processing_runs(id) ON DELETE CASCADE,
    speaker_id TEXT NOT NULL, profile_id INTEGER REFERENCES speaker_profiles(id) ON DELETE SET NULL,
    display_name TEXT NOT NULL, participant_email TEXT,
    source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('voice','model','user')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0), PRIMARY KEY(run_id,speaker_id));
    INSERT INTO old_corrections SELECT * FROM meeting_run_speaker_corrections;
    DROP TABLE meeting_run_speaker_corrections;
    ALTER TABLE old_corrections RENAME TO meeting_run_speaker_corrections;`);
  db.close();
  const reopened = new DatabaseManager();
  t.after(() => reopened.close());
  assert.equal(reopened.getMeetingRunSpeakerCorrections(runId)[0].revision, 1);
  assert.equal(reopened.setMeetingRunSpeakerCorrection(runId, "system:second", null, "Zoom", "platform").success, true);
  const { observation, anchor } = evidence(recording.id);
  reopened.saveMeetingZoomObservation(observation);
  reopened.saveMeetingAudioClockAnchor(anchor);
  reopened.setMeetingPlatformCoverage(recording.id, { reads: 1, samples: 1, state: "collecting", reason: null });
  reopened.recoverMeetingPlatformCoverage();
  assert.equal(reopened.getMeetingPlatformCoverage(recording.id)?.reason, "app-restarted");
  reopened.db!.prepare("DELETE FROM meeting_recordings WHERE id = ?").run(recording.id);
  assert.deepEqual(reopened.listMeetingZoomObservations(recording.id), []);
  assert.deepEqual(reopened.listMeetingAudioClockAnchors(recording.id), []);
  assert.equal(reopened.getMeetingPlatformCoverage(recording.id), null);
  assert.deepEqual(reopened.getMeetingRunPlatformDecisions(runId), []);
});

test("clock ranges bind by generation/frame count despite delivery reorder; SQLite failure cannot fail capture", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const { recording } = finished(db);
  const { anchor } = evidence(recording.id);
  const collector = new ZoomSpeakerCollector(recording.id, db);
  collector.recordClock(anchor.clock);
  collector.bindClock(anchor.clock.generation, 0, 0);
  assert.equal(db.listMeetingAudioClockAnchors(recording.id).length, 0);
  collector.recordDeliveredFrames(anchor.clock.generation, 48_000);
  await collector.stop();
  assert.equal(db.listMeetingAudioClockAnchors(recording.id)[0].clock.endFrame, 48_000);
  const failed = new ZoomSpeakerCollector(recording.id, { ...db,
    saveMeetingZoomObservation: () => { throw new Error("disk"); },
    saveMeetingAudioClockAnchor: () => { throw new Error("disk"); },
    setMeetingPlatformCoverage: (id, coverage) => db.setMeetingPlatformCoverage(id, coverage),
  });
  failed.bindClock(anchor.clock.generation, 0, 0);
  failed.recordDeliveredFrames(anchor.clock.generation, 48_000);
  failed.recordClock(anchor.clock);
  await failed.stop();
  assert.equal(db.getMeetingPlatformCoverage(recording.id)?.reason, "metadata-write-failed");
  assert.equal(db.getMeetingRecording(recording.id)?.captureState, "ready");
  assert.equal(db.getMeetingRecording(recording.id)?.audioState, "available");
  assert.equal(db.listMeetingRecordingEpochs(recording.id).length, 2);
});

test("missing tail, old helper generations and metadata queue overflow leave both audio sources ready", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const { recording } = finished(db);
  const { anchor } = evidence(recording.id);
  const collector = new ZoomSpeakerCollector(recording.id, db);
  collector.bindClock(randomUUID(), 1, 48_000);
  collector.recordClock(anchor.clock);
  await collector.stop();
  assert.equal(db.getMeetingPlatformCoverage(recording.id)?.reason, "metadata-tail-incomplete");
  assert.deepEqual(db.listMeetingAudioClockAnchors(recording.id), []);
  const overflow = new ZoomSpeakerCollector(recording.id, db);
  for (let i = 0; i < 129; i++) overflow.recordClock(anchor.clock);
  await overflow.stop();
  assert.equal(db.getMeetingPlatformCoverage(recording.id)?.reason, "clock-queue-overflow");
  assert.equal(db.getMeetingRecording(recording.id)?.captureState, "ready");
  assert.deepEqual(db.listMeetingRecordingEpochs(recording.id).map((item) => item.source).sort(), ["mic", "system"]);
});

test("failed evidence transaction saves neither accepted name nor decisions and cancellation is stale", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { recording, runId } = finished(db);
  const { observation, anchor, decision } = evidence(recording.id);
  db.saveMeetingZoomObservation(observation);
  db.saveMeetingAudioClockAnchor(anchor);
  db.db.exec("CREATE TRIGGER reject_platform_decisions BEFORE INSERT ON meeting_run_platform_decisions BEGIN SELECT RAISE(ABORT, 'fixture disk failure'); END;");
  assert.throws(() => db.applyMeetingPlatformDecisions(runId, 0, [decision]), /fixture disk failure/);
  assert.deepEqual(db.getMeetingRunSpeakerCorrections(runId), []);
  assert.deepEqual(db.getMeetingRunPlatformDecisions(runId), []);
  db.db.exec("DROP TRIGGER reject_platform_decisions");
  db.setMeetingProcessingRunState(runId, { stage: "normalize", status: "cancelled" });
  assert.equal(db.applyMeetingPlatformDecisions(runId, 0, [decision]), false);
  assert.equal(db.getMeetingRecording(recording.id)?.audioState, "available");
});

test("metadata failure preserves the original mic/system files, not just recording state", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const fs: typeof import("node:fs") = require("node:fs");
  const { getUserDataDir }: typeof import("../../../helpers/harness/electronStub.ts") = require("../../../helpers/harness/electronStub.ts");
  const { savePcmEpoch }: typeof import("../../../lib/meetingAudioFixture.ts") = require("../../../lib/meetingAudioFixture.ts");
  const { MeetingRecordingStorage }: typeof import("../../../../src/helpers/meetingRecordingStorage.ts") = require("../../../../src/helpers/meetingRecordingStorage.ts");
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const note = db.saveNote("Raw safety fixture", "", "meeting").note!;
  const recording = db.createMeetingRecording(note.id, { config: null });
  const paths: string[] = [];
  for (const source of ["mic", "system"] as const) {
    db.createMeetingRecordingEpoch(recording.id, source, 0, 0);
    savePcmEpoch(storage, recording.id, source, 0, Buffer.alloc(4_800, 1));
    db.updateMeetingRecordingEpochRecovery(recording.id, source, 0, storage.recoverEpoch(recording.id, source, 0));
    paths.push(storage.getEpochFilePath(recording.id, source, 0));
  }
  const originals = paths.map((file) => fs.readFileSync(file));
  const collector = new ZoomSpeakerCollector(recording.id, db);
  collector.invalidate("accessibility-revoked");
  await collector.stop();
  db.markMeetingRecordingFinalizing(recording.id);
  const final = db.finalizeMeetingRecording(recording.id, { captureState: "ready", endedAt: new Date(Date.parse(recording.startedAt) + 100).toISOString() });
  assert.equal(final.recording.captureState, "ready");
  for (let index = 0; index < paths.length; index++) assert.deepEqual(fs.readFileSync(paths[index]), originals[index]);
});
