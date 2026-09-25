const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const test = require("node:test");
const { createDb } = require("./harness/db.js");
const { getUserDataDir } = require("./harness/electronStub.js");
const MeetingRecordingStorage = require("../../src/helpers/meetingRecordingStorage.ts");
const { MeetingProcessingWorker, registerMeetingProcessingHandlers } = require("../../src/helpers/meetingProcessing.ts");
const { meetingProcessingChannels } = require("../../src/contracts/meetingProcessing.ts");
const { createMeetingProcessingBridge } = require("../../src/preload/meetingProcessingBridge.ts");
const { prepareMeetingAudio } = require("../../src/helpers/meetingAudioMixer.ts");
const { getFFmpegPath } = require("../../src/helpers/ffmpegUtils.ts");

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
};

const elevenResponse = {
  text: "Hello.",
  words: [
    { type: "word", text: "Hello", start: 0.1, end: 0.4, speaker_id: "speaker_0" },
    { type: "word", text: ".", start: 0.4, end: 0.5, speaker_id: "speaker_0" },
  ],
};

function createFinishedRecording(db, storage, config = validConfig, noteText = "") {
  const note = db.saveNote("Meeting", noteText, "meeting").note;
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
    endedAt: new Date(Date.parse(recording.startedAt) + 1000).toISOString(),
  });
  return { note, recording: finalized.recording, run: finalized.initialRun };
}

function workerFor(db, storage, overrides = {}) {
  const deps = {
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

test("waits for retention and capture to finish, then persists the response, transcript, and separate summary", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { note, recording, run } = createFinishedRecording(db, storage, validConfig, "  Manual note first.  \n");
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
      await saveRaw(elevenResponse);
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
  assert.equal(storage.readRunArtifact(run.id, "provider-response").text, "Hello.");
  assert.match(storage.readRunArtifact(run.id, "transcript").text, /Hello\./);
  assert.match(summaryInput, /## Manual Notes\n\x20{2}Manual note first\.\x20{2}\n/);
  assert.match(summaryInput, /## Transcript/);
  assert.deepEqual(storage.readRunArtifact(run.id, "summary"), { text: "## Summary\n- A useful result." });
  assert.equal(db.getNote(note.id).content, "  Manual note first.  \n");
  assert.equal(db.getMeetingRecording(recording.id).captureState, "ready");
  assert.equal(transcribeCalls, 1);
});

test("a bad provider response stays saved and retry re-enters normalize without another ASR request", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage);
  let transcribeCalls = 0;
  const worker = workerFor(db, storage, {
    transcribeRemote: async (_request, saveRaw) => {
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

test("a valid empty transcript completes without generating a summary", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage);
  let summaryCalls = 0;
  const worker = workerFor(db, storage, {
    transcribeRemote: async (_request, saveRaw) => {
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

test("a nonempty transcript stays blocked when its saved run has no summary config", async (t) => {
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

test("IPC corrects only a blocked run snapshot after main validation; ordinary retry keeps it", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage, null);
  let apiKey = "";
  const worker = workerFor(db, storage, { getCredential: () => apiKey });
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(run.id).status, "blocked");
  assert.equal(db.getMeetingProcessingRun(run.id).config, null);

  const handlers = new Map();
  registerMeetingProcessingHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, worker);
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

test("blocked config correction refuses an unindexed raw response file", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage, null);
  storage.writeRunArtifact(run.id, "provider-response", { text: "already saved" });
  const worker = workerFor(db, storage);
  t.after(() => worker.stop());
  const handlers = new Map();
  registerMeetingProcessingHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, worker);

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
  const calls = [];
  const bridge = createMeetingProcessingBridge({
    invoke: async (...args) => {
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

test("summary retry preserves the transcript and does not repeat ASR", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage);
  let transcribeCalls = 0;
  let summaryCalls = 0;
  const worker = workerFor(db, storage, {
    transcribeRemote: async (_request, saveRaw) => {
      transcribeCalls += 1;
      await saveRaw(elevenResponse);
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
  assert.equal(storage.readRunArtifact(run.id, "transcript").text.includes("Hello."), true);
  worker.retry(run.id);
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(run.id).status, "complete");
  assert.equal(transcribeCalls, 1);
  assert.equal(summaryCalls, 2);
});

test("local meeting transcription uses post-Stop diarization and speaker-text merge", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const localConfig = {
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
    transcribeLocal: async (_path, options) => {
      localCalls += 1;
      assert.equal(options.provider, "whisper");
      assert.equal(options.model, "base");
      assert.ok(options.signal instanceof AbortSignal);
      return { success: true, text: "We agreed. Next action." };
    },
    diarizeLocal: async (_path, options) => {
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
  const transcript = storage.readRunArtifact(run.id, "transcript");
  assert.equal(saved.status, "complete");
  assert.equal(localCalls, 1);
  assert.equal(diarizationCalls, 1);
  assert.match(transcript.text, /\[Speaker 1\]/);
  assert.match(transcript.text, /\[Speaker 2\]/);
  assert.deepEqual(transcript.segments.map((segment) => segment.speaker), ["speaker_1", "speaker_2"]);
});

test("new capture lets an issued remote request save raw but defers normalize and summary", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage);
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  let finishRequest;
  const requestResult = new Promise((resolve) => { finishRequest = resolve; });
  let summaryCalls = 0;
  const worker = workerFor(db, storage, {
    transcribeRemote: async (_request, saveRaw) => {
      started();
      await requestResult;
      await saveRaw(elevenResponse);
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

test("an available raw response recovered after a crash resumes at normalize", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage);
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

test("a persisted transcript recovered at summary runs only the saved summary stage", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage);
  storage.writeRunArtifact(run.id, "provider-response", elevenResponse);
  assert.equal(db.setMeetingRunArtifact(run.id, "provider-response").success, true);
  storage.writeRunArtifact(run.id, "transcript", {
    text: "Saved transcript",
    diarized: true,
    segments: [{ speaker: "Speaker 1", text: "Saved transcript", start: 0, end: 0.5 }],
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
      assert.match(input, /Saved transcript/);
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

test("a missing provider key blocks the saved route and a later key repairs that run", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage);
  const configBefore = db.getMeetingProcessingRun(run.id).config;
  let key = "";
  let requests = 0;
  const worker = workerFor(db, storage, {
    getCredential: () => key,
    transcribeRemote: async (_request, saveRaw) => {
      requests += 1;
      await saveRaw(elevenResponse);
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

test("provider size limits block only that run and another provider keeps its own result", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const deepgramConfig = {
    transcription: {
      mode: "providers",
      provider: "deepgram",
      model: "nova-3",
      language: "en",
      credentialRef: "DEEPGRAM_API_KEY",
    },
    summary: null,
  };
  const elevenConfig = {
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
    mixAudio: async (recordingValue, runId) => ({
      path: storage.getDerivedAudioPath(recordingValue.id, runId),
      frameCount: 24_000,
      durationSeconds: 1,
      sizeBytes: 2 * 1024 * 1024 * 1024 + 1,
    }),
    transcribeRemote: async (_request, saveRaw) => {
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
  assert.equal(db.getMeetingProcessingRun(elevenRun.id).status, "complete");
  assert.equal(db.getMeetingProcessingRun(elevenRun.id).provider, "elevenlabs");
  assert.equal(requests, 1);
});

test("rate limits allow three persisted automatic retries then manual retry starts a new cycle", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage);
  const now = new Date("2026-09-24T10:00:00.000Z");
  const backoffs = [];
  let transcribeCalls = 0;
  const worker = workerFor(db, storage, {
    now: () => new Date(now),
    setTimeout: (_callback, milliseconds) => {
      backoffs.push(milliseconds);
      return backoffs.length;
    },
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

test("a late HTTP result cannot publish after durable audio deletion starts", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { recording, run } = createFinishedRecording(db, storage);
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  let finishRequest;
  const requestResult = new Promise((resolve) => { finishRequest = resolve; });
  const worker = workerFor(db, storage, {
    transcribeRemote: async (_request, saveRaw) => {
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

test("recovery marks an in-flight ASR outcome unknown and counts its possible rebill", (t) => {
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

function writePcmWav(filePath, frames) {
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

test("mixer keeps epoch offsets, a timeline gap, safe gain, and exact duration", async (t) => {
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
  let argsSeen;
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
        availableBytes: (directory) => {
          assert.equal(fs.statSync(directory).isDirectory(), true);
          return 1_000_000;
        },
        spawn: (_command, args) => {
          argsSeen = args;
          queueMicrotask(() => {
            writePcmWav(args.at(-1), 24);
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

test("ffmpeg output preserves audible source offsets, a silent gap, and full timeline end", async (t) => {
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
  const sourceEpochs = [
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
