import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createDb } from "../../../helpers/harness/db.ts";
import { getUserDataDir } from "../../../helpers/harness/electronStub.ts";
import {
  replayMeetingFixture,
  meetingAudioFileHash,
} from "../../../helpers/harness/meetingPrivateFixture.ts";
import { savePcmEpoch } from "../../../lib/meetingAudioFixture.ts";
import { calibratedEpoch } from "../../../helpers/harness/meetingResampler.ts";
import { MeetingRecordingStorage } from "../../../../src/helpers/meetingRecordingStorage.ts";
import { prepareMeetingAudio } from "../../../../src/helpers/meetingAudioMixer.ts";

test("private raw transport preserves production DTOs, nanoseconds and intentional empty mic", async (t) => {
  const sourceDb = createDb(t);
  assert.ok(sourceDb);
  const profile = getUserDataDir(),
    sourceStorage = new MeetingRecordingStorage({ userDataPath: profile });
  const note = sourceDb.saveNote("Synthetic transport", "", "meeting").note!;
  const recording = sourceDb.createMeetingRecording(
    note.id,
    { config: null },
    "2026-01-01T00:00:00Z"
  );
  const pcm = Buffer.alloc(24000 * 2);
  for (let i = 0; i < 24000; i++)
    pcm.writeInt16LE(Math.round(4000 * Math.sin((i * Math.PI * 317) / 12000)), i * 2);
  savePcmEpoch(sourceStorage, recording.id, "system", 0, pcm);
  sourceDb.createMeetingRecordingEpoch(recording.id, "system", 0, 1, 0, null);
  sourceDb.updateMeetingRecordingEpochRecovery(
    recording.id,
    "system",
    0,
    sourceStorage.recoverEpoch(recording.id, "system", 0)
  );
  const segment = calibratedEpoch([{ frames: 24000, start: 0, uncertainty: 2 }])
    .alignmentSegments[0]!;
  const nanos = "9007199254740995000";
  sourceDb.addMeetingRecordingEpochAlignment(recording.id, "system", 0, {
    ...segment,
    sourceStartNs: nanos,
    sourceEndNs: nanos,
    helperStartNs: nanos,
    helperEndNs: nanos,
    sampledSourceStartNs: nanos,
    sampledSourceEndNs: nanos,
    freshnessSourceNs: nanos,
  });
  const point = {
    sourceGeneration: 1,
    sourceFrame: 0,
    timelineFrame: 0,
    rate: 1,
    uncertaintyFrames: 2,
    helperGeneration: randomUUID(),
    sourceNs: nanos,
    helperNs: nanos,
    sampledSourceStartNs: nanos,
    sampledSourceEndNs: nanos,
    freshnessSourceNs: nanos,
  };
  sourceDb.openMeetingIntentionalInterval(recording.id, "mic", 1, 0, "manual-muted", point);
  sourceDb.closeMeetingIntentionalInterval(recording.id, "mic", 1, 24000, "manual-muted", {
    ...point,
    sourceFrame: 24000,
    timelineFrame: 24000,
  });
  sourceDb.markMeetingRecordingFinalizing(recording.id);
  sourceDb.finalizeMeetingRecording(recording.id, {
    captureState: "ready",
    endedAt: "2026-01-01T00:00:01Z",
    sourceMetadata: { captureEndFrame: 24000 },
  });
  const expected = {
    recording: sourceDb.getMeetingRecording(recording.id),
    epochs: sourceDb.listMeetingRecordingEpochs(recording.id),
    intervals: sourceDb.listMeetingIntentionalIntervals(recording.id),
  };
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-private-transport-"));
  fs.chmodSync(parent, 0o700);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const exported = path.join(parent, "fixture");
  const sourceDatabaseFiles = ["transcriptions.db", "transcriptions.db-wal"].map((file) =>
    path.join(profile, file)
  );
  const sourceDatabaseHashes = sourceDatabaseFiles.map(meetingAudioFileHash);
  execFileSync("python3", [
    "test/benchmarks/copy-meeting-for-prototype.py",
    profile,
    String(note.id),
    exported,
  ]);
  assert.deepEqual(
    sourceDatabaseFiles.map(meetingAudioFileHash),
    sourceDatabaseHashes,
    "export must not write the source database/WAL"
  );
  assert.equal(fs.statSync(exported).mode & 0o777, 0o700);
  for (const file of fs.readdirSync(exported))
    assert.equal(fs.statSync(path.join(exported, file)).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(path.join(exported, "raw-rows.json"), "utf8"), new RegExp(nanos));
  const destinationDb = createDb(t);
  assert.ok(destinationDb);
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const [actual] = replayMeetingFixture(exported, destinationDb, storage);
  assert.ok(actual);
  assert.deepEqual(actual, expected);
  for (const layout of ["mono", "stereo", "mic", "system"] as const) {
    const result = await prepareMeetingAudio(
      storage,
      actual.recording,
      randomUUID(),
      actual.epochs,
      { layout, intentionalEmptySources: ["mic"] }
    );
    assert.equal(result.frameCount, 24000);
    assert.ok(fs.statSync(result.path).size > 24000);
  }
  assert.throws(
    () =>
      execFileSync("python3", [
        "test/benchmarks/copy-meeting-for-prototype.py",
        profile,
        String(note.id),
        path.join(profile, "forbidden"),
      ]),
    /outside repository and source profile/
  );
  const unavailable = path.join(parent, "unavailable-profile");
  fs.mkdirSync(unavailable);
  fs.writeFileSync(path.join(unavailable, "transcriptions.db"), "synthetic missing sidecars");
  assert.throws(
    () =>
      execFileSync("python3", [
        "test/benchmarks/copy-meeting-for-prototype.py",
        unavailable,
        String(note.id),
        path.join(parent, "not-published"),
      ]),
    /readable WAL sidecars/
  );
  assert.equal(fs.existsSync(path.join(parent, "not-published")), false);
});
