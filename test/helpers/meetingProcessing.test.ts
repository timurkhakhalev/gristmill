const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs: typeof import("node:fs") = require("node:fs");
const test: typeof import("node:test") = require("node:test");
const { createDb } = require("./harness/db.ts");
const { getUserDataDir }: typeof import("./harness/electronStub.ts") = require("./harness/electronStub.ts");
const DatabaseManagerClass = (require("./harness/db.ts") as { DatabaseManager: new () => DatabaseManager }).DatabaseManager;
const MeetingRecordingStorage = require("../../src/helpers/meetingRecordingStorage.ts");
const { MeetingProcessingWorker, registerMeetingProcessingHandlers }: typeof import("../../src/helpers/meetingProcessing.ts") = require("../../src/helpers/meetingProcessing.ts");
const { meetingProcessingChannels }: typeof import("../../src/contracts/meetingProcessing.ts") = require("../../src/contracts/meetingProcessing.ts");
const { meetingTranscriptArtifactSchema }: typeof import("../../src/contracts/meetingRecording.ts") = require("../../src/contracts/meetingRecording.ts");
const { createMeetingProcessingBridge }: typeof import("../../src/preload/meetingProcessingBridge.ts") = require("../../src/preload/meetingProcessingBridge.ts");
const { prepareMeetingAudio }: typeof import("../../src/helpers/meetingAudioMixer.ts") = require("../../src/helpers/meetingAudioMixer.ts");
const { getFFmpegPath }: typeof import("../../src/helpers/ffmpegUtils.ts") = require("../../src/helpers/ffmpegUtils.ts");
import type { MeetingProcessingConfig } from "../../src/contracts/meetingRecording";
import type { MeetingProcessingWorkerDeps } from "../../src/helpers/meetingProcessing";
import type { MeetingRecordingStorage as RecordingStorage } from "../../src/helpers/meetingRecordingStorage";
import type { DatabaseManager } from "./harness/db";

type MixArgs = Parameters<NonNullable<MeetingProcessingWorkerDeps["mixAudio"]>>;

const validConfig = {
  transcription: {
    mode: "providers",
    provider: "elevenlabs",
    model: "scribe_v2",
    language: "en",
    credentialRef: "ELEVENLABS_API_KEY",
  },
  summary: {
    actionId: "notes.actions.builtin.detailedNotes",
    instruction: "Summarize the meeting accurately.",
    reasoningMode: "providers",
    provider: "openai",
    model: "gpt-4o-mini",
    credentialRef: "OPENAI_API_KEY",
  },
} satisfies MeetingProcessingConfig;

const elevenResponse = {
  text: "Hello.",
  words: [
    { type: "word", text: "Hello", start: 0.1, end: 0.4, speaker_id: "speaker_0" },
    { type: "word", text: ".", start: 0.4, end: 0.5, speaker_id: "speaker_0" },
  ],
};

function createFinishedRecording(
  db: DatabaseManager,
  storage: RecordingStorage,
  config: MeetingProcessingConfig | null = validConfig,
  noteText = "",
  keepGate = false,
  durationSeconds = 1,
) {
  const note = db.saveNote("Meeting", noteText, "meeting").note;
  assert.ok(note);
  const recording = db.createMeetingRecording(note.id, { config });
  db.createMeetingRecordingEpoch(recording.id, "mic", 0, 0);
  storage.openEpochWriter(recording.id, "mic", 0);
  storage.appendEpochSamples(recording.id, "mic", 0, Buffer.from([1, 2, 3, 4]));
  storage.closeEpochWriter(recording.id, "mic", 0);
  const recovered = storage.recoverEpoch(recording.id, "mic", 0);
  db.updateMeetingRecordingEpochRecovery(recording.id, "mic", 0, recovered);
  db.markMeetingRecordingFinalizing(recording.id);
  const finalized = db.finalizeMeetingRecording(recording.id, {
    captureState: "ready",
    endedAt: new Date(Date.parse(recording.startedAt) + durationSeconds * 1000).toISOString(),
  });
  if (!keepGate && finalized.initialRun.status === "pending") {
    db.setMeetingProcessingRunState(finalized.initialRun.id, { stage: "prepare", status: "pending", retryAt: null });
  }
  return {
    note,
    recording: finalized.recording,
    run: db.getMeetingProcessingRun(finalized.initialRun.id) as NonNullable<ReturnType<DatabaseManager["getMeetingProcessingRun"]>>,
  };
}

function longTranscriptResponse(length = 2500, prefix = "") {
  const text = `${prefix}${"x".repeat(Math.max(0, length - prefix.length))}`;
  return {
    text,
    words: [{ type: "word", text, start: 0.1, end: 0.5, speaker_id: "speaker_0" }],
  };
}

function parseSummaryInput(value: string): {
  meetingTitle: string | null;
  manualNotes: string;
  transcriptSegments: Array<{ id: string; speakerId: string | null; speakerName: string | null; text: string }>;
} {
  return JSON.parse(value);
}

function saveTranscriptArtifact(
  db: DatabaseManager,
  storage: RecordingStorage,
  runId: string,
  text: string,
  speaker = "speaker_0",
) {
  if (!db.getMeetingProcessingRun(runId)?.hasRawProviderResponse) {
    storage.writeRunArtifact(runId, "provider-response", { text });
    assert.equal(db.setMeetingRunArtifact(runId, "provider-response").success, true);
  }
  storage.writeRunArtifact(runId, "transcript", {
    text,
    diarized: true,
    segments: [{ speaker, text, start: 0, end: 0.5 }],
  });
  assert.equal(db.setMeetingRunArtifact(runId, "transcript").success, true);
}

function workerFor(db: DatabaseManager, storage: RecordingStorage, overrides: Partial<MeetingProcessingWorkerDeps> = {}) {
  const deps: MeetingProcessingWorkerDeps = {
    database: db,
    storage,
    isCaptureActive: () => false,
    transcribeRemote: async (_request, saveRaw) => {
      await saveRaw(elevenResponse);
      return { success: true, text: "parsed by adapter" };
    },
    transcribeLocal: async () => ({ success: false, error: "Local model unavailable" }),
    diarizeLocal: async () => [],
    summarize: async () => "## Summary\n- A useful result.",
    getCredential: () => "test-key",
    mixAudio: async (recording, runId) => ({
      path: storage.getDerivedAudioPath(recording.id, runId),
      frameCount: 24_000,
      durationSeconds: 1,
      sizeBytes: 4096,
    }),
    fileSize: () => 4096,
    ...overrides,
  };
  return new MeetingProcessingWorker(deps);
}

test("audio parts from separate sessions of one note produce one persisted run and one transcription request", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const first = createFinishedRecording(db, storage, validConfig, "Manual notes stay here.");
  assert.ok(first.recording.endedAt);
  const second = db.createMeetingRecording(first.note.id, { config: validConfig },
    new Date(Date.parse(first.recording.endedAt) + 5 * 60_000).toISOString());
  assert.notEqual(second.groupId, first.recording.groupId);
  db.createMeetingRecordingEpoch(second.id, "system", 0, 0);
  storage.openEpochWriter(second.id, "system", 0);
  storage.appendEpochSamples(second.id, "system", 0, Buffer.from([1, 2, 3, 4]));
  storage.closeEpochWriter(second.id, "system", 0);
  db.updateMeetingRecordingEpochRecovery(second.id, "system", 0, storage.recoverEpoch(second.id, "system", 0));
  db.markMeetingRecordingFinalizing(second.id);
  const finalSecond = db.finalizeMeetingRecording(second.id, {
    captureState: "ready", endedAt: new Date(Date.parse(second.startedAt) + 1000).toISOString(),
  });
  let asrCalls = 0;
  let mixed: { recording: MixArgs[0]; epochs: MixArgs[2] } | undefined;
  const worker = workerFor(db, storage, {
    mixAudio: async (recording, runId, epochs) => {
      mixed = { recording, epochs };
      return { path: storage.getDerivedAudioPath(recording.id, runId), frameCount: 48_000, durationSeconds: 2, sizeBytes: 4096 };
    },
    transcribeRemote: async (_request: unknown, saveRaw) => {
      asrCalls++;
      await saveRaw(elevenResponse);
      return { success: true, text: "Hello." };
    },
  });
  t.after(() => worker.stop());
  assert.equal(worker.cancelRun(first.run.id), true);
  assert.equal(worker.cancelRun(finalSecond.initialRun.id), true);
  const run = db.createMeetingProcessingRun(first.recording.id, {
    kind: "reprocess", sourceRecordingIds: [first.recording.id, second.id], config: validConfig,
  });
  assert.deepEqual(db.getMeetingProcessingRun(run.id).sourceRecordingIds, [first.recording.id, second.id]);
  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(asrCalls, 1);
  assert.ok(mixed);
  assert.equal(mixed.recording.endedAt, new Date(Date.parse(first.recording.startedAt) + 2000).toISOString());
  assert.deepEqual(mixed.epochs.map((epoch) => epoch.recordingId), [first.recording.id, second.id]);
  assert.equal(db.getNote(first.note.id).content, "Manual notes stay here.");
  assert.equal(db.getMeetingProcessingRun(run.id).status, "complete");
});

test("combined transcription cannot include audio from another note", (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const first = createFinishedRecording(db, storage);
  const other = createFinishedRecording(db, storage);
  assert.throws(() => db.createMeetingProcessingRun(first.recording.id, {
    kind: "reprocess", sourceRecordingIds: [first.recording.id, other.recording.id], config: validConfig,
  }), /Meeting audio is unavailable for a selected part/);
});

test("waits for retention and capture to finish, then persists the response, transcript, and separate summary", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { note, recording, run } = createFinishedRecording(db, storage, validConfig, "  Manual note first.  \n", false, 180);
  let capturing = true;
  let transcribeCalls = 0;
  let summaryInput = "";
  const worker = workerFor(db, storage, {
    isCaptureActive: () => capturing,
    transcribeRemote: async (request, saveRaw) => {
      transcribeCalls += 1;
      assert.equal(request.provider, "elevenlabs");
      assert.equal(request.model, "scribe_v2");
      assert.equal(request.diarize, true);
      assert.equal(request.transcriptionMode, "providers");
      assert.equal(request.apiKey, "test-key");
      await saveRaw(longTranscriptResponse());
      return { success: true, text: "ignored adapter projection" };
    },
    summarize: async (input) => {
      summaryInput = input;
      return "## Summary\n- A useful result.";
    },
  });
  t.after(() => worker.stop());

  await worker.waitForIdle();
  assert.equal(transcribeCalls, 0, "a queued run waits until retention is ready");
  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(transcribeCalls, 0, "a queued run cannot start before capture stops");
  capturing = false;
  worker.captureStopped();
  await worker.waitForIdle();

  const savedRun = db.getMeetingProcessingRun(run.id);
  assert.equal(savedRun.status, "complete");
  assert.equal(savedRun.hasRawProviderResponse, true);
  assert.equal(savedRun.hasTranscript, true);
  assert.equal(savedRun.hasSummary, true);
  assert.equal(storage.readRunArtifact(run.id, "provider-response").text.length, 2500);
  assert.equal(storage.readRunArtifact(run.id, "transcript").segments[0].text.length, 2500);
  assert.deepEqual(parseSummaryInput(summaryInput), {
    meetingTitle: note.title,
    manualNotes: "  Manual note first.  \n",
    transcriptSegments: [{
      id: `${run.id}:0`, speakerId: "Speaker 1", speakerName: null, text: "x".repeat(2500),
    }],
  });
  const summaryArtifact = storage.readRunArtifact(run.id, "summary");
  assert.equal(summaryArtifact.text, "## Summary\n- A useful result.");
  assert.equal(summaryArtifact.speakerCorrectionRevision, 0);
  assert.match(summaryArtifact.manualNoteRevision, /^[a-f0-9]{64}$/);
  const savedSnapshot = JSON.parse(db.getMeetingRunLlmSourceSnapshot(run.id));
  assert.equal(savedSnapshot.sourceRunId, run.id);
  assert.deepEqual(savedSnapshot.sourceRecordingIds, [recording.id]);
  assert.equal(savedSnapshot.manualNoteRevision, summaryArtifact.manualNoteRevision);
  assert.equal(savedSnapshot.promptModel.instruction, validConfig.summary.instruction);
  const savedNote = db.getNote(note.id);
  assert.ok(savedNote);
  assert.equal(savedNote.content, "  Manual note first.  \n");
  assert.equal(db.getMeetingRecording(recording.id).captureState, "ready");
  assert.equal(transcribeCalls, 1);
});

test("finalized initial run waits until the persisted 15-second deadline across restart and manual reprocess requests", async (t: import("node:test").TestContext) => {
  let db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { recording, run } = createFinishedRecording(db, storage, validConfig, "", true);
  assert.ok(run.retryAt);
  const deadline = Date.parse(run.retryAt);
  const now = new Date(deadline - 15_000);
  db.db.close();
  db = new DatabaseManagerClass();
  t.after(() => db.db.close());
  const timerDelays: number[] = [];
  let transcribeCalls = 0;
  const worker = workerFor(db, storage, {
    now: () => new Date(now),
    setTimeout: ((_callback: unknown, milliseconds: unknown) => {
      timerDelays.push(Number(milliseconds));
      return timerDelays.length;
    }) as unknown as typeof setTimeout,
    clearTimeout: () => {},
    transcribeRemote: async (_request, saveRaw) => {
      transcribeCalls += 1;
      await saveRaw(elevenResponse);
      return { success: true, text: "Hello." };
    },
  });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(transcribeCalls, 0);
  assert.equal(timerDelays.at(-1), 15_000);

  const manual = worker.createRun({ recordingId: recording.id, kind: "reprocess", config: validConfig });
  assert.equal(manual.run.id, run.id, "manual ASR reuses the pending gated run");
  now.setTime(deadline - 1);
  worker.processPending();
  await worker.waitForIdle();
  assert.equal(transcribeCalls, 0, "14.999 seconds is still inside the gate");

  now.setTime(deadline);
  worker.processPending();
  await worker.waitForIdle();
  assert.equal(transcribeCalls, 1, "ASR can start at 15 seconds");
});

test("resume cancels the pending group version and the next end starts a fresh gate", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { recording, run } = createFinishedRecording(db, storage, validConfig, "", true);
  assert.ok(run.retryAt);
  const now = new Date(Date.parse(run.retryAt) - 5000);
  const worker = workerFor(db, storage, {
    now: () => new Date(now),
    setTimeout: (() => 1) as unknown as typeof setTimeout,
    clearTimeout: () => {},
  });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(run.id).status, "pending");
  worker.captureStarted(recording.groupId);
  assert.equal(db.getMeetingProcessingRun(run.id).status, "cancelled");
  assert.equal(db.getMeetingProcessingRun(run.id).errorCode, "meeting-resumed");

  worker.captureStopped();
  now.setTime(Date.parse(run.retryAt) + 5000);
  const nextEnd = worker.createRun({
    recordingId: recording.id,
    sourceRecordingIds: [recording.id],
    kind: "reprocess",
    gateAfterStop: true,
    config: validConfig,
  });
  assert.ok(nextEnd.run.retryAt);
  const freshDeadline = Date.parse(nextEnd.run.retryAt);
  assert.equal(freshDeadline, now.getTime() + 15_000);
  assert.notEqual(nextEnd.run.id, run.id);
  const duplicate = worker.createRun({
    recordingId: recording.id,
    sourceRecordingIds: [recording.id],
    kind: "reprocess",
    gateAfterStop: true,
    config: validConfig,
  });
  assert.equal(duplicate.run.id, nextEnd.run.id);
});

test("OpenAI meeting route persists diarized raw response and finishes transcription", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const config: MeetingProcessingConfig = {
    transcription: {
      mode: "providers",
      provider: "openai",
      model: "gpt-4o-mini-transcribe",
      language: "auto",
      credentialRef: "OPENAI_API_KEY",
    },
    summary: validConfig.summary,
  };
  const { run } = createFinishedRecording(db, storage, config);
  const raw = {
    text: "Hello.",
    segments: [{ type: "transcript.text.segment", speaker: "A", text: "Hello.", start: 0.1, end: 0.5 }],
  };
  const worker = workerFor(db, storage, {
    transcribeRemote: async (request, saveRaw) => {
      assert.equal(request.provider, "openai");
      assert.equal(request.model, "gpt-4o-mini-transcribe");
      assert.equal(request.diarize, true);
      await saveRaw(raw);
      return { success: true, text: "parsed by adapter" };
    },
  });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();

  const saved = db.getMeetingProcessingRun(run.id);
  assert.equal(saved.status, "complete", JSON.stringify({ stage: saved.stage, errorCode: saved.errorCode }));
  assert.equal(saved.hasRawProviderResponse, true);
  assert.equal(saved.hasTranscript, true);
  assert.deepEqual(storage.readRunArtifact(run.id, "provider-response"), raw);
  assert.deepEqual(storage.readRunArtifact(run.id, "transcript").segments, [
    { speaker: "A", text: "Hello.", start: 0.1, end: 0.5 },
  ]);
});

test("OpenAI text without speaker segments remains visible as a failed run", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage, {
    transcription: { mode: "providers", provider: "openai", model: "gpt-4o-mini-transcribe", language: "auto" },
    summary: validConfig.summary,
  });
  const raw = { text: "Speech was recognized.", segments: [] };
  const worker = workerFor(db, storage, {
    transcribeRemote: async (_request: unknown, saveRaw) => {
      await saveRaw(raw);
      return { success: true, text: raw.text };
    },
  });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();

  const saved = db.getMeetingProcessingRun(run.id);
  assert.equal(saved.status, "failed");
  assert.equal(saved.stage, "normalize");
  assert.equal(saved.errorCode, "provider-diarization-missing");
  assert.deepEqual(storage.readRunArtifact(run.id, "provider-response"), raw);
});

test("a bad provider response stays saved and retry re-enters normalize without another ASR request", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage);
  let transcribeCalls = 0;
  const worker = workerFor(db, storage, {
    transcribeRemote: async (_request: unknown, saveRaw) => {
      transcribeCalls += 1;
      await saveRaw({ malformed: true });
      return { success: true, text: "the parser result is ignored" };
    },
  });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();

  assert.equal(db.getMeetingProcessingRun(run.id).status, "failed");
  assert.equal(db.getMeetingProcessingRun(run.id).stage, "normalize");
  assert.deepEqual(storage.readRunArtifact(run.id, "provider-response"), { malformed: true });
  assert.equal(db.getMeetingProcessingRun(run.id).hasRawProviderResponse, true);
  worker.retry(run.id);
  await worker.waitForIdle();
  assert.equal(transcribeCalls, 1);
  assert.equal(db.getMeetingProcessingRun(run.id).stage, "normalize");
  assert.deepEqual(storage.readRunArtifact(run.id, "provider-response"), { malformed: true });
});

test("a valid empty transcript completes without generating a summary", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage);
  let summaryCalls = 0;
  const worker = workerFor(db, storage, {
    transcribeRemote: async (_request: unknown, saveRaw) => {
      await saveRaw({ text: "" });
      return { success: true, text: "" };
    },
    summarize: async () => {
      summaryCalls += 1;
      return "fabricated";
    },
  });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();

  assert.equal(db.getMeetingProcessingRun(run.id).status, "complete");
  assert.equal(db.getMeetingProcessingRun(run.id).hasTranscript, true);
  assert.equal(storage.readRunArtifact(run.id, "transcript").text, "");
  assert.equal(db.getMeetingProcessingRun(run.id).hasSummary, false);
  assert.equal(summaryCalls, 0);
});

test("a nonempty transcript stays blocked when its saved run has no summary config", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const noSummaryConfig = { ...validConfig, summary: null };
  const { run } = createFinishedRecording(db, storage, noSummaryConfig);
  let summaryCalls = 0;
  const worker = workerFor(db, storage, {
    summarize: async () => {
      summaryCalls += 1;
      return "unexpected summary";
    },
  });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();

  const saved = db.getMeetingProcessingRun(run.id);
  assert.equal(saved.status, "blocked");
  assert.equal(saved.stage, "summary");
  assert.equal(saved.errorCode, "missing-summary-config");
  assert.equal(saved.hasTranscript, true);
  assert.match(storage.readRunArtifact(run.id, "transcript").text, /Hello\./);
  assert.equal(saved.hasSummary, false);
  assert.equal(summaryCalls, 0);
});

test("IPC corrects only a blocked run snapshot after main validation; ordinary retry keeps it", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage, null);
  assert.ok(run.retryAt);
  const deadlineNow = new Date(run.retryAt);
  let apiKey = "";
  const worker = workerFor(db, storage, { getCredential: () => apiKey, now: () => new Date(deadlineNow) });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(run.id).status, "blocked");
  assert.equal(db.getMeetingProcessingRun(run.id).config, null);

  const handlers = new Map();
  registerMeetingProcessingHandlers({ handle: (channel: string, handler: unknown) => handlers.set(channel, handler) }, worker);
  const update = handlers.get(meetingProcessingChannels.updateBlockedRunConfig);
  const invalid = await update(null, {
    runId: run.id,
    config: {
      ...validConfig,
      transcription: { ...validConfig.transcription, credentialRef: "raw-secret-value" },
    },
    configError: null,
  });
  assert.equal(invalid.success, false, "main IPC rejects secret values in credential references");
  assert.equal(db.getMeetingProcessingRun(run.id).config, null);

  const corrected = await update(null, { runId: run.id, config: validConfig, configError: null });
  assert.equal(corrected.success, true);
  assert.equal(corrected.result.run.status, "pending");
  await worker.waitForIdle();
  const blockedWithSnapshot = db.getMeetingProcessingRun(run.id);
  assert.equal(blockedWithSnapshot.status, "blocked", "the corrected route remains blocked until its key is available");
  assert.deepEqual(blockedWithSnapshot.config, validConfig);

  apiKey = "now-available";
  const retried = await handlers.get(meetingProcessingChannels.retryRun)(null, { runId: run.id });
  assert.equal(retried.success, true);
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(run.id).status, "complete");
  assert.deepEqual(db.getMeetingProcessingRun(run.id).config, validConfig);
});

test("main corrects summary-only configuration and resumes from saved artifacts without another ASR call", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const savedConfig = { ...validConfig, summary: null };
  const { run } = createFinishedRecording(db, storage, savedConfig, "", false, 180);
  let transcribeCalls = 0;
  let summaryCalls = 0;
  const worker = workerFor(db, storage, {
    transcribeRemote: async (_request: unknown, saveRaw) => {
      transcribeCalls += 1;
      await saveRaw(longTranscriptResponse());
      return { success: true, text: "adapter output is not the saved source" };
    },
    summarize: async () => {
      summaryCalls += 1;
      return "Recovered summary";
    },
  });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();

  const blocked = db.getMeetingProcessingRun(run.id);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.stage, "summary");
  assert.equal(blocked.errorCode, "missing-summary-config");
  const rawBefore = storage.readRunArtifact(run.id, "provider-response");
  const transcriptBefore = storage.readRunArtifact(run.id, "transcript");
  assert.equal(transcribeCalls, 1);
  assert.equal(summaryCalls, 0);

  const handlers = new Map();
  registerMeetingProcessingHandlers({ handle: (channel: string, handler: unknown) => handlers.set(channel, handler) }, worker);
  const update = handlers.get(meetingProcessingChannels.updateBlockedRunConfig);
  const changedTranscription = {
    ...savedConfig,
    transcription: {
      ...savedConfig.transcription,
      provider: "deepgram",
      model: "nova-3",
      credentialRef: "DEEPGRAM_API_KEY",
    },
    summary: validConfig.summary,
  };
  assert.equal((await update(null, { runId: run.id, config: changedTranscription, configError: null })).success, false);
  assert.equal(db.getMeetingProcessingRun(run.id).status, "blocked");
  assert.deepEqual(storage.readRunArtifact(run.id, "provider-response"), rawBefore);
  assert.deepEqual(storage.readRunArtifact(run.id, "transcript"), transcriptBefore);

  const corrected = { ...savedConfig, summary: validConfig.summary };
  const response = await update(null, { runId: run.id, config: corrected, configError: null });
  assert.equal(response.success, true);
  await worker.waitForIdle();

  const completed = db.getMeetingProcessingRun(run.id);
  assert.equal(completed.status, "complete");
  assert.deepEqual(completed.config.transcription, savedConfig.transcription);
  assert.deepEqual(completed.config.summary, validConfig.summary);
  assert.deepEqual(storage.readRunArtifact(run.id, "provider-response"), rawBefore);
  assert.deepEqual(storage.readRunArtifact(run.id, "transcript"), transcriptBefore);
  assert.equal(storage.readRunArtifact(run.id, "summary").text, "Recovered summary");
  assert.equal(transcribeCalls, 1);
  assert.equal(summaryCalls, 1);
});

test("viewing old transcript leaves a pending current run and Note projection intact until explicit selection", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { note, recording, run: oldRun } = createFinishedRecording(db, storage, validConfig, "Manual note stays.", false, 180);
  let response = longTranscriptResponse(2500, "Old saved transcript ");
  let transcribeCalls = 0;
  let summaryCalls = 0;
  const worker = workerFor(db, storage, {
    transcribeRemote: async (_request: unknown, saveRaw) => {
      transcribeCalls += 1;
      await saveRaw(response);
      return { success: true, text: "ignored adapter projection" };
    },
    summarize: async () => {
      summaryCalls += 1;
      return "Summary from old run";
    },
  });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();
  const oldProjection = db.getNote(note.id);
  assert.ok(oldProjection);
  assert.match(oldProjection.transcript, /Old saved transcript/);
  assert.match(oldProjection.enhanced_content, /Summary from old run/);
  assert.equal(db.getMeetingRecording(recording.id).currentRunId, oldRun.id);

  const pendingRun = db.createMeetingProcessingRun(recording.id, {
    kind: "reprocess",
    config: validConfig,
    configError: null,
    sourceRunId: null,
  });
  const pendingProjection = db.getNote(note.id);
  assert.ok(pendingProjection);
  assert.equal(pendingRun.status, "pending");
  assert.equal(pendingRun.hasTranscript, false);
  assert.equal(db.getMeetingRecording(recording.id).currentRunId, pendingRun.id);
  assert.deepEqual({
    content: pendingProjection.content,
    transcript: pendingProjection.transcript,
    enhancedContent: pendingProjection.enhanced_content,
    enhancementPrompt: pendingProjection.enhancement_prompt,
  }, {
    content: oldProjection.content,
    transcript: oldProjection.transcript,
    enhancedContent: oldProjection.enhanced_content,
    enhancementPrompt: oldProjection.enhancement_prompt,
  }, "creating or viewing the pending version does not rewrite the existing Note projection");

  worker.stop();
  response = longTranscriptResponse(2500, "New saved transcript ");
  const resumedWorker = workerFor(db, storage, {
    transcribeRemote: async (_request: unknown, saveRaw) => {
      transcribeCalls += 1;
      await saveRaw(response);
      return { success: true, text: "ignored adapter projection" };
    },
    summarize: async () => "Summary from new run",
  });
  t.after(() => resumedWorker.stop());
  resumedWorker.onRetentionReady();
  await resumedWorker.waitForIdle();

  const newProjection = db.getNote(note.id);
  assert.ok(newProjection);
  assert.equal(transcribeCalls, 2);
  assert.equal(db.getMeetingProcessingRun(pendingRun.id).status, "complete");
  assert.equal(db.getMeetingRecording(recording.id).currentRunId, pendingRun.id);
  assert.match(newProjection.transcript, /New saved transcript/);
  assert.equal(newProjection.enhanced_content, null, "an existing meeting Summary prevents a second automatic Summary");
  assert.equal(newProjection.content, oldProjection.content);
  assert.equal(summaryCalls, 1);

  assert.ok(db.getMeetingProcessingRun(oldRun.id), "prior processing runs remain available");
  assert.equal(storage.hasRunArtifact(oldRun.id, "transcript"), true);
  assert.equal(storage.hasRunArtifact(oldRun.id, "summary"), true);
});

test("blocked config correction refuses an unindexed raw response file", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage, null);
  storage.writeRunArtifact(run.id, "provider-response", { text: "already saved" });
  const worker = workerFor(db, storage);
  t.after(() => worker.stop());
  const handlers = new Map();
  registerMeetingProcessingHandlers({ handle: (channel: string, handler: unknown) => handlers.set(channel, handler) }, worker);

  const result = await handlers.get(meetingProcessingChannels.updateBlockedRunConfig)(null, {
    runId: run.id,
    config: validConfig,
    configError: null,
  });
  assert.equal(result.success, false);
  assert.equal(db.getMeetingProcessingRun(run.id).config, null);
  assert.equal(storage.hasRunArtifact(run.id, "provider-response"), true);
});

test("preload validates blocked-run config correction before invoking main", async () => {
  const calls: unknown[] = [];
  const bridge = createMeetingProcessingBridge({
      invoke: async (...args: unknown[]) => {
      calls.push(args);
      return { success: false, error: "rejected" };
    },
    on() {},
    removeListener() {},
  });
  assert.throws(() => bridge.meetingProcessingUpdateBlockedRunConfig({
    runId: "00000000-0000-4000-8000-000000000001",
    config: {
      ...validConfig,
      transcription: { ...validConfig.transcription, credentialRef: "secret-value" },
    },
    configError: null,
  }));
  assert.equal(calls.length, 0);

  const response = await bridge.meetingProcessingUpdateBlockedRunConfig({
    runId: "00000000-0000-4000-8000-000000000001",
    config: validConfig,
    configError: null,
  });
  assert.deepEqual(calls, [[meetingProcessingChannels.updateBlockedRunConfig, {
    runId: "00000000-0000-4000-8000-000000000001",
    config: validConfig,
    configError: null,
  }]]);
  assert.deepEqual(response, { success: false, error: "rejected" });
});

test("automatic Summary uses inclusive duration and spoken-text thresholds", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const cases = [
    { duration: 179, characters: 2500, eligible: false },
    { duration: 180, characters: 2499, eligible: false },
    { duration: 180, characters: 2500, eligible: true },
  ];
  const responseByRequest = new Map<string, ReturnType<typeof longTranscriptResponse>>();
  const runs = cases.map((item) => {
    const { recording, run } = createFinishedRecording(db, storage, validConfig, "", false, item.duration);
    responseByRequest.set(`meeting-${run.id}`, longTranscriptResponse(item.characters));
    return { ...item, recording, run };
  });
  const summarizedInputs: string[] = [];
  const worker = workerFor(db, storage, {
    transcribeRemote: async (request: { requestId?: string }, saveRaw) => {
      assert.ok(request.requestId);
      const response = responseByRequest.get(request.requestId);
      assert.ok(response);
      await saveRaw(response);
      return { success: true };
    },
    summarize: async (input) => {
      summarizedInputs.push(input);
      return "## TLDR\nA grounded result.";
    },
  });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();

  assert.deepEqual(runs.map(({ run }) => db.getMeetingProcessingRun(run.id).hasSummary), [false, false, true]);
  assert.deepEqual(summarizedInputs.map((input) => parseSummaryInput(input).transcriptSegments[0].text.length), [2500]);
  assert.ok(runs.every(({ run }) => db.getMeetingProcessingRun(run.id).status === "complete"));
});

test("manual Summary bypasses the auto threshold, cancels a pending auto request, and coalesces duplicates", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const short = createFinishedRecording(db, storage, validConfig, "User notes remain unchanged.");
  saveTranscriptArtifact(db, storage, short.run.id, "Short transcript");
  db.setMeetingProcessingRunState(short.run.id, { stage: "summary", status: "cancelled" });

  const eligible = createFinishedRecording(db, storage, validConfig, "Other notes.", false, 180);
  saveTranscriptArtifact(db, storage, eligible.run.id, "e".repeat(2500));
  db.setMeetingProcessingRunState(eligible.run.id, { stage: "summary", status: "pending" });

  const summarizedInputs: string[] = [];
  const worker = workerFor(db, storage, {
    summarize: async (input) => {
      summarizedInputs.push(input);
      return "## TLDR\nManual result.";
    },
  });
  t.after(() => worker.stop());
  const manualShort = worker.createRun({ recordingId: short.recording.id, kind: "summary", sourceRunId: short.run.id, config: validConfig });
  const firstEligibleManual = worker.createRun({ recordingId: eligible.recording.id, kind: "summary", sourceRunId: eligible.run.id, config: validConfig });
  const duplicateEligibleManual = worker.createRun({ recordingId: eligible.recording.id, kind: "summary", sourceRunId: eligible.run.id, config: validConfig });
  assert.equal(duplicateEligibleManual.run.id, firstEligibleManual.run.id);
  assert.equal(db.getMeetingProcessingRun(eligible.run.id).status, "cancelled");

  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(manualShort.run.id).hasSummary, true);
  assert.equal(db.getMeetingProcessingRun(firstEligibleManual.run.id).hasSummary, true);
  assert.equal(summarizedInputs.length, 2);
  assert.deepEqual(summarizedInputs.map((input) => parseSummaryInput(input).manualNotes), ["User notes remain unchanged.", "Other notes."]);
  assert.equal(db.getNote(short.note.id).content, "User notes remain unchanged.");
});

test("speaker naming snapshots calendar candidates and a late user correction wins", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { note, recording, run: sourceRun } = createFinishedRecording(db, storage, validConfig, "Manual note evidence.");
  db.db.prepare("UPDATE notes SET participants = ? WHERE id = ?").run(JSON.stringify([
    { displayName: "Calendar Alice", email: "alice@example.com" },
    { displayName: "bob@example.com", email: "bob@example.com" },
  ]), note.id);
  storage.writeRunArtifact(sourceRun.id, "provider-response", { text: "Transcript with two speakers." });
  assert.equal(db.setMeetingRunArtifact(sourceRun.id, "provider-response").success, true);
  storage.writeRunArtifact(sourceRun.id, "transcript", {
    text: "Transcript with two speakers.",
    diarized: true,
    segments: [
      { speaker: "speaker_a", text: "I am Alice and I will check the release.", start: 0, end: 1 },
      { speaker: "speaker_b", text: "I agree with Alice.", start: 1, end: 2 },
    ],
  });
  assert.equal(db.setMeetingRunArtifact(sourceRun.id, "transcript").success, true);
  db.setMeetingProcessingRunState(sourceRun.id, { stage: "summary", status: "cancelled" });

  let namingInput: unknown;
  let summaryInput = "";
  const worker = workerFor(db, storage, {
    nameSpeakers: async (input, _config, run) => {
      namingInput = input;
      assert.equal(run.kind, "summary");
      assert.equal(db.setMeetingRunSpeakerCorrection(sourceRun.id, "speaker_a", null, "User correction", "user").success, true);
      return [
        { speakerId: "speaker_a", name: "Model Alice" },
        { speakerId: "speaker_b", name: "Model Bob" },
      ];
    },
    summarize: async (input) => {
      summaryInput = input;
      return "## TLDR\nSpeakers are labeled from the transcript.";
    },
  });
  t.after(() => worker.stop());
  const manual = worker.createRun({ recordingId: recording.id, kind: "summary", sourceRunId: sourceRun.id, config: validConfig });
  worker.onRetentionReady();
  await worker.waitForIdle();

  assert.deepEqual(namingInput, {
    meetingTitle: "Meeting",
    participants: [
      { name: "Calendar Alice", email: "alice@example.com" },
      { name: null, email: "bob@example.com" },
    ],
    segments: [
      { id: `${sourceRun.id}:0`, speakerId: "speaker_a", speakerName: null, text: "I am Alice and I will check the release." },
      { id: `${sourceRun.id}:1`, speakerId: "speaker_b", speakerName: null, text: "I agree with Alice." },
    ],
  });
  assert.deepEqual(parseSummaryInput(summaryInput), {
    meetingTitle: "Meeting",
    manualNotes: "Manual note evidence.",
    transcriptSegments: [
      { id: `${sourceRun.id}:0`, speakerId: "speaker_a", speakerName: "User correction", text: "I am Alice and I will check the release." },
      { id: `${sourceRun.id}:1`, speakerId: "speaker_b", speakerName: null, text: "I agree with Alice." },
    ],
  });
  assert.deepEqual(db.getMeetingRunSpeakerCorrections(sourceRun.id), [{
    speakerId: "speaker_a", profileId: null, displayName: "User correction", source: "user", revision: 1,
  }]);
  const summary = storage.readRunArtifact(manual.run.id, "summary");
  assert.equal(summary.speakerCorrectionRevision, 1);
  assert.doesNotMatch(JSON.stringify(parseSummaryInput(summaryInput)), /@/);
  assert.equal(db.getMeetingRecording(recording.id).currentRunId, manual.run.id);
});

test("validated speaker names persist model provenance and both Summary stages use corrected labels", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { note, recording, run: sourceRun } = createFinishedRecording(db, storage, validConfig, "Notes stay here.");
  saveTranscriptArtifact(db, storage, sourceRun.id, "Alice introduces herself.", "speaker_0");
  db.setMeetingProcessingRunState(sourceRun.id, { stage: "summary", status: "cancelled" });
  const namingInputs: unknown[] = [];
  let summaryInput = "";
  const worker = workerFor(db, storage, {
    nameSpeakers: async (input) => {
      namingInputs.push(input);
      return [{ speakerId: "speaker_0", name: "Alice" }];
    },
    summarize: async (input) => {
      summaryInput = input;
      return "## TLDR\nAlice described the release.";
    },
  });
  t.after(() => worker.stop());
  const manual = worker.createRun({ recordingId: recording.id, kind: "summary", sourceRunId: sourceRun.id, config: validConfig });
  worker.onRetentionReady();
  await worker.waitForIdle();

  assert.equal(namingInputs.length, 1);
  assert.deepEqual(parseSummaryInput(summaryInput).transcriptSegments, [{
    id: `${sourceRun.id}:0`, speakerId: "speaker_0", speakerName: "Alice", text: "Alice introduces herself.",
  }]);
  assert.deepEqual(db.getMeetingRunSpeakerCorrections(sourceRun.id), [{
    speakerId: "speaker_0", profileId: null, displayName: "Alice", source: "model", revision: 1,
  }]);
  assert.equal(db.getMeetingRunSpeakerCorrectionRevision(sourceRun.id), 1);
  const result = worker.listForNote(note.id)[0].runs.find((item) => item.run.id === manual.run.id);
  assert.ok(result);
  assert.ok(result.summary);
  assert.equal(result.speakerCorrections[0].source, "model");
  assert.equal(result.summary.speakerCorrectionRevision, 1);
  worker.stop();
  db.db.close();
  const reopened = new DatabaseManagerClass();
  try {
    assert.deepEqual(reopened.getMeetingRunSpeakerCorrections(sourceRun.id), [{
      speakerId: "speaker_0", profileId: null, displayName: "Alice", source: "model", revision: 1,
    }]);
    const savedSnapshot = reopened.getMeetingRunLlmSourceSnapshot(manual.run.id);
    assert.ok(savedSnapshot);
    assert.equal(JSON.parse(savedSnapshot).speakerCorrectionRevision, 1);
  } finally {
    reopened.db.close();
  }
});

test("manual Summary keeps the previously saved result visible while it names speakers and generates", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { note, recording, run: sourceRun } = createFinishedRecording(db, storage, validConfig, "Keep this manual note.");
  saveTranscriptArtifact(db, storage, sourceRun.id, "Alice introduces herself.");
  const previousSummary = "## TLDR\nPreviously saved result.";
  storage.writeRunArtifact(sourceRun.id, "summary", { text: previousSummary });
  assert.equal(db.setMeetingRunArtifact(sourceRun.id, "summary").success, true);
  db.setMeetingProcessingRunState(sourceRun.id, { stage: "summary", status: "complete" });
  assert.equal(db.selectMeetingProcessingRun(recording.id, sourceRun.id, {
    transcript: JSON.stringify([{ speaker: "speaker_0", text: "Alice introduces herself." }]),
    summary: previousSummary,
    summaryPrompt: validConfig.summary.instruction,
  }).success, true);

  let summaryStarted!: () => void;
  const started = new Promise<void>((resolve) => { summaryStarted = resolve; });
  let finishSummary!: () => void;
  const response = new Promise<void>((resolve) => { finishSummary = resolve; });
  const worker = workerFor(db, storage, {
    nameSpeakers: async () => [{ speakerId: "speaker_0", name: "Alice" }],
    summarize: async () => {
      summaryStarted();
      await response;
      return "## TLDR\nNew result.";
    },
  });
  t.after(() => worker.stop());
  const manual = worker.createRun({ recordingId: recording.id, kind: "summary", sourceRunId: sourceRun.id, config: validConfig });
  assert.equal(manual.summary?.text, previousSummary);
  worker.onRetentionReady();
  await started;

  const inProgress = worker.listForNote(note.id)[0].runs.find((item) => item.run.id === manual.run.id);
  assert.equal(inProgress?.summary?.text, previousSummary);
  assert.equal(db.getNote(note.id).enhanced_content, previousSummary);
  assert.equal(db.getMeetingRunSpeakerCorrections(sourceRun.id)[0].source, "model");

  finishSummary();
  await worker.waitForIdle();
  assert.equal(storage.readRunArtifact(manual.run.id, "summary").text, "## TLDR\nNew result.");
  assert.equal(db.getNote(note.id).enhanced_content, "## TLDR\nNew result.");
  assert.equal(db.getNote(note.id).content, "Keep this manual note.");
});

test("summary retry preserves the transcript and does not repeat ASR", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage, validConfig, "", false, 180);
  let transcribeCalls = 0;
  let summaryCalls = 0;
  const worker = workerFor(db, storage, {
    transcribeRemote: async (_request: unknown, saveRaw) => {
      transcribeCalls += 1;
      await saveRaw(longTranscriptResponse());
      return { success: true, text: "ignored adapter projection" };
    },
    summarize: async () => {
      summaryCalls += 1;
      if (summaryCalls === 1) throw new Error("summary provider failed");
      return "Recovered summary";
    },
  });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();

  assert.equal(db.getMeetingProcessingRun(run.id).status, "failed");
  assert.equal(db.getMeetingProcessingRun(run.id).stage, "summary");
  assert.equal(db.getMeetingProcessingRun(run.id).hasTranscript, true);
  assert.equal(storage.readRunArtifact(run.id, "transcript").segments[0].text.length, 2500);
  worker.retry(run.id);
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(run.id).status, "complete");
  assert.equal(transcribeCalls, 1);
  assert.equal(summaryCalls, 2);
});

test("local meeting transcription uses post-Stop diarization and speaker-text merge", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const localConfig: MeetingProcessingConfig = {
    transcription: {
      mode: "local",
      language: "en",
      local: { provider: "whisper", model: "base", options: { diarize: true } },
    },
    summary: null,
  };
  const { run } = createFinishedRecording(db, storage, localConfig);
  let localCalls = 0;
  let diarizationCalls = 0;
  const worker = workerFor(db, storage, {
    transcribeLocal: async (_path: string, options) => {
      localCalls += 1;
      assert.equal(options.provider, "whisper");
      assert.equal(options.model, "base");
      assert.ok(options.signal instanceof AbortSignal);
      return { success: true, text: "We agreed. Next action." };
    },
    diarizeLocal: async (_path: string, options) => {
      diarizationCalls += 1;
      assert.equal(options.durationSeconds, 1);
      return [
        { speaker: "speaker_1", start: 0, end: 0.45 },
        { speaker: "speaker_2", start: 0.55, end: 1 },
      ];
    },
  });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();

  const saved = db.getMeetingProcessingRun(run.id);
  const transcript = meetingTranscriptArtifactSchema.parse(storage.readRunArtifact(run.id, "transcript"));
  assert.equal(saved.status, "blocked");
  assert.equal(saved.stage, "summary");
  assert.equal(saved.errorCode, "missing-summary-config");
  assert.equal(saved.hasTranscript, true);
  assert.equal(saved.hasSummary, false);
  assert.equal(storage.readRunArtifact(run.id, "summary"), null);
  assert.equal(localCalls, 1);
  assert.equal(diarizationCalls, 1);
  assert.match(transcript.text, /\[Speaker 1\]/);
  assert.match(transcript.text, /\[Speaker 2\]/);
  assert.ok(transcript.segments);
  assert.deepEqual(transcript.segments.map((segment) => segment.speaker), ["speaker_1", "speaker_2"]);
});

test("new capture lets an issued remote request save raw but defers normalize and summary", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage, validConfig, "", false, 180);
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  let finishRequest!: () => void;
  const requestResult = new Promise<void>((resolve) => { finishRequest = resolve; });
  let summaryCalls = 0;
  const worker = workerFor(db, storage, {
    transcribeRemote: async (_request: unknown, saveRaw) => {
      started();
      await requestResult;
      await saveRaw(longTranscriptResponse());
      return { success: true, text: "adapter result" };
    },
    summarize: async () => {
      summaryCalls += 1;
      return "summary";
    },
  });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await requestStarted;
  worker.captureStarted();
  finishRequest();
  await worker.waitForIdle();

  let saved = db.getMeetingProcessingRun(run.id);
  assert.equal(saved.status, "pending");
  assert.equal(saved.stage, "normalize");
  assert.equal(saved.hasRawProviderResponse, true);
  assert.equal(saved.hasTranscript, false);
  assert.equal(summaryCalls, 0);

  worker.captureStopped();
  await worker.waitForIdle();
  saved = db.getMeetingProcessingRun(run.id);
  assert.equal(saved.status, "complete");
  assert.equal(saved.hasTranscript, true);
  assert.equal(summaryCalls, 1);
});

test("an available raw response recovered after a crash resumes at normalize", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage, validConfig, "", false, 180);
  storage.writeRunArtifact(run.id, "provider-response", elevenResponse);
  assert.equal(db.setMeetingRunArtifact(run.id, "provider-response").success, true);
  assert.equal(db.claimMeetingProcessingRun(run.id), true);
  db.setMeetingProcessingRunState(run.id, { stage: "asr", status: "running" });
  let transcribeCalls = 0;
  const worker = workerFor(db, storage, {
    transcribeRemote: async () => {
      transcribeCalls += 1;
      return { success: false, error: "must not request ASR" };
    },
  });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();

  const recovered = db.getMeetingProcessingRun(run.id);
  assert.equal(recovered.status, "complete");
  assert.equal(recovered.hasTranscript, true);
  assert.equal(transcribeCalls, 0);
});

test("a persisted transcript recovered at summary runs only the saved summary stage", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage, validConfig, "", false, 180);
  storage.writeRunArtifact(run.id, "provider-response", elevenResponse);
  assert.equal(db.setMeetingRunArtifact(run.id, "provider-response").success, true);
  storage.writeRunArtifact(run.id, "transcript", {
    text: `[Speaker 1] 00:00:00 - 00:00:00\n${"s".repeat(2500)}`,
    diarized: true,
    segments: [{ speaker: "speaker_0", text: "s".repeat(2500), start: 0, end: 0.5 }],
  });
  assert.equal(db.setMeetingRunArtifact(run.id, "transcript").success, true);
  assert.equal(db.claimMeetingProcessingRun(run.id), true);
  db.setMeetingProcessingRunState(run.id, { stage: "summary", status: "running" });
  let asrCalls = 0;
  let summaryCalls = 0;
  const worker = workerFor(db, storage, {
    transcribeRemote: async () => {
      asrCalls += 1;
      return { success: false, error: "ASR must not repeat" };
    },
    summarize: async (input) => {
      summaryCalls += 1;
      assert.equal(parseSummaryInput(input).transcriptSegments[0].text, "s".repeat(2500));
      return "Recovered summary";
    },
  });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();

  assert.equal(db.getMeetingProcessingRun(run.id).status, "complete");
  assert.equal(asrCalls, 0);
  assert.equal(summaryCalls, 1);
});

test("a bb summary resumes its saved thread after process restart without repeating ASR", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const config: MeetingProcessingConfig = {
    ...validConfig,
    summary: {
      actionId: validConfig.summary.actionId,
      instruction: validConfig.summary.instruction,
      reasoningMode: "agent",
      agentProvider: "codex",
      model: "gpt-6-luna",
      agentReasoningLevel: "low",
    },
  };
  const { run } = createFinishedRecording(db, storage, config, "", false, 180);
  storage.writeRunArtifact(run.id, "provider-response", elevenResponse);
  assert.equal(db.setMeetingRunArtifact(run.id, "provider-response").success, true);
  storage.writeRunArtifact(run.id, "transcript", {
    text: `[Speaker 1] 00:00:00 - 00:00:00\n${"s".repeat(2500)}`,
    diarized: false,
    segments: [{ speaker: "speaker_0", text: "s".repeat(2500), start: 0, end: 0.5 }],
  });
  assert.equal(db.setMeetingRunArtifact(run.id, "transcript").success, true);
  assert.equal(db.claimMeetingProcessingRun(run.id), true);
  db.setMeetingProcessingRunState(run.id, { stage: "summary", status: "running" });
  assert.equal(db.setMeetingRunBbThreadId(run.id, "thr_resumetest"), true);
  assert.equal(db.setMeetingRunBbThreadId(run.id, "thr_duplicate"), false);
  let asrCalls = 0;
  let agentCalls = 0;
  const worker = workerFor(db, storage, {
    transcribeRemote: async () => { asrCalls++; throw new Error("ASR must not repeat"); },
    summarizeAgent: async (input: string, summaryConfig, savedRun) => {
      agentCalls++;
      assert.equal(parseSummaryInput(input).transcriptSegments[0].text, "s".repeat(2500));
      assert.equal(summaryConfig.agentProvider, "codex");
      assert.equal(savedRun.bbThreadId, "thr_resumetest");
      return "Recovered bb summary";
    },
  });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(run.id).status, "complete");
  assert.equal(db.getMeetingProcessingRun(run.id).bbThreadId, "thr_resumetest");
  assert.equal(agentCalls, 1);
  assert.equal(asrCalls, 0);
});

test("a missing provider key blocks the saved route and a later key repairs that run", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage, validConfig, "", false, 180);
  const configBefore = db.getMeetingProcessingRun(run.id).config;
  let key = "";
  let requests = 0;
  const worker = workerFor(db, storage, {
    getCredential: () => key,
    transcribeRemote: async (_request: unknown, saveRaw) => {
      requests += 1;
      await saveRaw(longTranscriptResponse());
      return { success: true };
    },
  });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(run.id).status, "blocked");
  assert.equal(db.getMeetingProcessingRun(run.id).errorCode, "api-key-missing");
  assert.equal(requests, 0);

  key = "corrected-key";
  worker.retry(run.id);
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(run.id).status, "complete");
  assert.equal(requests, 1);
  assert.deepEqual(db.getMeetingProcessingRun(run.id).config, configBefore);
});

test("provider size limits block only that run and another provider keeps its own result", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const deepgramConfig: MeetingProcessingConfig = {
    transcription: {
      mode: "providers",
      provider: "deepgram",
      model: "nova-3",
      language: "en",
      credentialRef: "DEEPGRAM_API_KEY",
    },
    summary: null,
  };
  const elevenConfig: MeetingProcessingConfig = {
    transcription: {
      mode: "providers",
      provider: "elevenlabs",
      model: "scribe_v2",
      language: "en",
      credentialRef: "ELEVENLABS_API_KEY",
    },
    summary: null,
  };
  const { recording, run: deepgramRun } = createFinishedRecording(db, storage, deepgramConfig);
  let requests = 0;
  const worker = workerFor(db, storage, {
    mixAudio: async (recordingValue, runId: string) => ({
      path: storage.getDerivedAudioPath(recordingValue.id, runId),
      frameCount: 24_000,
      durationSeconds: 1,
      sizeBytes: 2 * 1024 * 1024 * 1024 + 1,
    }),
    transcribeRemote: async (_request: unknown, saveRaw) => {
      requests += 1;
      await saveRaw(elevenResponse);
      return { success: true };
    },
  });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(deepgramRun.id).status, "blocked");
  assert.equal(db.getMeetingProcessingRun(deepgramRun.id).errorCode, "provider-limit");
  assert.equal(requests, 0);

  const elevenRun = worker.createRun({
    recordingId: recording.id,
    kind: "reprocess",
    config: elevenConfig,
  }).run;
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(deepgramRun.id).status, "blocked");
  assert.equal(db.getMeetingProcessingRun(deepgramRun.id).hasRawProviderResponse, false);
  const elevenSavedRun = db.getMeetingProcessingRun(elevenRun.id);
  assert.equal(elevenSavedRun.status, "blocked");
  assert.equal(elevenSavedRun.stage, "summary");
  assert.equal(elevenSavedRun.errorCode, "missing-summary-config");
  assert.equal(elevenSavedRun.provider, "elevenlabs");
  assert.equal(elevenSavedRun.hasRawProviderResponse, true);
  assert.equal(elevenSavedRun.hasTranscript, true);
  assert.equal(elevenSavedRun.hasSummary, false);
  assert.deepEqual(storage.readRunArtifact(elevenRun.id, "provider-response"), elevenResponse);
  assert.ok(storage.readRunArtifact(elevenRun.id, "transcript"));
  assert.equal(storage.readRunArtifact(elevenRun.id, "summary"), null);
  assert.equal(requests, 1);
});

test("rate limits allow three persisted automatic retries then manual retry starts a new cycle", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage, validConfig, "", false, 180);
  const now = new Date("2026-09-24T10:00:00.000Z");
  const backoffs = [];
  let transcribeCalls = 0;
  const worker = workerFor(db, storage, {
    now: () => new Date(now),
    setTimeout: ((_callback: unknown, milliseconds: unknown) => {
      backoffs.push(milliseconds);
      return backoffs.length;
    }) as unknown as typeof setTimeout,
    clearTimeout: () => {},
    transcribeRemote: async () => {
      transcribeCalls += 1;
      return {
        success: false,
        code: "PROVIDER_RATE_LIMITED",
        error: "429",
      };
    },
  });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();

  const saved = db.getMeetingProcessingRun(run.id);
  assert.equal(saved.status, "pending");
  assert.equal(saved.stage, "asr");
  assert.equal(saved.retryCount, 1);
  assert.equal(Date.parse(saved.retryAt) - now.getTime(), 5000);
  for (const expected of [2, 3]) {
    now.setTime(Date.parse(db.getMeetingProcessingRun(run.id).retryAt));
    worker.processPending();
    await worker.waitForIdle();
    assert.equal(db.getMeetingProcessingRun(run.id).retryCount, expected);
  }
  now.setTime(Date.parse(db.getMeetingProcessingRun(run.id).retryAt));
  worker.processPending();
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(run.id).status, "failed");
  assert.equal(db.getMeetingProcessingRun(run.id).retryCount, 3);
  assert.equal(transcribeCalls, 4, "one initial request plus three automatic retries");

  worker.retry(run.id);
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(run.id).retryCount, 1);
  assert.equal(transcribeCalls, 5, "manual retry starts a fresh attempt cycle");
  worker.stop();
});

test("a late HTTP result cannot publish after durable audio deletion starts", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { recording, run } = createFinishedRecording(db, storage);
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  let finishRequest!: () => void;
  const requestResult = new Promise<void>((resolve) => { finishRequest = resolve; });
  const worker = workerFor(db, storage, {
    transcribeRemote: async (_request: unknown, saveRaw) => {
      started();
      await requestResult;
      await saveRaw(elevenResponse);
      return { success: true, text: "late" };
    },
  });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await requestStarted;
  db.beginMeetingAudioDeletion(recording.id);
  finishRequest();
  await worker.waitForIdle();

  assert.equal(db.getMeetingProcessingRun(run.id).status, "cancelled");
  assert.equal(db.getMeetingProcessingRun(run.id).hasRawProviderResponse, false);
  assert.equal(storage.readRunArtifact(run.id, "provider-response"), null);
});

test("recovery marks an in-flight ASR outcome unknown and counts its possible rebill", (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage);
  assert.equal(db.claimMeetingProcessingRun(run.id), true);
  db.setMeetingProcessingRunState(run.id, { stage: "asr", status: "running" });
  const worker = workerFor(db, storage);
  worker.stop();

  const recovered = db.getMeetingProcessingRun(run.id);
  assert.equal(recovered.status, "pending");
  assert.equal(recovered.stage, "asr");
  assert.equal(recovered.errorCode, "asr-outcome-unknown");
  assert.equal(recovered.retryCount, 1);
});

function writePcmWav(filePath: string, frames: number) {
  const dataBytes = frames * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataBytes, 40);
  fs.writeFileSync(filePath, wav);
}

test("mixer keeps epoch offsets, a timeline gap, safe gain, and exact duration", async (t: import("node:test").TestContext) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const note = db.saveNote("Mixer", "", "meeting").note;
  const startedAt = new Date("2026-09-24T10:00:00.000Z");
  const recording = db.createMeetingRecording(note.id, { config: validConfig }, startedAt.toISOString());
  const epochs = [
    { source: "mic", index: 0, offset: 0, bytes: Buffer.from([1, 0, 2, 0]) },
    { source: "system", index: 0, offset: 3, bytes: Buffer.from([3, 0, 4, 0]) },
    { source: "mic", index: 1, offset: 6, bytes: Buffer.from([5, 0, 6, 0]) },
  ];
  for (const epoch of epochs) {
    db.createMeetingRecordingEpoch(recording.id, epoch.source, epoch.index, epoch.offset);
    const filePath = storage.createEpochFile(recording.id, epoch.source, epoch.index);
    fs.writeFileSync(filePath, epoch.bytes);
    db.updateMeetingRecordingEpochRecovery(recording.id, epoch.source, epoch.index, {
      frameCount: epoch.bytes.length / 2,
      ignoredTrailingBytes: 0,
    });
  }
  db.markMeetingRecordingFinalizing(recording.id);
  const finalized = db.finalizeMeetingRecording(recording.id, {
    captureState: "incomplete",
    endedAt: new Date(startedAt.getTime() + 1).toISOString(),
  }).recording;
  const originalRaw = epochs.map((epoch) =>
    fs.readFileSync(storage.getEpochFilePath(recording.id, epoch.source, epoch.index))
  );
  let argsSeen: string[] = [];
  const outputChild = new EventEmitter();
  outputChild.stderr = new EventEmitter();
  outputChild.kill = () => {};

  const result = await prepareMeetingAudio(
    storage,
    finalized,
    db.listMeetingProcessingRuns(recording.id)[0].id,
    db.listMeetingRecordingEpochs(recording.id),
    {
      deps: {
        ffmpegPath: () => "/test/ffmpeg",
        availableBytes: (directory: string) => {
          assert.equal(fs.statSync(directory).isDirectory(), true);
          return 1_000_000;
        },
        spawn: (_command: unknown, args: string[]) => {
          argsSeen = args;
          queueMicrotask(() => {
            const outputPath = args.at(-1);
            assert.ok(outputPath);
            writePcmWav(outputPath, 24);
            outputChild.emit("close", 0);
          });
          return outputChild;
        },
      },
    }
  );

  const graph = argsSeen[argsSeen.indexOf("-filter_complex") + 1];
  assert.match(graph, /adelay=0S:all=1,volume=0\.5/);
  assert.match(graph, /adelay=3S:all=1,volume=0\.5/);
  assert.match(graph, /adelay=6S:all=1,volume=0\.5/);
  assert.match(graph, /amix=inputs=3:duration=longest:dropout_transition=0:normalize=0/);
  assert.match(graph, /apad=whole_len=24,atrim=end_sample=24/);
  assert.equal(result.frameCount, 24);
  assert.equal(result.durationSeconds, 24 / 24_000);
  assert.equal(result.sizeBytes, 92);
  assert.deepEqual(
    epochs.map((epoch) => fs.readFileSync(storage.getEpochFilePath(recording.id, epoch.source, epoch.index))),
    originalRaw
  );
  assert.equal(fs.statSync(result.path).size, 92);
});

test("ffmpeg output preserves audible source offsets, a silent gap, and full timeline end", async (t: import("node:test").TestContext) => {
  const ffmpegPath = getFFmpegPath();
  if (!ffmpegPath) {
    t.skip("FFmpeg is unavailable");
    return;
  }
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const note = db.saveNote("Measured mixer", "", "meeting").note;
  const startedAt = new Date("2026-09-24T10:00:00.000Z");
  const recording = db.createMeetingRecording(note.id, { config: validConfig }, startedAt.toISOString());
  const sourceEpochs: { source: string; offset: number; values: number[][]; raw?: Buffer }[] = [
    { source: "mic", offset: 0, values: [[5, 10_000], [6, 10_000]] },
    { source: "system", offset: 480, values: [[5, 6_000], [6, 6_000]] },
  ];
  for (const [index, epoch] of sourceEpochs.entries()) {
    db.createMeetingRecordingEpoch(recording.id, epoch.source, 0, epoch.offset);
    const raw = Buffer.alloc(960 * 2);
    for (const [frame, sample] of epoch.values) raw.writeInt16LE(sample, frame * 2);
    fs.writeFileSync(storage.createEpochFile(recording.id, epoch.source, 0), raw);
    db.updateMeetingRecordingEpochRecovery(recording.id, epoch.source, 0, {
      frameCount: raw.length / 2,
      ignoredTrailingBytes: 0,
    });
    sourceEpochs[index].raw = raw;
  }
  db.markMeetingRecordingFinalizing(recording.id);
  const finalized = db.finalizeMeetingRecording(recording.id, {
    captureState: "ready",
    endedAt: new Date(startedAt.getTime() + 200).toISOString(),
  }).recording;
  const run = db.listMeetingProcessingRuns(recording.id)[0];
  const mixed = await prepareMeetingAudio(
    storage,
    finalized,
    run.id,
    db.listMeetingRecordingEpochs(recording.id),
    { deps: { ffmpegPath: () => ffmpegPath } }
  );

  const wav = fs.readFileSync(mixed.path);
  const dataHeader = wav.indexOf(Buffer.from("data"));
  assert.notEqual(dataHeader, -1);
  const dataStart = dataHeader + 8;
  const dataBytes = wav.readUInt32LE(dataHeader + 4);
  assert.equal(dataBytes / 2, 4_800);
  assert.equal(mixed.durationSeconds, 0.2);
  assert.ok(wav.readInt16LE(dataStart + 5 * 2) > 4_000, "mic signal begins at its saved frame");
  assert.ok(wav.readInt16LE(dataStart + 485 * 2) > 2_000, "system signal keeps its later offset");
  for (let frame = 1_500; frame < 3_500; frame += 1) {
    assert.equal(wav.readInt16LE(dataStart + frame * 2), 0, `timeline gap is silent at frame ${frame}`);
  }
  for (const epoch of sourceEpochs) {
    assert.deepEqual(
      fs.readFileSync(storage.getEpochFilePath(recording.id, epoch.source, 0)),
      epoch.raw,
      `${epoch.source} raw source remains immutable`
    );
  }
});
