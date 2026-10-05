const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const {
  createDb,
  DatabaseManager,
}: typeof import("../../../helpers/harness/db.ts") = require("../../../helpers/harness/db.ts");

const {
  getUserDataDir,
}: typeof import("../../../helpers/harness/electronStub.ts") = require("../../../helpers/harness/electronStub.ts");

const {
  MeetingRecordingStorage,
}: typeof import("../../../../src/helpers/meetingRecordingStorage.js") = require("../../../../src/helpers/meetingRecordingStorage.ts");

const {
  MeetingCaptureSession,
}: typeof import("../../../../src/helpers/meetingCaptureSession.js") = require("../../../../src/helpers/meetingCaptureSession.ts");

const {
  meetingTimelineFrameCount,
  meetingSourceIntentionallyEmpty,
  prepareMeetingAudio,
}: typeof import("../../../../src/helpers/meetingAudioMixer.js") = require("../../../../src/helpers/meetingAudioMixer.ts");

const {
  getFFmpegPath,
}: typeof import("../../../../src/helpers/ffmpegUtils.js") = require("../../../../src/helpers/ffmpegUtils.ts");

test("intentional mute coverage and raw system Opus survive database reopen", async (t) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const note = db.saveNote("Muted capture", "", "meeting").note!;

  const capture = MeetingCaptureSession.create(
    db,
    storage,
    note.id,
    null,
    new Date("2026-10-01T10:00:00.000Z"),
    undefined,
    undefined,
    true
  );

  capture.setMonotonicOriginNs("1000000000000000");
  const original = Buffer.alloc(48_000, 7);
  capture.appendNativeSamples("system", 1, original, 0, 0);

  const stopped = await capture.stop({
    lastSequence: { system: -1 },
    microphoneBoundary: { sourceGeneration: 1, sourceFrame: 24_000, alignment: null },
  });

  assert.equal(stopped.captureState, "ready");

  const recordingId = capture.recordingId;
  const rawPath = storage.getEpochFilePath(recordingId, "system", 0);
  const rawBefore = fs.readFileSync(rawPath);
  assert.ok(rawBefore.length > 0);
  const intervalsBefore = db.listMeetingIntentionalIntervals(recordingId);
  assert.deepEqual(
    intervalsBefore.map(
      ({ source, sourceStartFrame: startFrame, sourceEndFrame: endFrame, reason }) => [
        source,
        startFrame,
        endFrame,
        reason,
      ]
    ),
    [["mic", 0, 24_000, "manual-muted"]]
  );
  const recordingBefore = db.getMeetingRecording(recordingId);
  assert.ok(recordingBefore);
  await t.test(
    "derived provider layouts keep only the intentional mic channel empty",
    async (mixerTest) => {
      const ffmpegPath = getFFmpegPath();

      if (!ffmpegPath) {
        mixerTest.skip("FFmpeg is unavailable for derived-audio verification");

        return;
      }

      const epochsBefore = db.listMeetingRecordingEpochs(recordingId);

      const prepared = await prepareMeetingAudio(
        storage,
        recordingBefore,
        stopped.initialRunId,
        epochsBefore,
        {
          layout: "stereo",
          intentionalEmptySources: ["mic"],
          deps: { ffmpegPath: () => ffmpegPath },
        }
      );

      const wav = fs.readFileSync(prepared.path);
      const formatHeader = wav.indexOf(Buffer.from("fmt "));
      const dataHeader = wav.indexOf(Buffer.from("data"));
      const dataStart = dataHeader + 8;
      assert.equal(wav.readUInt16LE(formatHeader + 10), 2, "Deepgram keeps a stereo source layout");
      assert.equal(wav.readUInt32LE(dataHeader + 4), 24_000 * 2 * 2);

      for (let frame = 0; frame < 24_000; frame += 1) {
        assert.equal(
          wav.readInt16LE(dataStart + frame * 4),
          0,
          `intentional-empty mic channel stays silent at frame ${frame}`
        );
      }

      assert.ok(
        wav.subarray(dataStart + 2, dataStart + 24_000 * 4).some((value) => value !== 0),
        "system channel remains audible"
      );

      const mono = await prepareMeetingAudio(
        storage,
        recordingBefore,
        stopped.initialRunId,
        epochsBefore,
        {
          layout: "mono",
          intentionalEmptySources: ["mic"],
          deps: { ffmpegPath: () => ffmpegPath },
        }
      );

      const monoWav = fs.readFileSync(mono.path);
      const monoFormatHeader = monoWav.indexOf(Buffer.from("fmt "));
      const monoDataHeader = monoWav.indexOf(Buffer.from("data"));
      assert.equal(
        monoWav.readUInt16LE(monoFormatHeader + 10),
        1,
        "Local retains its mono source layout"
      );
      assert.ok(
        monoWav.subarray(monoDataHeader + 8).some((value) => value !== 0),
        "Local mono includes the system source"
      );
    }
  );
  db.close();

  const reopened = new DatabaseManager();

  try {
    const recording = reopened.getMeetingRecording(recordingId);
    assert.ok(recording);
    const epochs = reopened.listMeetingRecordingEpochs(recordingId);
    const intervals = reopened.listMeetingIntentionalIntervals(recordingId);
    assert.equal(recording.captureState, "ready");
    assert.equal(recording.sourceMetadata.captureEndFrame, 24_000);
    assert.equal(epochs[0].timelineStartFrame, 0);
    assert.equal(epochs[0].frameCount, 24_000);
    assert.deepEqual(intervals, intervalsBefore);
    assert.equal(meetingSourceIntentionallyEmpty(recording, epochs, intervals, "mic"), true);
    assert.equal(fs.readFileSync(rawPath).equals(rawBefore), true);
  } finally {
    reopened.close();
  }
});

test("historical recordings continue to derive duration from their stored UTC bounds", () => {
  const oldRecording = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    startedAt: "2026-09-01T10:00:00.000Z",
    endedAt: "2026-09-01T10:00:02.000Z",
    sourceMetadata: {},
  } as any;

  const oldEpoch = {
    sourceGeneration: null,
    sourceStartFrame: null,
    alignmentSegments: [],
    alignmentErrorCode: null,
    recordingId: oldRecording.id,
    source: "system",
    epochIndex: 0,
    timelineStartFrame: 12_000,
    sampleRate: 24_000,
    channels: 1,
    encoding: "opus",
    relativePath: "system/epoch-000000.opus",
    state: "finalized",
    frameCount: 1_200,
    ignoredTrailingBytes: 0,
    errorCode: null,
  } as any;

  assert.equal(meetingTimelineFrameCount(oldRecording, [oldEpoch]), 48_000);
});

for (const mode of ["manual", "platform", "unmute-remute", "source-error"] as const) {
  test(`crash before Stop retains only valid full-mute proof: ${mode}`, async (t) => {
    const db = createDb(t);

    if (!db) return;
    const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
    const note = db.saveNote("Interrupted mute", "", "meeting").note!;

    const capture = MeetingCaptureSession.create(
      db,
      storage,
      note.id,
      null,
      new Date("2026-10-01T10:00:00Z"),
      undefined,
      undefined,
      mode !== "platform"
    );

    if (mode === "platform") capture.initializePlatformMute(true);

    if (mode === "unmute-remute") {
      await capture.setMicIntent({
        sequence: 1,
        sourceGeneration: 1,
        manualMuted: false,
        platformMuted: false,
        boundaryFrame: 0,
        boundaryAlignment: null,
      });
      await capture.setMicIntent({
        sequence: 2,
        sourceGeneration: 1,
        manualMuted: true,
        platformMuted: false,
        boundaryFrame: 0,
        boundaryAlignment: null,
      });
    }

    if (mode === "source-error") capture.markSourceUnavailable("mic", "mic-source-unavailable");
    capture.appendNativeSamples("system", 1, Buffer.alloc(48_000, 7), 0, 0);
    // Close the encoder only: there is no capture Stop or recording finalization.
    // Startup must recover the still-open database state, even with a valid EOS.
    await storage.closeEpochWriter(capture.recordingId, "system", 0);
    const rawPath = storage.getEpochFilePath(capture.recordingId, "system", 0);
    const rawBefore = fs.readFileSync(rawPath);
    assert.equal(db.getMeetingRecording(capture.recordingId)!.captureState, "recording");
    db.close();
    const reopened = new DatabaseManager();

    try {
      storage.recover(reopened);
      const recording = reopened.getMeetingRecording(capture.recordingId)!;
      const epochs = reopened.listMeetingRecordingEpochs(capture.recordingId);
      const intervals = reopened.listMeetingIntentionalIntervals(capture.recordingId);
      assert.equal(recording.captureState, "incomplete");
      assert.equal(
        epochs.some((epoch) => epoch.source === "mic"),
        false
      );
      assert.ok(
        intervals.every(
          (interval) => interval.startAlignment === null && interval.endAlignment === null
        )
      );
      assert.equal(
        meetingSourceIntentionallyEmpty(recording, epochs, intervals, "mic"),
        mode === "manual" || mode === "platform"
      );
      assert.deepEqual(fs.readFileSync(rawPath), rawBefore);
    } finally {
      reopened.close();
    }
  });
}

test("invalidated whole-capture proof cannot be restored by interval coverage", () => {
  const recording = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sourceMetadata: { captureEndFrame: 24_000, mic: { intentionallyEmpty: false } },
  } as any;

  const intervals = [{ source: "mic", timelineStartFrame: 0, timelineEndFrame: 24_000 }] as any;
  assert.equal(meetingSourceIntentionallyEmpty(recording, [], intervals, "mic"), false);
  assert.equal(
    meetingSourceIntentionallyEmpty(
      recording,
      [{ source: "mic", frameCount: 1 }] as any,
      intervals,
      "mic"
    ),
    false
  );
});
