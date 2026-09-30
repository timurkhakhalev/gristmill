const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { createDb, DatabaseManager } = require("../../../helpers/harness/db.ts") as typeof import("../../../helpers/harness/db.ts");
const { getUserDataDir } = require("../../../helpers/harness/electronStub.ts") as typeof import("../../../helpers/harness/electronStub.ts");
const { savePcmEpoch } = require("../../../lib/meetingAudioFixture.ts") as typeof import("../../../lib/meetingAudioFixture.ts");
const { MeetingProcessingWorker } = require("../../../../src/helpers/meetingProcessing.ts") as typeof import("../../../../src/helpers/meetingProcessing.ts");
const { composeMeetingAudioParts } = require("../../../../src/helpers/meetingAudioMixer.ts") as typeof import("../../../../src/helpers/meetingAudioMixer.ts");
const { MeetingRecordingStorage } = require("../../../../src/helpers/meetingRecordingStorage.ts") as typeof import("../../../../src/helpers/meetingRecordingStorage.ts");
import type { MeetingProcessingConfig } from "../../../../src/contracts/meetingRecording";

const config: MeetingProcessingConfig = {
  transcription: { mode: "providers", provider: "elevenlabs", model: "scribe_v2", language: "en", credentialRef: "ELEVENLABS_API_KEY" },
  summary: { actionId: "notes.actions.builtin.detailedNotes", instruction: "Summarize", reasoningMode: "providers", provider: "openai", model: "gpt-4o-mini", credentialRef: "OPENAI_API_KEY" },
};

test("Note processing includes earlier groups after restart and orders audio before sending meeting material", async (t) => {
  let db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const note = db.saveNote("Meeting", "Keep manual notes", "meeting").note!;
  function finish(start: string, seconds: number) {
    const recording = db!.createMeetingRecording(note.id, { config }, start);
    db!.createMeetingRecordingEpoch(recording.id, "system", 0, 0);
    savePcmEpoch(storage, recording.id, "system", 0, Buffer.from([1, 2, 3, 4]));
    db!.updateMeetingRecordingEpochRecovery(recording.id, "system", 0, storage.recoverEpoch(recording.id, "system", 0));
    db!.markMeetingRecordingFinalizing(recording.id);
    return db!.finalizeMeetingRecording(recording.id, { captureState: "ready", endedAt: new Date(Date.parse(start) + seconds * 1000).toISOString() });
  }
  const first = finish("2026-09-30T07:07:00.000Z", 100);
  db.close();
  db = new DatabaseManager();
  t.after(() => db?.close());
  const second = finish("2026-09-30T07:30:00.000Z", 200);
  assert.notEqual(first.recording.groupId, second.recording.groupId);
  assert.deepEqual(second.initialRun.sourceRecordingIds, [first.recording.id, second.recording.id]);
  const combined = composeMeetingAudioParts([second.recording, first.recording], (id) => db!.listMeetingRecordingEpochs(id));
  assert.deepEqual(combined.epochs.map((epoch) => epoch.recordingId), [first.recording.id, second.recording.id]);
  assert.equal(combined.epochs[1].startFrame, 100 * 24_000);
  assert.equal(combined.recording.startedAt, first.recording.startedAt);

  let material = "";
  const beginning = `Beginning ${"a".repeat(1300)}`;
  const ending = `Ending ${"b".repeat(1300)}`;
  const worker = new MeetingProcessingWorker({
    database: db, storage, isCaptureActive: () => false,
    now: () => new Date("2026-10-01T00:00:00Z"),
    getCredential: () => "test-key",
    fileSize: () => 4096,
    mixAudio: async (recording, runId, epochs) => {
      assert.deepEqual(epochs.map((epoch) => epoch.recordingId), [first.recording.id, second.recording.id]);
      return { path: storage.getDerivedAudioPath(recording.id, runId), frameCount: 300 * 24_000, durationSeconds: 300, sizeBytes: 4096 };
    },
    transcribeRemote: async (request, saveRaw) => {
      await saveRaw(request.diarize ? { text: `${beginning} ${ending}`, words: [
        { type: "word", text: beginning, start: 0, end: 1, speaker_id: "speaker_0" },
        { type: "word", text: ending, start: 100, end: 101, speaker_id: "speaker_1" },
      ] } : { text: "", words: [] });
      return { success: true, text: "" };
    },
    transcribeLocal: async () => ({ success: false, error: "unused" }),
    diarizeLocal: async () => [],
    summarize: async (input) => { material = input; return "## Summary\nComplete meeting"; },
  });
  t.after(() => worker.stop());
  // The renderer may know only the latest group; main owns the complete source set.
  const result = worker.createRun({ recordingId: second.recording.id, sourceRecordingIds: [second.recording.id], kind: "reprocess", gateAfterStop: true, config });
  assert.deepEqual(result.run.sourceRecordingIds, [first.recording.id, second.recording.id]);
  db.setMeetingProcessingRunState(first.initialRun.id, { stage: "prepare", status: "cancelled" });
  db.setMeetingProcessingRunState(second.initialRun.id, { stage: "prepare", status: "cancelled" });
  db.setMeetingProcessingRunState(result.run.id, { stage: "prepare", status: "pending", retryAt: null });
  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(result.run.id)?.status, "complete");
  assert.ok(material.includes(beginning));
  assert.ok(material.indexOf(beginning) < material.indexOf(ending));
  assert.equal(db.getNote(note.id)?.content, "Keep manual notes");

  const otherNote = db.saveNote("Other meeting", "", "meeting").note!;
  const otherRecording = db.createMeetingRecording(otherNote.id, { config });
  assert.throws(() => worker.createRun({
    recordingId: otherRecording.id, sourceRecordingIds: [first.recording.id], kind: "reprocess", config,
  }), /Meeting audio is unavailable for a selected part/);

  const pending = db.createMeetingProcessingRun(first.recording.id, {
    kind: "reprocess", sourceRecordingIds: [first.recording.id], config,
    retryAt: "2026-10-02T00:00:00Z",
  });
  worker.captureStarted(second.recording.noteId);
  assert.equal(db.getMeetingProcessingRun(pending.id)?.status, "cancelled");
  assert.equal(db.getMeetingProcessingRun(pending.id)?.errorCode, "meeting-resumed");
});
