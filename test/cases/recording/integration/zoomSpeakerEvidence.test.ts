const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { randomUUID }: typeof import("node:crypto") = require("node:crypto");
const { createDb, DatabaseManager }: typeof import("../../../helpers/harness/db.ts") = require("../../../helpers/harness/db.ts");
const { ZoomSpeakerCollector }: typeof import("../../../../src/helpers/zoomSpeakerCollector.ts") = require("../../../../src/helpers/zoomSpeakerCollector.ts");

const { matchMeetingPlatformSpeakers }: typeof import("../../../../src/helpers/meetingPlatformMatcher.ts") = require("../../../../src/helpers/meetingPlatformMatcher.ts");
const { zoomSpeakerFixture }: typeof import("../../../lib/zoomSpeakerFixture.ts") = require("../../../lib/zoomSpeakerFixture.ts");
const { composeMeetingAudioParts }: typeof import("../../../../src/helpers/meetingAudioMixer.ts") = require("../../../../src/helpers/meetingAudioMixer.ts");
function evidence(recordingId: string) {
  const { observations, anchors, transcript } = zoomSpeakerFixture(recordingId);
  const decisions = matchMeetingPlatformSpeakers({ observations, anchors, transcript,
    epochs: [{  recordingId, source: "system", epochIndex: 0, timelineStartFrame: 0, frameCount: 14 * 24_000, state: "finalized" }],
    partOffsets: [{ recordingId, startFrame: 0, frameCount: 14 * 24_000 }] });
  assert.ok(decisions.every((d) => d.status === "accepted"));
  return { observations, anchors, observation: observations[0], anchor: anchors[0], decision: decisions[0], decisions, transcript };
}
function finished(db: InstanceType<typeof DatabaseManager>, noteId?: number, startedAt = "2026-09-30T10:00:00.000Z") {
  const note = noteId ? db.getNote(noteId)! : db.saveNote("Synthetic Zoom", "", "meeting").note!;
  const recording = db.createMeetingRecording(note.id, { config: { transcription: { mode: "providers", provider: "elevenlabs", model: "scribe_v2", language: "en" } } }, startedAt);
  for (const source of ["mic", "system"] as const) {
    db.createMeetingRecordingEpoch(recording.id, source, 0, 1, 0, 0);
    db.updateMeetingRecordingEpochRecovery(recording.id, source, 0, { frameCount: 14 * 24_000, ignoredTrailingBytes: 0 });
  }
  db.markMeetingRecordingFinalizing(recording.id);
  const { initialRun } = db.finalizeMeetingRecording(recording.id, { captureState: "ready", endedAt: new Date(Date.parse(startedAt) + 14_000).toISOString(), processingNotBefore: startedAt });
  assert.equal(db.claimMeetingProcessingRun(initialRun.id, new Date(Date.parse(startedAt) + 15_000).toISOString()), true);
  return { note, recording, runId: initialRun.id };
}

test("evidence, atomic decisions and platform corrections survive reopen; stale/manual/voice guards win", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { recording, runId } = finished(db);
  const { observations, anchors, decision } = evidence(recording.id);
  observations.forEach((o) => db.saveMeetingPlatformObservation(o));
  anchors.forEach((a) => db.saveMeetingAudioClockAnchor(a));
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
  assert.equal(reopened.listMeetingPlatformObservations(recording.id)[0].displayName, "Synthetic Guest");
  assert.equal(reopened.listMeetingAudioClockAnchors(recording.id).length, 14);
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
    INSERT INTO old_corrections SELECT run_id, speaker_id, profile_id, display_name, participant_email, source, revision FROM meeting_run_speaker_corrections;
    DROP TABLE meeting_run_speaker_corrections;
    ALTER TABLE old_corrections RENAME TO meeting_run_speaker_corrections;`);
  db.close();
  const reopened = new DatabaseManager();
  t.after(() => reopened.close());
  assert.equal(reopened.getMeetingRunSpeakerCorrections(runId)[0].revision, 1);
  assert.equal(reopened.setMeetingRunSpeakerCorrection(runId, "system:second", null, "Zoom", "platform", undefined, "zoom").success, true);
  const { observation, anchor } = evidence(recording.id);
  reopened.saveMeetingPlatformObservation(observation);
  reopened.saveMeetingAudioClockAnchor(anchor);
  reopened.setMeetingPlatformCoverage(recording.id, { reads: 1, samples: 1, state: "collecting", reason: null });
  reopened.recoverMeetingPlatformCoverage();
  assert.equal(reopened.getMeetingPlatformCoverage(recording.id)?.reason, "app-restarted");
  reopened.db!.prepare("DELETE FROM meeting_recordings WHERE id = ?").run(recording.id);
  assert.deepEqual(reopened.listMeetingPlatformObservations(recording.id), []);
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
  collector.recordDeliveredFrames(anchor.clock.generation, 24_000);
  await collector.stop();
  assert.equal(db.listMeetingAudioClockAnchors(recording.id)[0].clock.endFrame, 24_000);
  const failed = new ZoomSpeakerCollector(recording.id, { ...db,
    saveMeetingPlatformObservation: () => { throw new Error("disk"); },
    saveMeetingAudioClockAnchor: () => { throw new Error("disk"); },
    setMeetingPlatformCoverage: (id, coverage) => db.setMeetingPlatformCoverage(id, coverage),
  });
  failed.bindClock(anchor.clock.generation, 0, 0);
  failed.recordDeliveredFrames(anchor.clock.generation, 24_000);
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
  const { observations, anchors, decision } = evidence(recording.id);
  observations.forEach((o) => db.saveMeetingPlatformObservation(o));
  anchors.forEach((a) => db.saveMeetingAudioClockAnchor(a));
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
    db.createMeetingRecordingEpoch(recording.id, source, 0, 1, 0, 0);
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


test("Pause/Resume uses the real shared multipart map and retains evidence IDs in atomic corrections", (t) => {
  const db = createDb(t);
  if (!db) return;
  const first = finished(db);
  db.setMeetingProcessingRunState(first.runId, { stage: "summary", status: "complete" });
  const second = finished(db, first.note.id, "2026-09-30T10:01:00.000Z");
  db.setMeetingProcessingRunState(second.runId, { stage: "summary", status: "complete" });
  const firstEvidence = zoomSpeakerFixture(first.recording.id);
  const secondEvidence = zoomSpeakerFixture(second.recording.id);
  const observations = [
    ...firstEvidence.observations.filter((o) => BigInt(o.readStartHostNs) < 4000000000n),
    ...secondEvidence.observations.filter((o) => BigInt(o.readStartHostNs) >= 5000000000n),
  ];
  observations.forEach((o) => db.saveMeetingPlatformObservation(o));
  const anchors = [...firstEvidence.anchors, ...secondEvidence.anchors];
  anchors.forEach((a) => db.saveMeetingAudioClockAnchor(a));
  const run = db.createMeetingProcessingRun(first.recording.id, { kind: "reprocess", config: db.getMeetingProcessingRun(first.runId)!.config, sourceRecordingIds: [first.recording.id, second.recording.id] });
  assert.equal(db.claimMeetingProcessingRun(run.id, "2026-09-30T10:02:00.000Z"), true);
  const { epochs, partOffsets } = composeMeetingAudioParts([db.getMeetingRecording(first.recording.id)!, db.getMeetingRecording(second.recording.id)!], (id) => db.listMeetingRecordingEpochs(id));
  assert.equal(partOffsets[1].startFrame, 14 * 24_000);
  const transcript = { text: "Speech", segments: [firstEvidence.transcript.segments[0], ...secondEvidence.transcript.segments.slice(1).map((s) => ({ ...s, start: s.start + 14, end: s.end + 14 }))] };
  const decisions = matchMeetingPlatformSpeakers({ observations, anchors, epochs, partOffsets, transcript });
  assert.ok(decisions.every((d) => d.status === "accepted"));
  assert.equal(decisions[1].intervals[0].start, 19.01);
  assert.equal(db.applyMeetingPlatformDecisions(run.id, 0, decisions), true);
  assert.equal(db.getMeetingRunSpeakerCorrections(run.id)[0].source, "platform");
  const bad = { ...decisions[0], observationIds: [randomUUID()] };
  assert.equal(db.applyMeetingPlatformDecisions(run.id, 1, [bad]), false);
  assert.equal(db.getMeetingRunSpeakerCorrectionRevision(run.id), 1);
});

test("decision policy cutover preserves previous run evidence without inventing a measurement or heuristic", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { recording, runId } = finished(db);
  const { observation, anchor } = evidence(recording.id);
  const historical = { speakerId: "system:fixture", displayName: "Synthetic Guest", status: "rejected", reason: "uncalibrated-timing", observationIds: [observation.id], clockAnchorIds: [anchor.id], intervals: [{ start: 1, end: 1.01 }], measurementId: null, calibration: null };
  db.db.prepare("INSERT INTO meeting_run_platform_decisions (run_id, decisions_json) VALUES (?, ?)").run(runId, JSON.stringify([historical]));
  db.close();
  const reopened = new DatabaseManager();
  t.after(() => reopened.close());
  const decisions = reopened.getMeetingRunPlatformDecisions(runId);
  assert.equal(decisions[0].reason, "uncalibrated-timing");
  assert.equal(decisions[0].timingPolicy, null);
  assert.deepEqual(decisions[0].observationIds, historical.observationIds);
  const stored = reopened.db.prepare("SELECT decisions_json FROM meeting_run_platform_decisions WHERE run_id = ?").get(runId) as { decisions_json: string };
  assert.equal(JSON.parse(stored.decisions_json)[0].calibration, null);
  assert.equal(reopened.applyMeetingPlatformDecisions(runId, 0, [{ ...decisions[0], status: "accepted" }]), false);
  assert.deepEqual(reopened.getMeetingRunSpeakerCorrections(runId), []);
});

test("platform metadata cutover rolls back atomically and preserves historical Zoom decisions on reopen", (t) => {
  const db = createDb(t);
  if (!db) return;
  const { migrateMeetingPlatformEvidence }: typeof import("../../../../src/helpers/meetingPlatformMigration.ts") = require("../../../../src/helpers/meetingPlatformMigration.ts");
  const { recording, runId } = finished(db);
  const { observations, anchors, decisions } = evidence(recording.id);
  for (const observation of observations) db.saveMeetingPlatformObservation(observation);
  for (const anchor of anchors) db.saveMeetingAudioClockAnchor(anchor);
  assert.equal(db.applyMeetingPlatformDecisions(runId, 0, decisions), true);
  const before = db.getMeetingRunSpeakerCorrections(runId);
  db.db.exec(`
    ALTER TABLE meeting_platform_observations RENAME TO meeting_zoom_observations;
    UPDATE meeting_zoom_observations SET evidence_json = json_remove(evidence_json,
      '$.platform', '$.bindingId', '$.activeParticipantIds', '$.clockGeneration', '$.clockUncertaintyNs');
    UPDATE meeting_run_platform_decisions SET decisions_json = (
      SELECT json_group_array(json_remove(value, '$.platform')) FROM json_each(meeting_run_platform_decisions.decisions_json));
    ALTER TABLE meeting_run_speaker_corrections DROP COLUMN platform;
  `);
  const sql = db.db;
  assert.throws(() => migrateMeetingPlatformEvidence({
    pragma: sql.pragma.bind(sql), prepare: sql.prepare.bind(sql), close: sql.close.bind(sql), transaction: sql.transaction.bind(sql),
    exec: (statement: string) => {
      if (statement.includes("UPDATE meeting_platform_observations")) throw new Error("injected metadata failure");
      return sql.exec(statement);
    },
  }), /injected metadata failure/);
  assert.ok(sql.prepare("SELECT 1 FROM sqlite_master WHERE name = 'meeting_zoom_observations'").get());
  assert.equal(sql.prepare("SELECT 1 FROM sqlite_master WHERE name = 'meeting_platform_observations'").get(), undefined);
  db.close();
  const reopened = new DatabaseManager();
  try {
    assert.deepEqual(reopened.listMeetingPlatformObservations(recording.id), observations);
    assert.deepEqual(reopened.getMeetingRunPlatformDecisions(runId), decisions);
    assert.deepEqual(reopened.getMeetingRunSpeakerCorrections(runId), before);
    assert.equal(reopened.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'meeting_zoom_observations'").get(), undefined);
    migrateMeetingPlatformEvidence(reopened.db);
    assert.deepEqual(reopened.getMeetingRunSpeakerCorrections(runId), before, "second migration does not change revisions");
  } finally { reopened.close(); }
});

test("Telemost CHECK cutover preserves corrections and rolls back on copy failure", t => {
  const db = createDb(t); if (!db) return;
  const { runId } = finished(db);
  db.setMeetingRunSpeakerCorrection(runId, "system:fixture", null, "Original", "user");
  const before = db.getMeetingRunSpeakerCorrections(runId);
  db.db.exec(`ALTER TABLE meeting_run_speaker_corrections DROP COLUMN platform;
    ALTER TABLE meeting_run_speaker_corrections ADD COLUMN platform TEXT CHECK(platform IN ('zoom', 'google-meet'));`);
  const { migrateMeetingPlatformEvidence }: typeof import("../../../../src/helpers/meetingPlatformMigration.ts") = require("../../../../src/helpers/meetingPlatformMigration.ts");
  const sql = db.db;
  assert.throws(() => migrateMeetingPlatformEvidence({
    pragma: sql.pragma.bind(sql), prepare: sql.prepare.bind(sql), close: sql.close.bind(sql), transaction: sql.transaction.bind(sql),
    exec: (statement: string) => {
      if (statement.includes("CREATE TABLE meeting_run_speaker_corrections_telemost")) {
        sql.exec(statement.split("INSERT INTO")[0]);
        throw new Error("injected Telemost copy failure");
      }
      return sql.exec(statement);
    },
  }), /injected Telemost copy failure/);
  assert.deepEqual(db.getMeetingRunSpeakerCorrections(runId), before);
  assert.equal(sql.prepare("SELECT 1 FROM sqlite_master WHERE name = 'meeting_run_speaker_corrections_telemost'").get(), undefined);
  migrateMeetingPlatformEvidence(sql);
  assert.deepEqual(db.getMeetingRunSpeakerCorrections(runId), before);
  sql.prepare("UPDATE meeting_run_speaker_corrections SET platform = 'telemost', source = 'platform' WHERE run_id = ?").run(runId);
  db.close();
  const reopened = new DatabaseManager(); t.after(() => reopened.close());
  assert.equal(reopened.getMeetingRunSpeakerCorrections(runId)[0].platform, "telemost");
  assert.equal(reopened.getMeetingRunSpeakerCorrections(runId)[0].revision, before[0].revision);
});
