import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createDb } from "../../../helpers/harness/db.ts";
import { getUserDataDir } from "../../../helpers/harness/electronStub.ts";
import { savePcmEpoch } from "../../../lib/meetingAudioFixture.ts";
import { MeetingRecordingStorage } from "../../../../src/helpers/meetingRecordingStorage.ts";
import { exportMeetingSourceTrack } from "../../../../src/helpers/meetingAudioExport.ts";
import {
  prepareMeetingAudio,
  composeMeetingAudioParts,
} from "../../../../src/helpers/meetingAudioMixer.ts";
import type {
  MeetingFrameAlignmentSegment,
  MeetingSource,
} from "../../../../src/contracts/meetingRecording.ts";

function alignment(end: number, start = 2400, rate = 1): MeetingFrameAlignmentSegment {
  return {
    sourceGeneration: 1,
    sourceStartFrame: 0,
    sourceEndFrame: end,
    timelineStartFrame: start,
    rate,
    uncertaintyStartFrames: 2,
    uncertaintyEndFrames: 2,
    helperGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sourceStartNs: "1000000000",
    sourceEndNs: "1100000000",
    helperStartNs: "1000000000",
    helperEndNs: "1100000000",
    sampledSourceStartNs: "1000000000",
    sampledSourceEndNs: "1300000000",
    freshnessSourceNs: "1300000000",
  };
}

function fixture(t: TestContext, selected: MeetingSource = "system", restart = false) {
  const db = createDb(t)!;
  const root = getUserDataDir();
  const storage = new MeetingRecordingStorage({ userDataPath: root });
  const note = db.saveNote("Source export", "Keep manual note", "meeting").note!;

  const recording = db.createMeetingRecording(
    note.id,
    { config: null },
    "2026-10-01T10:00:00.000Z"
  );

  for (const source of ["mic", "system"] as const) {
    db.createMeetingRecordingEpoch(recording.id, source, 0, 1, 0, null);
    savePcmEpoch(storage, recording.id, source, 0, Buffer.alloc(4800, 3));
    db.updateMeetingRecordingEpochRecovery(
      recording.id,
      source,
      0,
      storage.recoverEpoch(recording.id, source, 0)
    );

    if (source === selected)
      db.addMeetingRecordingEpochAlignment(recording.id, source, 0, alignment(2400));
  }

  if (restart) {
    db.createMeetingRecordingEpoch(recording.id, "system", 1, 2, 0, null);
    savePcmEpoch(storage, recording.id, "system", 1, Buffer.alloc(4800, 3));
    db.updateMeetingRecordingEpochRecovery(
      recording.id,
      "system",
      1,
      storage.recoverEpoch(recording.id, "system", 1)
    );
    db.addMeetingRecordingEpochAlignment(recording.id, "system", 1, {
      ...alignment(2400, 9600, 1.001),
      sourceGeneration: 2,
    });
  }

  db.markMeetingRecordingFinalizing(recording.id);

  const finalized = db.finalizeMeetingRecording(recording.id, {
    captureState: "ready",
    endedAt: "2026-10-01T10:00:00.300Z",
    sourceMetadata: { captureEndFrame: 7200 },
  }).recording;

  const epochs = db.listMeetingRecordingEpochs(recording.id);
  const destination = path.join(root, "selected.wav");

  return { db, root, storage, recording: finalized, epochs, destination, note };
}

function wavData(destination: string) {
  const wav = fs.readFileSync(destination);
  const at = wav.indexOf(Buffer.from("data"));
  assert.ok(at > 0);

  return wav.subarray(at + 8, at + 8 + wav.readUInt32LE(at + 4));
}

for (const selected of ["mic", "system"] as const) {
  test(`aligned ${selected} exports despite unknown peer; mixed, playback and ASR prepare remain strict`, async (t) => {
    const f = fixture(t, selected);

    const raw = f.epochs.map((epoch) =>
      fs.readFileSync(f.storage.getEpochFilePath(epoch.recordingId, epoch.source, epoch.epochIndex))
    );

    await exportMeetingSourceTrack(f.storage, f.recording, selected, f.epochs, f.destination);
    const data = wavData(f.destination);
    assert.equal(data.length, 7200 * 2);
    assert.deepEqual(data.subarray(0, 2400 * 2), Buffer.alloc(4800));
    assert.deepEqual(data.subarray(4800 * 2), Buffer.alloc(4800));

    for (const layout of ["mono", "stereo", "mic", "system"] as const) {
      await assert.rejects(
        prepareMeetingAudio(f.storage, f.recording, `strict-${layout}`, f.epochs, { layout }),
        { code: "audio-alignment-unavailable" }
      );
    }

    assert.throws(() => composeMeetingAudioParts([f.recording], () => f.epochs), {
      code: "audio-alignment-unavailable",
    });
    assert.equal(f.db.getNote(f.note.id)?.content, "Keep manual note");
    assert.deepEqual(
      f.epochs.map((epoch) =>
        fs.readFileSync(
          f.storage.getEpochFilePath(epoch.recordingId, epoch.source, epoch.epochIndex)
        )
      ),
      raw
    );
  });
}

test("fully proven later peer endpoint keeps trailing silence even when common extent is shorter", async (t) => {
  const f = fixture(t);

  const epochs = f.epochs.map((epoch) =>
    epoch.source === "mic" ? { ...epoch, alignmentSegments: [alignment(2400, 9600)] } : epoch
  );

  await exportMeetingSourceTrack(
    f.storage,
    { ...f.recording, sourceMetadata: { captureEndFrame: 1 } },
    "system",
    epochs,
    f.destination
  );
  const data = wavData(f.destination);
  assert.equal(data.length, 12000 * 2);
  assert.deepEqual(data.subarray(4800 * 2), Buffer.alloc(7200 * 2));
});

for (const invalid of ["unknown", "partial", "generation", "uncertainty"] as const) {
  test(`selected ${invalid} alignment fails without replacing destination or touching raw`, async (t) => {
    const f = fixture(t);
    const segment = alignment(invalid === "partial" ? 1200 : 2400);

    if (invalid === "generation") segment.sourceGeneration = 2;

    if (invalid === "uncertainty") segment.uncertaintyEndFrames = 601;

    const epochs = f.epochs.map((epoch) =>
      epoch.source === "system"
        ? { ...epoch, alignmentSegments: invalid === "unknown" ? [] : [segment] }
        : epoch
    );

    fs.writeFileSync(f.destination, "keep destination");
    await assert.rejects(
      exportMeetingSourceTrack(f.storage, f.recording, "system", epochs, f.destination),
      { code: "audio-alignment-unavailable" }
    );
    assert.equal(fs.readFileSync(f.destination, "utf8"), "keep destination");
    assert.equal(f.storage.recoverEpoch(f.recording.id, "system", 0).frameCount, 2400);
  });
}

test("open peer, empty selected source and missing saved duration remain errors", async (t) => {
  const f = fixture(t);

  const open = f.epochs.map((epoch) =>
    epoch.source === "mic" ? { ...epoch, state: "open" as const } : epoch
  );

  await assert.rejects(
    exportMeetingSourceTrack(f.storage, f.recording, "system", open, f.destination),
    /unfinalized/
  );
  await assert.rejects(
    exportMeetingSourceTrack(
      f.storage,
      f.recording,
      "system",
      f.epochs.filter((epoch) => epoch.source === "mic"),
      f.destination
    ),
    /no usable/
  );
  await assert.rejects(
    exportMeetingSourceTrack(
      f.storage,
      { ...f.recording, sourceMetadata: {}, endedAt: null },
      "system",
      f.epochs,
      f.destination
    ),
    /timeline is invalid/
  );
  assert.equal(fs.existsSync(f.destination), false);
});

test("source export keeps restart gaps and calibrated rate; UTC historical extent still applies", async (t) => {
  const f = fixture(t, "system", true);
  const epochs = f.db.listMeetingRecordingEpochs(f.recording.id);
  await exportMeetingSourceTrack(
    f.storage,
    { ...f.recording, sourceMetadata: {}, endedAt: "2026-10-01T10:00:01.000Z" },
    "system",
    epochs,
    f.destination
  );
  const data = wavData(f.destination);
  assert.equal(data.length, 24000 * 2);
  assert.deepEqual(data.subarray(4800 * 2, 9600 * 2), Buffer.alloc(4800 * 2));
  assert.deepEqual(data.subarray(12002 * 2), Buffer.alloc((24000 - 12002) * 2));
});

test("corrupt selected Opus fails, corrupt unselected Opus is not read", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.storage.getEpochFilePath(f.recording.id, "mic", 0), "bad peer");
  await exportMeetingSourceTrack(f.storage, f.recording, "system", f.epochs, f.destination);
  const previous = fs.readFileSync(f.destination);
  fs.writeFileSync(f.storage.getEpochFilePath(f.recording.id, "system", 0), "bad selected");
  await assert.rejects(
    exportMeetingSourceTrack(f.storage, f.recording, "system", f.epochs, f.destination)
  );
  assert.deepEqual(fs.readFileSync(f.destination), previous);
});
