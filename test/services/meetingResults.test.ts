const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");
const { createDb } = require("../helpers/harness/db.ts");
const { getUserDataDir, setUserDataDir }: typeof import("../helpers/harness/electronStub.ts") = require("../helpers/harness/electronStub.ts");
const MeetingRecordingStorage = require("../../src/helpers/meetingRecordingStorage.ts");
const { MeetingProcessingWorker }: typeof import("../../src/helpers/meetingProcessing.ts") = require("../../src/helpers/meetingProcessing.ts");
const {
  canPlayMeetingRun,
  copyMeetingAudioExport,
  createMeetingAudioOperationRegistry,
  exportMeetingMixedMp3,
  exportMeetingSourceTrack,
} = require("../../src/helpers/meetingAudioExport.ts");
const { prepareMeetingAudio }: typeof import("../../src/helpers/meetingAudioMixer.ts") = require("../../src/helpers/meetingAudioMixer.ts");
const { recognizeMeetingSpeakers }: typeof import("../../src/helpers/meetingSpeakerRecognition.ts") = require("../../src/helpers/meetingSpeakerRecognition.ts");
import type { DatabaseManager } from "../helpers/harness/db.ts";
import type { MeetingRecordingStorage as MeetingRecordingStorageInstance } from "../../src/helpers/meetingRecordingStorage.js";
import type {
  MeetingProcessingConfig,
  MeetingTranscriptArtifact,
} from "../../src/contracts/meetingRecording.js";
import type { MeetingProcessingWorkerDeps } from "../../src/helpers/meetingProcessing.js";

type Db = DatabaseManager;
type MeetingRecordingStorageTypeAlias = MeetingRecordingStorageInstance;
type WorkerDeps = MeetingProcessingWorkerDeps;
type MeetingSource = "mic" | "system";

const config = {
  transcription: {
    mode: "providers",
    provider: "elevenlabs",
    model: "scribe_v2",
    language: "en",
    credentialRef: "ELEVENLABS_API_KEY",
  },
  summary: {
    actionId: "notes.actions.builtin.detailedNotes",
    instruction: "Summarize the transcript.",
    reasoningMode: "providers",
    provider: "openai",
    model: "gpt-4o-mini",
    credentialRef: "OPENAI_API_KEY",
  },
} satisfies MeetingProcessingConfig;

function createFinishedRecording(
  db: Db,
  storage: MeetingRecordingStorageTypeAlias,
  options: {
    content?: string;
    startedAt?: string;
    endedAt?: string;
    sourceMetadata?: Record<string, unknown>;
    sources?: Array<{ source: MeetingSource; startFrame: number; samples: Buffer }>;
  } = {}
) {
  const note = db.saveNote("Meeting", options.content ?? "  Manual note stays.  ", "meeting").note!;
  const startedAt = options.startedAt ?? new Date().toISOString();
  const recording = db.createMeetingRecording(note.id, { config }, startedAt);
  const sources = options.sources ?? [{ source: "mic", startFrame: 0, samples: Buffer.alloc(480_000, 1) }];
  for (const [index, epoch] of sources.entries()) {
    db.createMeetingRecordingEpoch(recording.id, epoch.source, index, epoch.startFrame);
    storage.openEpochWriter(recording.id, epoch.source, index);
    storage.appendEpochSamples(recording.id, epoch.source, index, epoch.samples);
    storage.closeEpochWriter(recording.id, epoch.source, index);
    db.updateMeetingRecordingEpochRecovery(
      recording.id,
      epoch.source,
      index,
      storage.recoverEpoch(recording.id, epoch.source, index)
    );
  }
  db.markMeetingRecordingFinalizing(recording.id);
  const endedAt = options.endedAt ?? new Date(Date.parse(startedAt) + 10_000).toISOString();
  const finalized = db.finalizeMeetingRecording(recording.id, {
    captureState: "ready",
    endedAt,
    sourceMetadata: options.sourceMetadata ?? {},
  });
  return { note, recording: finalized.recording, initialRun: finalized.initialRun };
}

function attachArtifacts(db: Db, storage: MeetingRecordingStorageTypeAlias, runId: string, transcript: MeetingTranscriptArtifact, summary: { text: string } | null = null) {
  storage.writeRunArtifact(runId, "provider-response", { retained: true });
  assert.equal(db.setMeetingRunArtifact(runId, "provider-response").success, true);
  storage.writeRunArtifact(runId, "transcript", transcript);
  assert.equal(db.setMeetingRunArtifact(runId, "transcript").success, true);
  if (summary) {
    storage.writeRunArtifact(runId, "summary", summary);
    assert.equal(db.setMeetingRunArtifact(runId, "summary").success, true);
  }
}

function createWorker(db: Db, storage: MeetingRecordingStorageTypeAlias, overrides: Partial<WorkerDeps> = {}) {
  return new MeetingProcessingWorker({
    database: db,
    storage,
    isCaptureActive: () => false,
    transcribeRemote: async (_request: unknown, saveRaw: (response: unknown) => Promise<void>) => {
      await saveRaw({ text: "unused" });
      return { success: true, text: "unused" };
    },
    transcribeLocal: async () => ({ success: false, error: "unused" }),
    diarizeLocal: async () => [],
    summarize: async () => "Generated notes",
    getCredential: () => "test-key",
    mixAudio: async (recording: { id: string }, runId: string) => ({
      path: storage.getDerivedAudioPath(recording.id, runId),
      frameCount: 240_000,
      durationSeconds: 10,
      sizeBytes: 4096,
    }),
    fileSize: () => 4096,
    ...overrides,
  });
}

function floatBuffer(values: number[]) {
  const array = Float32Array.from(values);
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

test("the current run projects transcript and summary without replacing manual content", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { note, recording, initialRun } = createFinishedRecording(db, storage);
  attachArtifacts(db, storage, initialRun.id, {
    text: "First transcript",
    segments: [{ speaker: "speaker_0", text: "First transcript", start: 2.5, end: 4.25 }],
  }, { text: "First generated notes" });
  const projectedNoteIds: number[] = [];
  const worker = createWorker(db, storage, { onNoteProjectionChanged: (noteId) => projectedNoteIds.push(noteId) });
  t.after(() => worker.stop());

  assert.equal(worker.setSpeakerCorrection({
    runId: initialRun.id,
    speakerId: "speaker_0",
    profileId: null,
    displayName: "Ada Example",
  }), true);
  assert.equal(projectedNoteIds.at(-1), note.id, "the projection notifies existing Note consumers");
  assert.equal(db.getNote(note.id).content, "  Manual note stays.  ");
  assert.equal(db.getNote(note.id).enhanced_content, "First generated notes");
  const firstProjection = JSON.parse(db.getNote(note.id).transcript!);
  assert.equal(firstProjection[0].source, undefined, "mixed recording results do not claim a source track");
  assert.equal(firstProjection[0].timestamp, 2.5);
  assert.equal(firstProjection[0].endTimestamp, 4.25);
  assert.equal(firstProjection[0].speakerName, "Ada Example");
});

test("post-stop embeddings match only a known profile and leave unknown voices unnamed", async () => {
  const transcript: MeetingTranscriptArtifact = {
    text: "known unknown",
    segments: [
      { speaker: "speaker_0", text: "known", start: 0, end: 2 },
      { speaker: "speaker_1", text: "unknown", start: 4, end: 6 },
    ],
  };
  const knownVector = Float32Array.from([1, 0]);
  const unknownVector = Float32Array.from([0, 1]);
  const profileId = 23;
  let converted: { input: string; output: string; sampleRate: number; channels: number } | undefined;
  let removed = false;
  const result = await recognizeMeetingSpeakers(transcript, "/managed/derived.wav", new AbortController().signal, {
    speakerEmbeddings: {
      isAvailable: () => true,
      extractEmbedding: async (_path: string, start: number) => start === 0 ? knownVector : unknownVector,
      computeCentroid: (embeddings: Float32Array[]) => embeddings[0],
      cosineSimilarity: (left: Float32Array, right: Float32Array) => {
        const dot = left[0] * right[0] + left[1] * right[1];
        const normLeft = Math.hypot(left[0], left[1]);
        const normRight = Math.hypot(right[0], right[1]);
        return dot / (normLeft * normRight);
      },
    },
    getProfiles: () => [{ id: profileId, display_name: "Known voice", email: null, embedding: floatBuffer([1, 0]), sample_count: 1, created_at: "", updated_at: "" }],
    convertToWav: async (input: string, output: string, options: { sampleRate: number; channels: number; signal: AbortSignal }) => { converted = { input, output, ...options }; },
    createTempPath: () => "/temporary/meeting-speaker-test.wav",
    removeFile: () => { removed = true; },
  });
  assert.equal(converted!.input, "/managed/derived.wav");
  assert.equal(converted!.sampleRate, 16_000);
  assert.equal(converted!.channels, 1);
  assert.equal(removed, true);
  assert.deepEqual(result, [{ speakerId: "speaker_0", profileId, displayName: "Known voice" }]);
});

test("worker stores post-stop recognition per run and does not infer names from calendar/source metadata", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { note, recording, initialRun } = createFinishedRecording(db, storage, {
    sourceMetadata: { calendarAttendees: [{ name: "Calendar Guess" }], sourceMic: "Computer User" },
  });
  const knownProfileId = Number(db.db.prepare(
    "INSERT INTO speaker_profiles (display_name, embedding) VALUES (?, ?)"
  ).run("Known voice", floatBuffer([1, 0])).lastInsertRowid);
  const rawResponse = {
    text: "Known words. Unknown words.",
    words: [
      { type: "word", text: "Known words.", start: 0.2, end: 2.2, speaker_id: "speaker_0" },
      { type: "word", text: "Unknown words.", start: 4, end: 6, speaker_id: "speaker_1" },
    ],
  };
  let recognizeCalls = 0;
  const worker = createWorker(db, storage, {
    transcribeRemote: async (_request, saveRaw) => {
      await saveRaw(rawResponse);
      return { success: true, text: rawResponse.text };
    },
    recognizeSpeakers: async (recordingValue, run, transcript, audioPath, signal) => {
      recognizeCalls += 1;
      assert.equal(recordingValue.id, recording.id);
      assert.equal(audioPath, storage.getDerivedAudioPath(recording.id, run.id));
      const attendees = recordingValue.sourceMetadata.calendarAttendees as Array<{ name: string }>;
      assert.equal(attendees[0].name, "Calendar Guess");
      if (run.id !== initialRun.id) return [];
      return recognizeMeetingSpeakers(transcript, audioPath, signal, {
        speakerEmbeddings: {
          isAvailable: () => true,
          extractEmbedding: async (_path: string, start: number) => start < 3 ? Float32Array.from([1, 0]) : Float32Array.from([0, 1]),
          computeCentroid: (embeddings: Float32Array[]) => embeddings[0],
          cosineSimilarity: (left: Float32Array, right: Float32Array) => left[0] * right[0] + left[1] * right[1],
        },
        getProfiles: () => db.getSpeakerProfiles(true),
        convertToWav: async () => {},
        createTempPath: () => "/temporary/meeting-speaker-test.wav",
        removeFile: () => {},
      });
    },
  });
  t.after(() => worker.stop());

  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(recognizeCalls, 1);
  assert.deepEqual(db.getMeetingRunSpeakerCorrections(initialRun.id), [
    { speakerId: "Speaker 1", profileId: knownProfileId, displayName: "Known voice", source: "voice", revision: 1 },
  ]);
  const recognizedProjection = JSON.parse(db.getNote(note.id).transcript!);
  assert.equal(recognizedProjection[0].speakerName, "Known voice");
  assert.equal(recognizedProjection[1].speakerName, undefined, "calendar attendees and source mic label do not become identities");

  const secondRun = worker.createRun({ recordingId: recording.id, kind: "reprocess", config });
  await worker.waitForIdle();
  assert.equal(secondRun.run.kind, "reprocess");
  assert.deepEqual(db.getMeetingRunSpeakerCorrections(secondRun.run.id), [], "the new run must not inherit an old run correction");
});

test("source WAV exports keep epoch gaps; failed export and unavailable audio do not report success", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const root = getUserDataDir();
  const storage = new MeetingRecordingStorage({ userDataPath: root });
  const mic = { source: "mic" as const, startFrame: 0, samples: Buffer.from([1, 2, 3, 4]) };
  const system = { source: "system" as const, startFrame: 4, samples: Buffer.from([5, 6, 7, 8]) };
  // startedAt must be pinned: the fixture defaults startedAt to "now"
  // AFTER this object is built, so a plain new Date() here can land before
  // the start and make meetingTimelineFrameCount throw "timeline is invalid".
  // endedAt equals startedAt: capture end adds no frames and the WAV length
  // is exactly the epochs' 8 frames the byte assertions expect.
  const startedAt = new Date().toISOString();
  const { recording } = createFinishedRecording(db, storage, {
    sources: [mic, system],
    startedAt,
    endedAt: startedAt,
  });
  const epochs = db.listMeetingRecordingEpochs(recording.id);
  const micPath = path.join(root, "mic-export.wav");
  const systemPath = path.join(root, "system-export.wav");
  await exportMeetingSourceTrack(storage, recording, "mic", epochs, micPath);
  await exportMeetingSourceTrack(storage, recording, "system", epochs, systemPath);
  const micWav = fs.readFileSync(micPath);
  const systemWav = fs.readFileSync(systemPath);
  assert.equal(micWav.readUInt32LE(40), 12);
  assert.deepEqual(micWav.subarray(44, 48), mic.samples);
  assert.deepEqual(micWav.subarray(52, 56), Buffer.alloc(4));
  assert.deepEqual(systemWav.subarray(44, 52), Buffer.alloc(8));
  assert.deepEqual(systemWav.subarray(52, 56), system.samples);

  const copied = path.join(root, "copied.wav");
  await copyMeetingAudioExport(micPath, copied);
  assert.deepEqual(fs.readFileSync(copied), micWav);
  const unavailableIntent = db.beginMeetingAudioDeletion(recording.id);
  storage.removeRecordingAudio(recording.id);
  assert.equal(db.completeMeetingAudioDeletion(unavailableIntent.id).success, true);
  assert.equal(db.getMeetingRecording(recording.id).audioState, "deleted");
  await assert.rejects(exportMeetingSourceTrack(storage, recording, "mic", epochs, path.join(root, "unavailable.wav")));
  assert.equal(fs.existsSync(path.join(root, "unavailable.wav")), false);
  await assert.rejects(copyMeetingAudioExport(micPath, path.join(root, "missing-directory", "copy.wav")));
  assert.equal(fs.existsSync(path.join(root, "missing-directory")), false);
});

test("saved audio can be mixed and exported as MP3 before transcription", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const root = getUserDataDir();
  const storage = new MeetingRecordingStorage({ userDataPath: root });
  const { recording } = createFinishedRecording(db, storage);
  const mixed = await prepareMeetingAudio(storage, recording, recording.id, db.listMeetingRecordingEpochs(recording.id));
  const destination = path.join(root, "meeting.mp3");
  await exportMeetingMixedMp3(mixed.path, destination);
  const mp3 = fs.readFileSync(destination);
  assert.equal(mp3.subarray(0, 3).toString(), "ID3");
  assert.ok(mp3.length > 1000);
  assert.ok(fs.existsSync(mixed.path), "export leaves the source mix intact");
  await assert.rejects(exportMeetingMixedMp3(path.join(root, "missing.wav"), destination));
  assert.deepEqual(fs.readFileSync(destination), mp3, "failed conversion keeps the previous export");
});

test("source WAV export reads large epochs in bounded chunks without whole-file sample reads", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const root = getUserDataDir();
  const storage = new MeetingRecordingStorage({ userDataPath: root });
  const samples = Buffer.alloc(700 * 1024, 7);
  const { recording } = createFinishedRecording(db, storage, {
    sources: [{ source: "mic", startFrame: 13, samples }],
  });
  const epochs = db.listMeetingRecordingEpochs(recording.id);
  const destination = path.join(root, "bounded-export.wav");
  const openEpochReader = storage.openEpochReader.bind(storage);
  const readSizes: number[] = [];
  storage.readEpochSamples = () => { throw new Error("whole-file sample reads are forbidden"); };
  storage.openEpochReader = async (...args: Parameters<typeof storage.openEpochReader>) => {
    const reader = await openEpochReader(...args);
    const read = reader.read.bind(reader);
    reader.read = async (buffer: Buffer, offset: number, length: number, position: number | null) => {
      readSizes.push(length);
      return read(buffer, offset, length, position);
    };
    return reader;
  };

  await exportMeetingSourceTrack(storage, recording, "mic", epochs, destination);
  assert.ok(readSizes.length >= 3);
  assert.ok(Math.max(...readSizes) <= 256 * 1024);
  const wav = fs.readFileSync(destination);
  assert.equal(wav.readUInt32LE(40), (13 + samples.length / 2) * 2);
  assert.deepEqual(wav.subarray(44, 44 + 26), Buffer.alloc(26));
  assert.deepEqual(wav.subarray(44 + 26, 44 + 26 + 20), samples.subarray(0, 20));
});

test("source WAV export failure removes its temporary file and keeps an existing destination", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const root = getUserDataDir();
  const storage = new MeetingRecordingStorage({ userDataPath: root });
  const samples = Buffer.alloc(700 * 1024, 5);
  const { recording } = createFinishedRecording(db, storage, {
    sources: [{ source: "mic", startFrame: 0, samples }],
  });
  const epochs = db.listMeetingRecordingEpochs(recording.id);
  const destination = path.join(root, "failed-export.wav");
  fs.writeFileSync(destination, "keep existing export");
  const openEpochReader = storage.openEpochReader.bind(storage);
  storage.openEpochReader = async (...args: Parameters<typeof storage.openEpochReader>) => {
    const reader = await openEpochReader(...args);
    const read = reader.read.bind(reader);
    let reads = 0;
    reader.read = async (...readArgs: Parameters<typeof read>) => {
      reads += 1;
      if (reads === 2) throw new Error("injected read failure");
      return read(...readArgs);
    };
    return reader;
  };

  await assert.rejects(
    exportMeetingSourceTrack(storage, recording, "mic", epochs, destination),
    /injected read failure/
  );
  assert.equal(fs.readFileSync(destination, "utf8"), "keep existing export");
  assert.deepEqual(fs.readdirSync(root).filter((name: string) => name.startsWith(".failed-export.wav.") && name.endsWith(".tmp")), []);
});

test("mixed WAV export copies in bounded chunks", async (t: import("node:test").TestContext) => {
  const previousRoot = getUserDataDir();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-audio-export-"));
  setUserDataDir(root);
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    setUserDataDir(previousRoot);
  });
  const sourcePath = path.join(root, "large-mixed-source.wav");
  const destination = path.join(root, "large-mixed-copy.wav");
  t.after(() => {
    fs.rmSync(sourcePath, { force: true });
    fs.rmSync(destination, { force: true });
  });
  const contents = Buffer.alloc(700 * 1024, 3);
  fs.writeFileSync(sourcePath, contents);
  const originalOpen = fs.promises.open;
  const open = originalOpen.bind(fs.promises);
  const readSizes: number[] = [];
  fs.promises.open = async (filePath: Parameters<typeof originalOpen>[0], ...args: unknown[]) => {
    const handle = await (open as (...a: unknown[]) => ReturnType<typeof open>)(filePath, ...args);
    if (filePath === sourcePath) {
      const read = handle.read.bind(handle);
      handle.read = async (buffer: Buffer, offset: number, length: number, position: number | null) => {
        readSizes.push(length);
        return read(buffer, offset, length, position);
      };
    }
    return handle;
  };
  try {
    await copyMeetingAudioExport(sourcePath, destination);
  } finally {
    fs.promises.open = originalOpen;
  }
  assert.ok(readSizes.length >= 3);
  assert.ok(Math.max(...readSizes) <= 256 * 1024);
  assert.deepEqual(fs.readFileSync(destination), contents);
});

test("audio deletion aborts and waits for an active source export before removing its source", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const root = getUserDataDir();
  const storage = new MeetingRecordingStorage({ userDataPath: root });
  const samples = Buffer.alloc(700 * 1024, 9);
  const { recording } = createFinishedRecording(db, storage, {
    sources: [{ source: "mic", startFrame: 0, samples }],
  });
  const epochs = db.listMeetingRecordingEpochs(recording.id);
  const destination = path.join(root, "cancelled-export.wav");
  const openEpochReader = storage.openEpochReader.bind(storage);
  let readStarted!: () => void;
  const firstReadStarted = new Promise<void>((resolve) => { readStarted = resolve; });
  let signal!: AbortSignal;
  let paused = false;
  let readerPaused = false;
  storage.openEpochReader = async (...args: Parameters<typeof storage.openEpochReader>) => {
    const reader = await openEpochReader(...args);
    const read = reader.read.bind(reader);
    reader.read = async (...readArgs: Parameters<typeof read>) => {
      const result = await read(...readArgs);
      if (!paused) {
        paused = true;
        readerPaused = true;
        readStarted();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        readerPaused = false;
      }
      return result;
    };
    return reader;
  };
  const operations = createMeetingAudioOperationRegistry();
  const exportPromise = operations.run(recording.id, (operationSignal: AbortSignal) => {
    signal = operationSignal;
    return exportMeetingSourceTrack(storage, recording, "mic", epochs, destination, operationSignal);
  });
  const exportRejected = assert.rejects(exportPromise, /Aborted/);
  await firstReadStarted;
  const intent = db.beginMeetingAudioDeletion(recording.id);
  assert.ok(intent);
  let removed = false;
  await operations.cancelAndWait(recording.id).then(() => {
    assert.equal(readerPaused, false);
    storage.removeRecordingAudio(recording.id);
    assert.equal(db.completeMeetingAudioDeletion(intent.id).success, true);
    removed = true;
  });
  await exportRejected;
  assert.equal(removed, true);
  assert.equal(fs.existsSync(path.join(storage.recordingsRoot, recording.id)), false);
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(fs.readdirSync(root).filter((name: string) => name.startsWith(".cancelled-export.wav.") && name.endsWith(".tmp")), []);
});

test("a transcript-backed older run remains playable while a newer run is current", () => {
  const recording = {
    id: "00000000-0000-4000-8000-000000000001",
    audioState: "available",
    currentRunId: "00000000-0000-4000-8000-000000000003",
  };
  const olderTranscript = {
    recordingId: recording.id,
    hasTranscript: true,
  };

  assert.equal(canPlayMeetingRun(recording, olderTranscript), true);
  assert.equal(recording.currentRunId, "00000000-0000-4000-8000-000000000003");
  assert.equal(canPlayMeetingRun({ ...recording, audioState: "deleted" }, olderTranscript), false);
  assert.equal(canPlayMeetingRun(recording, { ...olderTranscript, recordingId: "00000000-0000-4000-8000-000000000004" }), false);
  assert.equal(canPlayMeetingRun(recording, { ...olderTranscript, hasTranscript: false }), false);
});
