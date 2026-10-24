const {
  savePcmEpoch,
}: typeof import("../lib/meetingAudioFixture.ts") = require("../lib/meetingAudioFixture.ts");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const { EventEmitter } = require("node:events");

const fs: typeof import("node:fs") = require("node:fs");

const test: typeof import("node:test") = require("node:test");

const { createDb } = require("./harness/db.ts");

const {
  getUserDataDir,
}: typeof import("./harness/electronStub.ts") = require("./harness/electronStub.ts");

const DatabaseManagerClass = (
  require("./harness/db.ts") as { DatabaseManager: new () => DatabaseManager }
).DatabaseManager;

const MeetingRecordingStorage = require("../../src/helpers/meetingRecordingStorage.ts");

const {
  MeetingProcessingWorker,
  registerMeetingProcessingHandlers,
}: typeof import("../../src/helpers/meetingProcessing.ts") = require("../../src/helpers/meetingProcessing.ts");

const {
  meetingProcessingChannels,
}: typeof import("../../src/contracts/meetingProcessing.ts") = require("../../src/contracts/meetingProcessing.ts");

const {
  meetingTranscriptArtifactSchema,
  meetingProcessingResultDtoSchema,
}: typeof import("../../src/contracts/meetingRecording.ts") = require("../../src/contracts/meetingRecording.ts");

const {
  createMeetingProcessingBridge,
}: typeof import("../../src/preload/meetingProcessingBridge.ts") = require("../../src/preload/meetingProcessingBridge.ts");

const {
  prepareMeetingAudio,
}: typeof import("../../src/helpers/meetingAudioMixer.ts") = require("../../src/helpers/meetingAudioMixer.ts");

const {
  getFFmpegPath,
}: typeof import("../../src/helpers/ffmpegUtils.ts") = require("../../src/helpers/ffmpegUtils.ts");

const {
  BUILTIN_ACTIONS,
  RECAP_KEY,
}: typeof import("../../src/helpers/builtinActions.ts") = require("../../src/helpers/builtinActions.ts");

const {
  MEETING_SPEAKER_NAMING_INSTRUCTION,
  meetingSpeakerNamingInputSchema,
}: typeof import("../../src/helpers/meetingSpeakerNaming.ts") = require("../../src/helpers/meetingSpeakerNaming.ts");

const {
  MEETING_TASKS_INSTRUCTION,
}: typeof import("../../src/helpers/meetingSummarySections.ts") = require("../../src/helpers/meetingSummarySections.ts");

import type {
  MeetingIntentionalInterval,
  MeetingProcessingConfig,
  MeetingRecordingEpochDto,
} from "../../src/contracts/meetingRecording";
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
  includeSystemSource = true
) {
  const note = db.saveNote("Meeting", noteText, "meeting").note;
  assert.ok(note);
  const recording = db.createMeetingRecording(note.id, { config });
  db.createMeetingRecordingEpoch(recording.id, "mic", 0, 1, 0, 0);
  savePcmEpoch(storage, recording.id, "mic", 0, Buffer.from([1, 2, 3, 4]));
  const recovered = storage.recoverEpoch(recording.id, "mic", 0);
  db.updateMeetingRecordingEpochRecovery(recording.id, "mic", 0, recovered);

  if (includeSystemSource) {
    db.createMeetingRecordingEpoch(recording.id, "system", 0, 1, 0, 0);
    savePcmEpoch(storage, recording.id, "system", 0, Buffer.alloc(4));
    db.updateMeetingRecordingEpochRecovery(recording.id, "system", 0, {
      frameCount: 2,
      ignoredTrailingBytes: 0,
    });
  }

  db.markMeetingRecordingFinalizing(recording.id);

  const finalized = db.finalizeMeetingRecording(recording.id, {
    captureState: "ready",
    endedAt: new Date(Date.parse(recording.startedAt) + durationSeconds * 1000).toISOString(),
  });

  if (!keepGate && finalized.initialRun.status === "pending") {
    db.setMeetingProcessingRunState(finalized.initialRun.id, {
      stage: "prepare",
      status: "pending",
      retryAt: null,
    });
  }

  return {
    note,
    recording: finalized.recording,
    run: db.getMeetingProcessingRun(finalized.initialRun.id) as NonNullable<
      ReturnType<DatabaseManager["getMeetingProcessingRun"]>
    >,
  };
}

function muteAlignment(
  frame: number
): import("../../src/contracts/meetingRecording.ts").MeetingFrameAlignmentPoint {
  return {
    sourceGeneration: 1,
    sourceFrame: frame,
    timelineFrame: frame,
    rate: 1,
    uncertaintyFrames: 1,
    helperGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sourceNs: String(1_000_000_000 + Math.round((frame / 24_000) * 1e9)),
    helperNs: String(1_000_000_000 + Math.round((frame / 24_000) * 1e9)),
    sampledSourceStartNs: "1000000000",
    sampledSourceEndNs: "2000000000",
    freshnessSourceNs: "2000000000",
  };
}

function createSystemOnlyIntentionalRecording(
  db: DatabaseManager,
  storage: RecordingStorage,
  config: MeetingProcessingConfig
) {
  const note = db.saveNote("Muted microphone", "", "meeting").note;
  assert.ok(note);
  const recording = db.createMeetingRecording(note.id, { config });
  const endFrame = 24_000;
  db.openMeetingIntentionalInterval(recording.id, "mic", 1, 0, "manual-muted", muteAlignment(0));
  db.closeMeetingIntentionalInterval(
    recording.id,
    "mic",
    1,
    endFrame,
    "manual-muted",
    muteAlignment(endFrame)
  );
  db.createMeetingRecordingEpoch(recording.id, "system", 0, 1, 0, 0);
  const pcm = Buffer.alloc(endFrame * 2);

  for (let frame = 0; frame < endFrame; frame += 1) pcm.writeInt16LE(1_000, frame * 2);
  savePcmEpoch(storage, recording.id, "system", 0, pcm);
  db.updateMeetingRecordingEpochRecovery(recording.id, "system", 0, {
    frameCount: endFrame,
    ignoredTrailingBytes: 0,
  });
  db.markMeetingRecordingFinalizing(recording.id);

  const finalized = db.finalizeMeetingRecording(recording.id, {
    captureState: "ready",
    endedAt: new Date(Date.parse(recording.startedAt) + 1_000).toISOString(),
    sourceMetadata: { captureEndFrame: endFrame },
  });

  db.setMeetingProcessingRunState(finalized.initialRun.id, {
    stage: "prepare",
    status: "pending",
    retryAt: null,
  });

  return { recording: finalized.recording, run: finalized.initialRun };
}

function longTranscriptResponse(length = 2500, prefix = "") {
  const text = `${prefix}${"x".repeat(Math.max(0, length - prefix.length))}`;

  return {
    text,
    words: [{ type: "word", text, start: 0.1, end: 0.5, speaker_id: "speaker_0" }],
  };
}

function parseSummaryInput(value: string) {
  assert.doesNotMatch(value, /"speakerId":|"speakerName":|"id":/);
  const title = value.split("Meeting title (topic hint):\n")[1].split("\n\nManual notes:")[0];
  const manualNotes = value.split("Manual notes:\n")[1].split("\n\nTranscript source run:")[0];

  const names = new Map(
    [...value.matchAll(/^(Speaker \d+) = (.*?) \(/gm)].map((match) => [
      match[1],
      match[2] === "Unknown name" ? null : match[2],
    ])
  );

  const transcriptSegments = value
    .split("<transcript>\n")[1]
    .split("\n</transcript>")[0]
    .split("\n\n---\n\n")
    .map((turn) => {
      const colon = turn.indexOf(': "');
      const speakerId = turn.slice(0, colon).replace(/ \[.*\]$/, "");

      return {
        speakerId,
        speakerName: names.get(speakerId) ?? null,
        text: turn.slice(colon + 3, -1),
      };
    });

  return { meetingTitle: title, manualNotes, transcriptSegments };
}

function saveTranscriptArtifact(
  db: DatabaseManager,
  storage: RecordingStorage,
  runId: string,
  text: string,
  speaker = "speaker_0"
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

function workerFor(
  db: DatabaseManager,
  storage: RecordingStorage,
  overrides: Partial<MeetingProcessingWorkerDeps> = {},
  silentMic = true
) {
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

  const transcribeRemote = deps.transcribeRemote;
  deps.transcribeRemote = async (request, saveRaw, signal) => {
    if (silentMic && !request.diarize) {
      await saveRaw({ text: "", words: [], segments: [] });

      return { success: true, text: "" };
    }

    return transcribeRemote(request, saveRaw, signal);
  };

  return new MeetingProcessingWorker(deps);
}

test("crash-recovered full-mute capture processes system audio without a mic request", async (t) => {
  const db = createDb(t);

  if (!db) return;

  const { MeetingCaptureSession } =
    require("../../src/helpers/meetingCaptureSession.ts") as typeof import("../../src/helpers/meetingCaptureSession.js");

  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const note = db.saveNote("Interrupted meeting", "", "meeting").note!;

  const capture = MeetingCaptureSession.create(
    db,
    storage,
    note.id,
    { config: validConfig },
    undefined,
    undefined,
    undefined,
    true
  );

  capture.appendNativeSamples("system", 1, Buffer.alloc(48_000, 7), 0, 0);
  await storage.closeEpochWriter(capture.recordingId, "system", 0);
  db.close();
  const reopened = new DatabaseManagerClass();
  t.after(() => reopened.close());
  storage.recover(reopened);
  const recording = reopened.getMeetingRecording(capture.recordingId)!;
  const run = reopened.listMeetingProcessingRuns(capture.recordingId)[0];
  reopened.setMeetingProcessingRunState(run.id, {
    stage: "prepare",
    status: "pending",
    retryAt: null,
  });
  assert.equal(recording.captureState, "incomplete");
  const sources: string[] = [];

  const worker = workerFor(reopened, storage, {
    mixAudio: undefined,
    mixerDeps: { ffmpegPath: () => getFFmpegPath() },
    transcribeRemote: async (request, saveRaw) => {
      sources.push(request.filePath.endsWith("-system.wav") ? "system" : "mic");
      await saveRaw(elevenResponse);

      return { success: true, text: "parsed by adapter" };
    },
  });

  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.deepEqual(sources, ["system"]);
  assert.equal(reopened.getMeetingProcessingRun(run.id)!.status, "complete");
  assert.equal(reopened.getMeetingRecording(capture.recordingId)!.captureState, "incomplete");
});

for (const provider of ["elevenlabs", "openai", "gemini"] as const) {
  test(`${provider} records an intentional-empty mic stage without sending an empty-mic request`, async (t: import("node:test").TestContext) => {
    const db = createDb(t);

    if (!db) return;
    const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });

    const config: MeetingProcessingConfig = {
      ...validConfig,
      transcription: { mode: "providers", provider, language: "en" },
    };

    const { recording, run } = createSystemOnlyIntentionalRecording(db, storage, config);

    const requests: import("../../src/contracts/uploadTranscription").RemoteTranscriptionRequest[] =
      [];

    const mixLayouts: string[] = [];

    const systemResponse =
      provider === "openai"
        ? {
            text: "System speech",
            segments: [{ text: "System speech", start: 0.1, end: 0.5, speaker: "speaker_0" }],
          }
        : provider === "elevenlabs"
          ? elevenResponse
          : {
              status: "completed",
              output_text: "System speech",
              steps: [
                {
                  content: [
                    {
                      annotations: [
                        {
                          type: "word_info",
                          text: "System speech",
                          speaker: "speaker_0",
                          start_offset: "0.1s",
                          end_offset: "0.5s",
                        },
                      ],
                    },
                  ],
                },
              ],
            };

    const worker = workerFor(
      db,
      storage,
      {
        mixAudio: async (timeline, runId, epochs, _signal, layout, intentionalEmptySources) => {
          const selectedLayout = layout ?? "mono";
          mixLayouts.push(selectedLayout);
          assert.equal(timeline.id, recording.id);
          assert.deepEqual(
            epochs.map((epoch) => epoch.source),
            ["system"]
          );
          assert.deepEqual(intentionalEmptySources, ["mic"]);

          return {
            path: storage.getDerivedAudioPath(recording.id, runId, selectedLayout),
            frameCount: 24_000,
            durationSeconds: 1,
            sizeBytes: 1,
          };
        },
        fileSize: () => 1,
        transcribeRemote: async (request, saveRaw) => {
          requests.push(request);
          assert.ok(request.filePath.endsWith("-system.wav"));
          await saveRaw(systemResponse);

          return { success: true };
        },
      },
      false
    );

    t.after(() => worker.stop());
    worker.onRetentionReady();
    await worker.waitForIdle();

    assert.equal(db.getMeetingProcessingRun(run.id)?.status, "complete");
    assert.deepEqual(
      requests.map((request) => request.diarize),
      [true]
    );
    assert.ok(mixLayouts.includes("mic"));
    assert.ok(mixLayouts.includes("system"));
    assert.equal(storage.hasRunArtifact(run.id, "provider-response-mic"), false);
    assert.deepEqual(storage.readRunArtifact(run.id, "provider-response")?.mic, {
      type: "intentional-empty",
      source: "mic",
    });
    const transcript = storage.readRunArtifact(run.id, "transcript");
    assert.ok(transcript.segments?.length);
    assert.ok(
      transcript.segments.every((segment: { speaker: string }) =>
        segment.speaker.startsWith("system:")
      )
    );
  });
}

test("Deepgram prepares an intentional-empty microphone as stereo silence beside system audio", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });

  const config: MeetingProcessingConfig = {
    ...validConfig,
    transcription: { mode: "providers", provider: "deepgram", model: "nova-3", language: "en" },
  };

  const { recording, run } = createSystemOnlyIntentionalRecording(db, storage, config);
  const layouts: string[] = [];
  let requestCount = 0;

  const worker = workerFor(db, storage, {
    mixAudio: async (_timeline, runId, epochs, _signal, layout, intentionalEmptySources) => {
      const selectedLayout = layout ?? "mono";
      layouts.push(selectedLayout);
      assert.deepEqual(
        epochs.map((epoch) => epoch.source),
        ["system"]
      );
      assert.deepEqual(intentionalEmptySources, ["mic"]);

      return {
        path: storage.getDerivedAudioPath(recording.id, runId, selectedLayout),
        frameCount: 24_000,
        durationSeconds: 1,
        sizeBytes: 1,
      };
    },
    fileSize: () => 1,
    transcribeRemote: async (request, saveRaw) => {
      requestCount += 1;
      assert.equal(request.multichannel, true);
      assert.ok(request.filePath.endsWith("-stereo.wav"));
      await saveRaw({
        results: {
          channels: [
            { alternatives: [{ transcript: "" }] },
            { alternatives: [{ transcript: "System speech" }] },
          ],
          utterances: [
            { channel: 1, speaker: 0, transcript: "System speech", start: 0.1, end: 0.5 },
          ],
        },
      });

      return { success: true };
    },
  });

  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(run.id)?.status, "complete");
  assert.equal(requestCount, 1);
  assert.deepEqual(layouts, ["stereo"]);
  assert.equal(
    storage.readRunArtifact(run.id, "transcript")?.segments?.[0]?.speaker,
    "system:Speaker 1"
  );
});

test("local mono preparation retains system audio when mic is intentionally empty", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });

  const config: MeetingProcessingConfig = {
    transcription: {
      mode: "local",
      language: "en",
      local: { provider: "whisper", model: "base", options: { diarize: false } },
    },
    summary: validConfig.summary,
  };

  const { recording, run } = createSystemOnlyIntentionalRecording(db, storage, config);
  const layouts: string[] = [];
  let localCalls = 0;

  const worker = workerFor(db, storage, {
    mixAudio: async (_timeline, runId, epochs, _signal, layout, intentionalEmptySources) => {
      const selectedLayout = layout ?? "mono";
      layouts.push(selectedLayout);
      assert.equal(selectedLayout, "mono");
      assert.deepEqual(
        epochs.map((epoch) => epoch.source),
        ["system"]
      );
      assert.deepEqual(intentionalEmptySources, ["mic"]);

      return {
        path: storage.getDerivedAudioPath(recording.id, runId, selectedLayout),
        frameCount: 24_000,
        durationSeconds: 1,
        sizeBytes: 1,
      };
    },
    fileSize: () => 1,
    transcribeLocal: async (filePath) => {
      localCalls += 1;
      assert.equal(filePath, storage.getDerivedAudioPath(recording.id, run.id, "mono"));

      return { success: true, text: "System speech" };
    },
  });

  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();
  const localRun = db.getMeetingProcessingRun(run.id);
  assert.equal(
    localRun?.status,
    "complete",
    `local intentional-empty run failed at ${localRun?.stage}: ${localRun?.errorCode}`
  );
  assert.equal(localCalls, 1);
  assert.deepEqual(layouts, ["mono"]);
});

test("a missing system source without persisted intentional coverage stays blocked", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage, validConfig, "", false, 1, false);
  let requests = 0;

  const worker = workerFor(
    db,
    storage,
    {
      transcribeRemote: async () => {
        requests += 1;

        return { success: true };
      },
    },
    false
  );

  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();
  const saved = db.getMeetingProcessingRun(run.id);
  assert.equal(saved?.status, "blocked");
  assert.equal(saved?.errorCode, "system-source-unavailable");
  assert.equal(requests, 0);
});

test("meeting prompts keep naming evidence, absent owner fields, and task priorities narrow", () => {
  assert.match(MEETING_SPEAKER_NAMING_INSTRUCTION, /self-introduction/);
  assert.match(MEETING_SPEAKER_NAMING_INSTRUCTION, /address followed by a substantive response/);
  assert.match(MEETING_SPEAKER_NAMING_INSTRUCTION, /Third-party mentions alone never identify/);

  const detailedNotes = BUILTIN_ACTIONS.find(
    (action) => action.translationKey === "notes.actions.builtin.detailedNotes"
  )?.prompt;

  assert.ok(detailedNotes);
  assert.match(detailedNotes, /omit each when the source does not state it/);
  assert.doesNotMatch(detailedNotes, /Owner not specified|Due date not specified/);
  assert.match(
    MEETING_TASKS_INSTRUCTION,
    /HIGH only when the source explicitly says the agreed work is urgent, time-critical, or blocks an agreed next step/
  );
  assert.match(
    MEETING_TASKS_INSTRUCTION,
    /MEDIUM for a concrete next step without exceptional urgency or low priority/
  );
  assert.match(
    MEETING_TASKS_INSTRUCTION,
    /LOW only when the source explicitly says the agreed or requested work is deferred or low-priority/
  );
  assert.match(
    MEETING_TASKS_INSTRUCTION,
    /Never infer priority from impact, general importance, deadline proximity, or today's date/
  );
  assert.match(MEETING_TASKS_INSTRUCTION, /Preserve relative deadlines as spoken/);
});

test("automatic naming revises only model names and rejects stale revisions and user edits", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage);

  const suggestion = (displayName: string) => [
    { speakerId: "speaker_a", profileId: null, displayName },
  ];

  assert.equal(
    db.applyAutomaticMeetingSpeakerCorrections(run.id, run.id, 0, suggestion("Max"), "model"),
    true
  );
  assert.equal(
    db.applyAutomaticMeetingSpeakerCorrections(run.id, run.id, 1, suggestion("Dan"), "model"),
    true
  );
  assert.deepEqual(db.getMeetingRunSpeakerCorrections(run.id), [
    {
      speakerId: "speaker_a",
      profileId: null,
      displayName: "Dan",
      participantEmail: null,
      source: "model",
      revision: 2,
    },
  ]);
  assert.equal(
    db.applyAutomaticMeetingSpeakerCorrections(
      run.id,
      run.id,
      1,
      suggestion("Stale guess"),
      "model"
    ),
    false
  );
  assert.equal(
    db.setMeetingRunSpeakerCorrection(run.id, "speaker_a", null, "User name", "user").success,
    true
  );
  assert.equal(
    db.applyAutomaticMeetingSpeakerCorrections(
      run.id,
      run.id,
      2,
      suggestion("Concurrent guess"),
      "model"
    ),
    false
  );
  assert.equal(
    db.applyAutomaticMeetingSpeakerCorrections(run.id, run.id, 3, suggestion("New guess"), "model"),
    false
  );
  assert.equal(
    db.applyAutomaticMeetingSpeakerCorrections(
      run.id,
      run.id,
      3,
      [{ speakerId: "speaker_b", profileId: null, displayName: "Voice" }],
      "voice"
    ),
    true
  );
  assert.equal(
    db.applyAutomaticMeetingSpeakerCorrections(
      run.id,
      run.id,
      4,
      [{ speakerId: "speaker_b", profileId: null, displayName: "Model" }],
      "model"
    ),
    false
  );
  assert.deepEqual(
    db
      .getMeetingRunSpeakerCorrections(run.id)
      .map(({ displayName, source }: { displayName: string; source: string }) => ({
        displayName,
        source,
      })),
    [
      { displayName: "User name", source: "user" },
      { displayName: "Voice", source: "voice" },
    ]
  );
});

// Regression (#177): after a model proposal is withdrawn the DB keeps a
// cleared tombstone row, so the authoritative revision is 2 while the display
// list is empty. The result DTO must carry that authoritative revision so the
// renderer does not sum only the visible corrections (which read 0) and call a
// fresh Summary stale forever.
test("the result DTO carries the authoritative revision after a withdrawn model proposal", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { note, recording, run } = createFinishedRecording(db, storage);
  saveTranscriptArtifact(db, storage, run.id, "Max? The build is fixed.");
  const worker = workerFor(db, storage, { summarize: async () => "## TLDR\nFresh summary." });
  t.after(() => worker.stop());

  const revisionOf = (runId: string) =>
    worker
      .listForNote(note.id)
      .flatMap((item) => item.runs)
      .find((item) => item.run.id === runId)?.speakerCorrectionRevision;

  const correctionsOf = (runId: string) =>
    worker
      .listForNote(note.id)
      .flatMap((item) => item.runs)
      .find((item) => item.run.id === runId)?.speakerCorrections;

  // No corrections yet: authoritative and visible both read 0.
  assert.equal(revisionOf(run.id), 0);
  assert.deepEqual(correctionsOf(run.id), []);

  // A model proposal raises the authoritative revision to 1, then withdrawing
  // it raises again to 2 while the display list empties.
  assert.equal(
    db.applyAutomaticMeetingSpeakerCorrections(
      run.id,
      run.id,
      0,
      [{ speakerId: "speaker_0", profileId: null, displayName: "Max" }],
      "model"
    ),
    true
  );
  assert.equal(
    db.applyAutomaticMeetingSpeakerCorrections(run.id, run.id, 1, [], "model", ["speaker_0"]),
    true
  );
  assert.equal(db.getMeetingRunSpeakerCorrectionRevision(run.id), 2);
  assert.deepEqual(correctionsOf(run.id), []);
  assert.equal(
    revisionOf(run.id),
    2,
    "the DTO revision must include the cleared tombstone, not just the visible corrections"
  );

  // A new user correction keeps climbing: a display-only sum that read 0 could
  // never reach the Summary's recorded revision.
  assert.equal(
    db.setMeetingRunSpeakerCorrection(run.id, "speaker_0", null, "User name", "user").success,
    true
  );
  assert.equal(revisionOf(run.id), db.getMeetingRunSpeakerCorrectionRevision(run.id));
  assert.equal(revisionOf(run.id), 3);
  assert.equal(recording.id, run.recordingId);

  // The DTO rejects a negative authoritative revision, so the persisted guard
  // (SUM of nonnegative row revisions) cannot be widened accidentally.
  const parsed = meetingProcessingResultDtoSchema.safeParse({
    run: worker.listForNote(note.id)[0].runs.find((item) => item.run.id === run.id)!.run,
    transcript: null,
    summary: null,
    speakerCorrections: [],
    speakerCorrectionRevision: -1,
  });

  assert.equal(parsed.success, false, "negative revision must fail the DTO schema");
});

test("withdrawing a model proposal preserves increasing revisions and protected names", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage);
  const proposal = [{ speakerId: "speaker_a", profileId: null, displayName: "Max" }];
  assert.equal(
    db.applyAutomaticMeetingSpeakerCorrections(run.id, run.id, 0, proposal, "model"),
    true
  );
  assert.equal(
    db.applyAutomaticMeetingSpeakerCorrections(run.id, run.id, 1, [], "model", ["speaker_a"]),
    true
  );
  assert.deepEqual(db.getMeetingRunSpeakerCorrections(run.id), []);
  assert.equal(db.getMeetingRunSpeakerCorrectionRevision(run.id), 2);
  assert.equal(
    db.applyAutomaticMeetingSpeakerCorrections(run.id, run.id, 0, proposal, "model"),
    false
  );
  assert.equal(
    db.applyAutomaticMeetingSpeakerCorrections(run.id, run.id, 1, proposal, "model"),
    false
  );
  assert.equal(
    db.applyAutomaticMeetingSpeakerCorrections(run.id, run.id, 2, proposal, "model"),
    true
  );
  assert.equal(db.getMeetingRunSpeakerCorrections(run.id)[0].revision, 3);
  assert.equal(
    db.setMeetingRunSpeakerCorrection(run.id, "speaker_a", null, "User name", "user").success,
    true
  );
  assert.equal(
    db.applyAutomaticMeetingSpeakerCorrections(run.id, run.id, 3, [], "model", ["speaker_a"]),
    false
  );
  assert.equal(
    db.applyAutomaticMeetingSpeakerCorrections(run.id, run.id, 4, [], "model", ["speaker_a"]),
    false
  );
  assert.equal(
    db.applyAutomaticMeetingSpeakerCorrections(
      run.id,
      run.id,
      4,
      [{ speakerId: "speaker_b", profileId: null, displayName: "Voice" }],
      "voice"
    ),
    true
  );
  assert.equal(
    db.applyAutomaticMeetingSpeakerCorrections(run.id, run.id, 5, [], "model", ["speaker_b"]),
    false
  );
  assert.equal(db.getMeetingRunSpeakerCorrectionRevision(run.id), 5);
  assert.deepEqual(
    db
      .getMeetingRunSpeakerCorrections(run.id)
      .map(({ displayName }: { displayName: string }) => displayName),
    ["User name", "Voice"]
  );
  assert.equal(
    db.applyAutomaticMeetingSpeakerCorrections(
      run.id,
      run.id,
      5,
      [{ speakerId: "speaker_c", profileId: null, displayName: "Guess" }],
      "model"
    ),
    true
  );
  assert.equal(
    db.applyAutomaticMeetingSpeakerCorrections(run.id, run.id, 6, [], "model", ["speaker_c"]),
    true
  );
  assert.equal(
    db.applyAutomaticMeetingSpeakerCorrections(
      run.id,
      run.id,
      7,
      [{ speakerId: "speaker_c", profileId: null, displayName: "New voice match" }],
      "voice"
    ),
    true
  );
  assert.equal(db.getMeetingRunSpeakerCorrectionRevision(run.id), 8);
  assert.equal(
    db.getMeetingRunSpeakerCorrections(run.id)[2].source,
    "voice",
    "a withdrawn name does not block voice recognition"
  );
});

test("repeat naming withdraws a conflicting model identity from the saved correction and Note", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { note, run } = createFinishedRecording(db, storage);
  saveTranscriptArtifact(
    db,
    storage,
    run.id,
    "Max? The build is fixed. Dan? We deploy next.",
    "speaker_0"
  );
  assert.equal(
    db.applyAutomaticMeetingSpeakerCorrections(
      run.id,
      run.id,
      0,
      [{ speakerId: "speaker_0", profileId: null, displayName: "Max" }],
      "model"
    ),
    true
  );
  db.setMeetingProcessingRunState(run.id, { stage: "normalize", status: "pending", retryAt: null });
  let namingCalls = 0;

  const worker = workerFor(db, storage, {
    nameSpeakers: async (input) => {
      namingCalls += 1;
      const parsed = meetingSpeakerNamingInputSchema.parse(input);
      assert.equal(parsed.segments[0].speakerName, "Max");
      assert.equal(parsed.segments[0].speakerNameSource, "model");

      return { speakers: [] };
    },
  });

  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(namingCalls, 1);
  assert.deepEqual(db.getMeetingRunSpeakerCorrections(run.id), []);
  assert.equal(db.getMeetingRunSpeakerCorrectionRevision(run.id), 2);
  const projected = JSON.parse(db.getNote(note.id).transcript ?? "[]");
  assert.equal(projected.length, 1);
  assert.equal(projected[0].speaker, "speaker_0");
  assert.equal(projected[0].speakerIsPlaceholder, true);
  assert.equal(projected[0].speakerName, undefined);
  assert.equal(projected[0].speakerLockSource, undefined);
});

test("audio parts from separate sessions of one note produce one persisted run and one transcription request", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const first = createFinishedRecording(db, storage, validConfig, "Manual notes stay here.");
  assert.ok(first.recording.endedAt);

  const second = db.createMeetingRecording(
    first.note.id,
    { config: validConfig },
    new Date(Date.parse(first.recording.endedAt) + 5 * 60_000).toISOString()
  );

  assert.notEqual(second.groupId, first.recording.groupId);
  db.openMeetingIntentionalInterval(second.id, "mic", 1, 0, "manual-muted", muteAlignment(0));
  db.closeMeetingIntentionalInterval(
    second.id,
    "mic",
    1,
    24_000,
    "manual-muted",
    muteAlignment(24_000)
  );
  db.createMeetingRecordingEpoch(second.id, "system", 0, 1, 0, 0);
  savePcmEpoch(storage, second.id, "system", 0, Buffer.from([1, 2, 3, 4]));
  db.updateMeetingRecordingEpochRecovery(
    second.id,
    "system",
    0,
    storage.recoverEpoch(second.id, "system", 0)
  );
  db.markMeetingRecordingFinalizing(second.id);

  const finalSecond = db.finalizeMeetingRecording(second.id, {
    captureState: "ready",
    endedAt: new Date(Date.parse(second.startedAt) + 1000).toISOString(),
  });

  let asrCalls = 0;
  let mixed: { recording: MixArgs[0]; epochs: MixArgs[2] } | undefined;

  const worker = workerFor(db, storage, {
    mixAudio: async (recording, runId, epochs) => {
      mixed = { recording, epochs };

      return {
        path: storage.getDerivedAudioPath(recording.id, runId),
        frameCount: 48_000,
        durationSeconds: 2,
        sizeBytes: 4096,
      };
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
    kind: "reprocess",
    sourceRecordingIds: [first.recording.id, second.id],
    config: validConfig,
  });

  assert.deepEqual(db.getMeetingProcessingRun(run.id).sourceRecordingIds, [
    first.recording.id,
    second.id,
  ]);
  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(asrCalls, 1);
  assert.ok(mixed);
  assert.equal(
    mixed.recording.endedAt,
    new Date(Date.parse(first.recording.startedAt) + 2000).toISOString()
  );
  assert.deepEqual(
    mixed.epochs.map(({ recordingId, source }) => ({ recordingId, source })),
    [
      { recordingId: first.recording.id, source: "mic" },
      { recordingId: first.recording.id, source: "system" },
      { recordingId: second.id, source: "system" },
    ]
  );
  assert.deepEqual(
    db.listMeetingRecordingEpochs(second.id).map(({ source }: MeetingRecordingEpochDto) => source),
    ["system"]
  );
  assert.deepEqual(
    db
      .listMeetingIntentionalIntervals(second.id)
      .map(
        ({ source, reason, timelineStartFrame, timelineEndFrame }: MeetingIntentionalInterval) => ({
          source,
          reason,
          timelineStartFrame,
          timelineEndFrame,
        })
      ),
    [{ source: "mic", reason: "manual-muted", timelineStartFrame: 0, timelineEndFrame: 24_000 }]
  );
  assert.equal(db.getNote(first.note.id).content, "Manual notes stay here.");
  assert.equal(db.getMeetingProcessingRun(run.id).status, "complete");
});

test("combined transcription cannot include audio from another note", (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const first = createFinishedRecording(db, storage);
  const other = createFinishedRecording(db, storage);
  assert.throws(
    () =>
      db.createMeetingProcessingRun(first.recording.id, {
        kind: "reprocess",
        sourceRecordingIds: [first.recording.id, other.recording.id],
        config: validConfig,
      }),
    /Meeting audio is unavailable for a selected part/
  );
});

test("waits for retention and capture to finish, then persists the response, transcript, and separate summary", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });

  const { note, recording, run } = createFinishedRecording(
    db,
    storage,
    validConfig,
    "  Manual note first.  \n",
    false,
    180
  );

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
  assert.equal(storage.readRunArtifact(run.id, "provider-response").system.text.length, 2500);
  assert.equal(storage.readRunArtifact(run.id, "transcript").segments[0].text.length, 2500);
  assert.deepEqual(parseSummaryInput(summaryInput), {
    meetingTitle: note.title,
    manualNotes: "  Manual note first.  \n",
    transcriptSegments: [
      {
        speakerId: "Speaker 1",
        speakerName: null,
        text: "x".repeat(2500),
      },
    ],
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

  const manual = worker.createRun({
    recordingId: recording.id,
    kind: "reprocess",
    config: validConfig,
  });

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

test("manual reprocess rejects active capture and a successful Stop before its 15-second deadline", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { recording } = createFinishedRecording(db, storage);
  assert.ok(recording.endedAt);
  const deadline = Date.parse(recording.endedAt) + 15_000;
  const now = new Date(deadline - 1);
  const worker = workerFor(db, storage, { now: () => new Date(now) });
  t.after(() => worker.stop());

  assert.throws(
    () => worker.createRun({ recordingId: recording.id, kind: "reprocess", config: validConfig }),
    /end-of-meeting wait/
  );
  now.setTime(deadline);
  assert.equal(
    worker.createRun({ recordingId: recording.id, kind: "reprocess", config: validConfig }).run
      .kind,
    "reprocess"
  );

  const activeWorker = workerFor(db, storage, {
    now: () => new Date(deadline + 60_000),
    isCaptureActive: () => true,
  });

  t.after(() => activeWorker.stop());
  assert.throws(
    () =>
      activeWorker.createRun({ recordingId: recording.id, kind: "reprocess", config: validConfig }),
    /end-of-meeting wait/
  );
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
  worker.captureStarted(recording.noteId);
  assert.equal(db.getMeetingProcessingRun(run.id).status, "cancelled");
  assert.equal(db.getMeetingProcessingRun(run.id).errorCode, "meeting-resumed");

  worker.captureStopped();
  now.setTime(Date.parse(run.retryAt) + 5000);
  const nextEnd = worker.finishForNote(recording.noteId)!;
  assert.ok(nextEnd.run.retryAt);
  const freshDeadline = Date.parse(nextEnd.run.retryAt);
  assert.equal(freshDeadline, now.getTime() + 15_000);
  assert.notEqual(nextEnd.run.id, run.id);
  const duplicate = worker.finishForNote(recording.noteId)!;
  assert.equal(duplicate.run.id, nextEnd.run.id);
});

test("Finish IPC owns chronology, saved config, empty sources and repeated-Finish deduplication", async (t) => {
  const db: DatabaseManager | null = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const note = db.saveNote("Meeting", "Manual text", "meeting").note!;
  const now = new Date("2026-10-04T12:00:00.000Z");
  const worker = workerFor(db, storage, { now: () => new Date(now) });
  t.after(() => worker.stop());
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  registerMeetingProcessingHandlers(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    worker
  );

  const bridge = createMeetingProcessingBridge({
    invoke: async (channel, ...args) => handlers.get(channel)!(null, ...args),
    send() {},
    on() {},
    removeListener() {},
  });

  assert.deepEqual(await bridge.meetingProcessingFinishForNote(note.id), { success: true });
  assert.throws(() => bridge.meetingProcessingFinishForNote(0));

  const part = (startedAt: string, config: MeetingProcessingConfig | null, audio = true) => {
    const recording = db.createMeetingRecording(note.id, { config }, startedAt);

    if (audio) {
      db.createMeetingRecordingEpoch(recording.id, "mic", 0, 1, 0, 0);
      db.updateMeetingRecordingEpochRecovery(recording.id, "mic", 0, {
        frameCount: 2,
        ignoredTrailingBytes: 0,
      });
    }

    db.markMeetingRecordingFinalizing(recording.id);

    return db.finalizeMeetingRecording(recording.id, { captureState: "ready", endedAt: startedAt })
      .recording;
  };

  // Create out of order; the newest saved initial config wins, even if an
  // older part's initial run is blocked by its missing config.
  const latest = part("2026-10-04T11:20:00.000Z", validConfig);
  const earlier = part("2026-10-04T11:10:00.000Z", null);
  part("2026-10-04T11:30:00.000Z", null, false);
  const result = await bridge.meetingProcessingFinishForNote(note.id);
  assert.equal(result.success, true);
  assert.ok(result.result);
  const run = result.result.run;
  assert.deepEqual(run.sourceRecordingIds, [earlier.id, latest.id]);
  assert.deepEqual(
    run.config,
    db.listMeetingProcessingRuns(latest.id).find((item) => item.kind === "initial")!.config
  );
  assert.equal(run.retryAt, "2026-10-04T12:00:15.000Z");
  const duplicate = await bridge.meetingProcessingFinishForNote(note.id);
  assert.equal(duplicate.result?.run.id, run.id);
  now.setTime(now.getTime() + 60_000);
  db.setMeetingProcessingRunState(run.id, { stage: "summary", status: "complete", retryAt: null });
  assert.equal((await bridge.meetingProcessingFinishForNote(note.id)).result?.run.id, run.id);
  assert.equal(db.getNote(note.id)!.content, "Manual text");
});

test("Finish refuses active capture rather than queueing partial sources", (t) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { recording } = createFinishedRecording(db, storage);
  const worker = workerFor(db, storage, { isCaptureActive: () => true });
  t.after(() => worker.stop());
  assert.throws(() => worker.finishForNote(recording.noteId), /after capture stops/);
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
    segments: [
      { type: "transcript.text.segment", speaker: "A", text: "Hello.", start: 0.1, end: 0.5 },
    ],
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
  assert.equal(
    saved.status,
    "complete",
    JSON.stringify({ stage: saved.stage, errorCode: saved.errorCode })
  );
  assert.equal(saved.hasRawProviderResponse, true);
  assert.equal(saved.hasTranscript, true);
  assert.deepEqual(storage.readRunArtifact(run.id, "provider-response").system, raw);
  assert.deepEqual(storage.readRunArtifact(run.id, "transcript").segments, [
    { speaker: "system:A", text: "Hello.", start: 0.1, end: 0.5 },
  ]);
});

test("OpenAI text without speaker segments remains visible as a failed run", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });

  const { run } = createFinishedRecording(db, storage, {
    transcription: {
      mode: "providers",
      provider: "openai",
      model: "gpt-4o-mini-transcribe",
      language: "auto",
    },
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
  assert.equal(saved.errorCode, "provider-timestamps-missing");
  assert.deepEqual(storage.readRunArtifact(run.id, "provider-response").system, raw);
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
  assert.deepEqual(storage.readRunArtifact(run.id, "provider-response").system, {
    malformed: true,
  });
  assert.equal(db.getMeetingProcessingRun(run.id).hasRawProviderResponse, true);
  worker.retry(run.id);
  await worker.waitForIdle();
  assert.equal(transcribeCalls, 1);
  assert.equal(db.getMeetingProcessingRun(run.id).stage, "normalize");
  assert.deepEqual(storage.readRunArtifact(run.id, "provider-response").system, {
    malformed: true,
  });
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

  const worker = workerFor(db, storage, {
    getCredential: () => apiKey,
    now: () => new Date(deadlineNow),
  });

  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(run.id).status, "blocked");
  assert.equal(db.getMeetingProcessingRun(run.id).config, null);

  const handlers = new Map();
  registerMeetingProcessingHandlers(
    { handle: (channel: string, handler: unknown) => handlers.set(channel, handler) },
    worker
  );
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
  assert.equal(
    blockedWithSnapshot.status,
    "blocked",
    "the corrected route remains blocked until its key is available"
  );
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
  registerMeetingProcessingHandlers(
    { handle: (channel: string, handler: unknown) => handlers.set(channel, handler) },
    worker
  );
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

  assert.equal(
    (await update(null, { runId: run.id, config: changedTranscription, configError: null }))
      .success,
    false
  );
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

  const {
    note,
    recording,
    run: oldRun,
  } = createFinishedRecording(db, storage, validConfig, "Manual note stays.", false, 180);

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
  assert.deepEqual(
    {
      content: pendingProjection.content,
      transcript: pendingProjection.transcript,
      enhancedContent: pendingProjection.enhanced_content,
      enhancementPrompt: pendingProjection.enhancement_prompt,
    },
    {
      content: oldProjection.content,
      transcript: oldProjection.transcript,
      enhancedContent: oldProjection.enhanced_content,
      enhancementPrompt: oldProjection.enhancement_prompt,
    },
    "creating or viewing the pending version does not rewrite the existing Note projection"
  );

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
  assert.equal(
    newProjection.enhanced_content,
    "Summary from new run",
    "reprocessing creates a new Summary even when the same audio already has one"
  );
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
  registerMeetingProcessingHandlers(
    { handle: (channel: string, handler: unknown) => handlers.set(channel, handler) },
    worker
  );

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
    send() {},
    on() {},
    removeListener() {},
  });

  assert.throws(() =>
    bridge.meetingProcessingUpdateBlockedRunConfig({
      runId: "00000000-0000-4000-8000-000000000001",
      config: {
        ...validConfig,
        transcription: { ...validConfig.transcription, credentialRef: "secret-value" },
      },
      configError: null,
    })
  );
  assert.equal(calls.length, 0);

  const response = await bridge.meetingProcessingUpdateBlockedRunConfig({
    runId: "00000000-0000-4000-8000-000000000001",
    config: validConfig,
    configError: null,
  });

  assert.deepEqual(calls, [
    [
      meetingProcessingChannels.updateBlockedRunConfig,
      {
        runId: "00000000-0000-4000-8000-000000000001",
        config: validConfig,
        configError: null,
      },
    ],
  ]);
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
    { duration: 180, characters: 2500, eligible: false, generateSummary: false },
    { duration: 10, characters: 100, eligible: true, generateSummary: true },
  ];

  const responseByRequest = new Map<string, ReturnType<typeof longTranscriptResponse>>();

  const runs = cases.map((item) => {
    const { recording, run } = createFinishedRecording(
      db,
      storage,
      {
        ...validConfig,
        generateSummary: "generateSummary" in item ? item.generateSummary : undefined,
      },
      "",
      false,
      item.duration
    );

    responseByRequest.set(`meeting-${run.id}-system`, longTranscriptResponse(item.characters));

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

  assert.deepEqual(
    runs.map(({ run }) => db.getMeetingProcessingRun(run.id).hasSummary),
    [false, false, true, false, true]
  );
  assert.deepEqual(
    summarizedInputs
      .map((input) => parseSummaryInput(input).transcriptSegments[0].text.length)
      .sort((a, b) => a - b),
    [100, 2500]
  );
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

  const manualShort = worker.createRun({
    recordingId: short.recording.id,
    kind: "summary",
    sourceRunId: short.run.id,
    config: validConfig,
  });

  const firstEligibleManual = worker.createRun({
    recordingId: eligible.recording.id,
    kind: "summary",
    sourceRunId: eligible.run.id,
    config: validConfig,
  });

  const duplicateEligibleManual = worker.createRun({
    recordingId: eligible.recording.id,
    kind: "summary",
    sourceRunId: eligible.run.id,
    config: validConfig,
  });

  assert.equal(duplicateEligibleManual.run.id, firstEligibleManual.run.id);
  assert.equal(db.getMeetingProcessingRun(eligible.run.id).status, "cancelled");

  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(manualShort.run.id).hasSummary, true);
  assert.equal(db.getMeetingProcessingRun(firstEligibleManual.run.id).hasSummary, true);
  assert.equal(summarizedInputs.length, 2);
  assert.deepEqual(
    summarizedInputs.map((input) => parseSummaryInput(input).manualNotes).sort(),
    ["User notes remain unchanged.", "Other notes."].sort()
  );
  assert.equal(db.getNote(short.note.id).content, "User notes remain unchanged.");
});

test("speaker naming snapshots calendar candidates and a late user correction wins", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });

  const {
    note,
    recording,
    run: sourceRun,
  } = createFinishedRecording(db, storage, validConfig, "Manual note evidence.");

  db.db.prepare("UPDATE notes SET participants = ? WHERE id = ?").run(
    JSON.stringify([
      { displayName: "Calendar Alice", email: "alice@example.com" },
      { displayName: "bob@example.com", email: "bob@example.com" },
    ]),
    note.id
  );
  storage.writeRunArtifact(sourceRun.id, "provider-response", {
    text: "Transcript with two speakers.",
  });
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
  db.setMeetingProcessingRunState(sourceRun.id, {
    stage: "normalize",
    status: "pending",
    retryAt: null,
  });

  let namingInput: unknown;
  let summaryInput = "";

  const worker = workerFor(db, storage, {
    nameSpeakers: async (input, _config, run) => {
      namingInput = input;
      assert.equal(run.kind, "initial");
      assert.equal(
        db.setMeetingRunSpeakerCorrection(
          sourceRun.id,
          "speaker_a",
          null,
          "User correction",
          "user"
        ).success,
        true
      );

      return {
        speakers: [
          { speakerId: "speaker_a", name: "Model Alice" },
          { speakerId: "speaker_b", name: "Model Bob" },
        ],
      };
    },
    summarize: async (input) => {
      summaryInput = input;

      return "## TLDR\nSpeakers are labeled from the transcript.";
    },
  });

  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();

  const manual = worker.createRun({
    recordingId: recording.id,
    kind: "summary",
    sourceRunId: sourceRun.id,
    config: validConfig,
  });

  worker.onRetentionReady();
  await worker.waitForIdle();

  assert.deepEqual(namingInput, {
    generateTitle: false,
    meetingTitle: "Meeting",
    manualNotes: "Manual note evidence.",
    transcriptSourceId: sourceRun.id,
    participants: [
      { name: "Calendar Alice", email: "alice@example.com" },
      { name: null, email: "bob@example.com" },
    ],
    segments: [
      {
        id: `${sourceRun.id}:0`,
        speakerId: "speaker_a",
        speakerName: null,
        speakerNameSource: null,
        start: 0,
        end: 1,
        text: "I am Alice and I will check the release.",
      },
      {
        id: `${sourceRun.id}:1`,
        speakerId: "speaker_b",
        speakerName: null,
        speakerNameSource: null,
        start: 1,
        end: 2,
        text: "I agree with Alice.",
      },
    ],
  });
  assert.deepEqual(parseSummaryInput(summaryInput), {
    meetingTitle: "Meeting",
    manualNotes: "Manual note evidence.",
    transcriptSegments: [
      {
        speakerId: "Speaker 1",
        speakerName: "User correction",
        text: "I am Alice and I will check the release.",
      },
      { speakerId: "Speaker 2", speakerName: null, text: "I agree with Alice." },
    ],
  });
  assert.deepEqual(db.getMeetingRunSpeakerCorrections(sourceRun.id), [
    {
      speakerId: "speaker_a",
      profileId: null,
      displayName: "User correction",
      participantEmail: null,
      source: "user",
      revision: 1,
    },
  ]);
  const summary = storage.readRunArtifact(manual.run.id, "summary");
  assert.equal(manual.run.sourceRunId, sourceRun.id);
  assert.equal(summary.speakerCorrectionRevision, 1);
  assert.doesNotMatch(JSON.stringify(parseSummaryInput(summaryInput)), /@/);
  assert.deepEqual(
    JSON.parse(db.getMeetingRunLlmSourceSnapshot(manual.run.id) ?? "{}").promptModel,
    validConfig.summary
  );
  assert.equal(db.getNote(note.id).enhanced_content, summary.text);
  assert.match(db.getNote(note.id).transcript ?? "", /User correction/);
  assert.equal(db.getMeetingRecording(recording.id).currentRunId, manual.run.id);
});

test("malformed calendar participants stay visible while eligible automatic Summary completes", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { note, run } = createFinishedRecording(db, storage, validConfig, "", false, 180);
  saveTranscriptArtifact(db, storage, run.id, "x".repeat(2500));
  db.setMeetingProcessingRunState(run.id, { stage: "normalize", status: "pending", retryAt: null });
  db.db.prepare("UPDATE notes SET participants = ? WHERE id = ?").run("{", note.id);
  let namingCalls = 0;
  let summaryCalls = 0;

  const worker = workerFor(db, storage, {
    nameSpeakers: async () => {
      namingCalls += 1;

      return { speakers: [] };
    },
    summarize: async () => {
      summaryCalls += 1;

      return "## TLDR\nSummary.";
    },
  });

  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();

  const automatic = db.getMeetingProcessingRun(run.id);
  assert.ok(automatic);
  assert.equal(automatic.status, "complete");
  assert.equal(automatic.errorCode, null);
  assert.equal(automatic.speakerNamingErrorCode, "calendar-participants-invalid");
  assert.equal(automatic.hasSummary, true);
  assert.equal(JSON.parse(db.getMeetingRunLlmSourceSnapshot(run.id) ?? "{}").participants, null);
  assert.equal(namingCalls, 0);
  assert.equal(summaryCalls, 1);
});

test("participant data corrupted during naming records the error and keeps manual Summary available", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { note, recording, run: sourceRun } = createFinishedRecording(db, storage, validConfig);
  saveTranscriptArtifact(db, storage, sourceRun.id, "A short transcript with an unknown speaker.");
  db.setMeetingProcessingRunState(sourceRun.id, {
    stage: "normalize",
    status: "pending",
    retryAt: null,
  });
  let summaryCalls = 0;

  const worker = workerFor(db, storage, {
    nameSpeakers: async () => {
      db.db.prepare("UPDATE notes SET participants = ? WHERE id = ?").run("{", note.id);

      return { speakers: [{ speakerId: "speaker_0", name: "Model suggestion" }] };
    },
    summarize: async () => {
      summaryCalls += 1;

      return "## TLDR\nSummary.";
    },
  });

  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();

  const summary = worker.createRun({
    recordingId: recording.id,
    kind: "summary",
    sourceRunId: sourceRun.id,
    config: validConfig,
  });

  worker.onRetentionReady();
  await worker.waitForIdle();

  const completed = db.getMeetingProcessingRun(summary.run.id);
  assert.ok(completed);
  assert.equal(completed.status, "complete");
  assert.equal(completed.errorCode, null);
  assert.equal(
    db.getMeetingProcessingRun(sourceRun.id).speakerNamingErrorCode,
    "calendar-participants-invalid"
  );
  assert.equal(completed.hasSummary, true);
  assert.deepEqual(db.getMeetingRunSpeakerCorrections(sourceRun.id), []);
  assert.equal(summaryCalls, 1);
});

test("validated speaker names persist model provenance and both Summary stages use corrected labels", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });

  const {
    note,
    recording,
    run: sourceRun,
  } = createFinishedRecording(db, storage, validConfig, "Notes stay here.");

  saveTranscriptArtifact(db, storage, sourceRun.id, "Alice introduces herself.", "speaker_0");
  db.setMeetingProcessingRunState(sourceRun.id, {
    stage: "normalize",
    status: "pending",
    retryAt: null,
  });
  const namingInputs: unknown[] = [];
  let summaryInput = "";

  const worker = workerFor(db, storage, {
    nameSpeakers: async (input) => {
      namingInputs.push(input);

      return { speakers: [{ speakerId: "speaker_0", name: "Alice" }] };
    },
    summarize: async (input) => {
      summaryInput = input;

      return "## TLDR\nAlice described the release.";
    },
  });

  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();

  const manual = worker.createRun({
    recordingId: recording.id,
    kind: "summary",
    sourceRunId: sourceRun.id,
    config: validConfig,
  });

  worker.onRetentionReady();
  await worker.waitForIdle();

  assert.equal(namingInputs.length, 1);
  assert.deepEqual(parseSummaryInput(summaryInput).transcriptSegments, [
    {
      speakerId: "Speaker 1",
      speakerName: "Alice",
      text: "Alice introduces herself.",
    },
  ]);
  assert.deepEqual(db.getMeetingRunSpeakerCorrections(sourceRun.id), [
    {
      speakerId: "speaker_0",
      profileId: null,
      displayName: "Alice",
      participantEmail: null,
      source: "model",
      revision: 1,
    },
  ]);
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
    assert.deepEqual(reopened.getMeetingRunSpeakerCorrections(sourceRun.id), [
      {
        speakerId: "speaker_0",
        profileId: null,
        displayName: "Alice",
        participantEmail: null,
        source: "model",
        revision: 1,
      },
    ]);
    const savedSnapshot = reopened.getMeetingRunLlmSourceSnapshot(manual.run.id);
    assert.ok(savedSnapshot);
    assert.equal(JSON.parse(savedSnapshot).speakerCorrectionRevision, 1);
  } finally {
    reopened.db.close();
  }
});

test("manual Summary keeps the previously saved result visible without naming speakers again", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });

  const {
    note,
    recording,
    run: sourceRun,
  } = createFinishedRecording(db, storage, validConfig, "Keep this manual note.");

  saveTranscriptArtifact(db, storage, sourceRun.id, "Alice introduces herself.");
  const previousSummary = "## TLDR\nPreviously saved result.";
  storage.writeRunArtifact(sourceRun.id, "summary", { text: previousSummary });
  assert.equal(db.setMeetingRunArtifact(sourceRun.id, "summary").success, true);
  db.setMeetingProcessingRunState(sourceRun.id, { stage: "summary", status: "complete" });
  assert.equal(
    db.selectMeetingProcessingRun(recording.id, sourceRun.id, {
      transcript: JSON.stringify([{ speaker: "speaker_0", text: "Alice introduces herself." }]),
      summary: previousSummary,
      summaryPrompt: validConfig.summary.instruction,
    }).success,
    true
  );

  let summaryStarted!: () => void;

  const started = new Promise<void>((resolve) => {
    summaryStarted = resolve;
  });

  let finishSummary!: () => void;

  const response = new Promise<void>((resolve) => {
    finishSummary = resolve;
  });

  let namingCalls = 0;

  const worker = workerFor(db, storage, {
    nameSpeakers: async () => {
      namingCalls += 1;

      return { speakers: [{ speakerId: "speaker_0", name: "Alice" }] };
    },
    summarize: async () => {
      summaryStarted();
      await response;

      return "## TLDR\nNew result.";
    },
  });

  t.after(() => worker.stop());

  const manual = worker.createRun({
    recordingId: recording.id,
    kind: "summary",
    sourceRunId: sourceRun.id,
    config: validConfig,
  });

  assert.equal(manual.summary?.text, previousSummary);
  worker.onRetentionReady();
  await started;

  const inProgress = worker
    .listForNote(note.id)[0]
    .runs.find((item) => item.run.id === manual.run.id);

  assert.equal(inProgress?.summary?.text, previousSummary);
  assert.equal(db.getNote(note.id).enhanced_content, previousSummary);
  assert.equal(namingCalls, 0);
  assert.deepEqual(db.getMeetingRunSpeakerCorrections(sourceRun.id), []);

  finishSummary();
  await worker.waitForIdle();
  assert.equal(storage.readRunArtifact(manual.run.id, "summary").text, "## TLDR\nNew result.");
  assert.equal(db.getNote(note.id).enhanced_content, "## TLDR\nNew result.");
  assert.equal(db.getNote(note.id).content, "Keep this manual note.");
});

test("prioritized tasks and Recap serialize their edits to the selected Summary", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });

  const { note, recording, run } = createFinishedRecording(
    db,
    storage,
    validConfig,
    "Manual notes stay here.",
    false,
    180
  );

  db.db
    .prepare("UPDATE notes SET participants = ? WHERE id = ?")
    .run(JSON.stringify([{ name: "Calendar Alice", email: "alice@example.com" }]), note.id);

  let resolveTaskStarted!: () => void;

  const taskStarted = new Promise<void>((resolve) => {
    resolveTaskStarted = resolve;
  });

  let releaseTasks!: () => void;

  const taskGate = new Promise<void>((resolve) => {
    releaseTasks = resolve;
  });

  let taskCalls = 0;
  let taskInput = "";
  let recapInput = "";
  const writeArtifact = storage.writeRunArtifact.bind(storage);
  const savedTaskStatuses: string[] = [];
  storage.writeRunArtifact = (...args: Parameters<RecordingStorage["writeRunArtifact"]>) => {
    const [id, kind, value] = args;

    if (
      id === run.id &&
      kind === "summary" &&
      typeof value === "object" &&
      value !== null &&
      "taskStatus" in value
    ) {
      savedTaskStatuses.push(String(value.taskStatus));
    }

    writeArtifact(id, kind, value);
  };

  const worker = workerFor(db, storage, {
    transcribeRemote: async (_request, saveRaw) => {
      await saveRaw(longTranscriptResponse());

      return { success: true };
    },
    summarize: async () =>
      "## TLDR\nRelease discussion.\n\n## Action Items\n\n- Initial action item.",
    createActionConversation: async (_config, instruction) => ({
      send: async (input: string) => {
        if (instruction === MEETING_TASKS_INSTRUCTION) {
          taskCalls++;
          taskInput = input;
          resolveTaskStarted();
          await taskGate;

          return { text: "### HIGH\n- Ship the release", refusal: false };
        }

        assert.equal(instruction, "Editable recap prompt");
        recapInput = input;

        return {
          text: JSON.stringify({ title: "Release review", bullets: ["Ship Friday"] }),
          refusal: false,
        };
      },
    }),
    getActionPrompt: (translationKey) =>
      translationKey === RECAP_KEY ? "Editable recap prompt" : null,
  });

  t.after(() => {
    releaseTasks();
    worker.stop();
  });
  worker.onRetentionReady();
  await taskStarted;
  assert.deepEqual(
    savedTaskStatuses.slice(0, 2),
    ["pending", "running"],
    "new Summary persists task intent before provider work"
  );
  worker.processPending();
  assert.deepEqual(await worker.runSummaryAction({ runId: run.id, action: "tasks" }), {
    success: true,
  });
  assert.equal(taskCalls, 1, "automatic and explicit scheduling deduplicate in-flight tasks");

  assert.match(taskInput, /Meeting title \(topic hint\):\nMeeting/);
  assert.match(taskInput, /Manual notes:\nManual notes stay here\./);
  assert.match(taskInput, /Initial action item/);
  assert.match(
    taskInput,
    /Speaker 1 \[0:00–0:00\]: "x{2500}"/,
    "Tasks receives both boundaries and the full original utterance"
  );
  assert.doesNotMatch(taskInput, /"id":|"transcriptSegments":/);
  assert.doesNotMatch(taskInput, /alice@example\.com|generationDate|previousTask/i);

  const recapResult = await worker.runSummaryAction({ runId: run.id, action: "recap" });
  assert.deepEqual(recapResult, { success: true });
  assert.match(recapInput, /Saved summary \(verify against source\):/);
  assert.match(recapInput, /<transcript>/);
  assert.doesNotMatch(recapInput, /alice@example\.com|generationDate/i);
  const withRecap = storage.readRunArtifact(run.id, "summary");
  assert.match(withRecap.text, /## Recap/);
  assert.doesNotMatch(withRecap.text, /Ship the release/);
  assert.equal(withRecap.taskStatus, "running");

  const rawResponse = storage.readRunArtifact(run.id, "provider-response");
  releaseTasks();
  await worker.waitForIdle();
  const finalSummary = storage.readRunArtifact(run.id, "summary");
  assert.equal(finalSummary.taskStatus, "complete");
  assert.match(finalSummary.text, /## Action Items[\s\S]*Ship the release[\s\S]*## Recap/);
  assert.match(finalSummary.text, /Release discussion/);
  assert.deepEqual(storage.readRunArtifact(run.id, "provider-response"), rawResponse);
  assert.equal(db.getNote(note.id).content, "Manual notes stay here.");
  assert.equal(db.getNote(note.id).enhanced_content, finalSummary.text);
  assert.equal(db.getMeetingRecording(recording.id).currentRunId, run.id);
});

test("BB task and Recap turns on one saved run stay sequential", async (t: import("node:test").TestContext) => {
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

  const { run } = createFinishedRecording(
    db,
    storage,
    config,
    "Manual notes stay here.",
    false,
    180
  );

  let resolveTaskStarted!: () => void;

  const taskStarted = new Promise<void>((resolve) => {
    resolveTaskStarted = resolve;
  });

  let releaseTasks!: () => void;

  const taskGate = new Promise<void>((resolve) => {
    releaseTasks = resolve;
  });

  const actionOrder: string[] = [];

  const worker = workerFor(db, storage, {
    transcribeRemote: async (_request, saveRaw) => {
      await saveRaw(longTranscriptResponse());

      return { success: true };
    },
    summarizeAgent: async () =>
      "## TLDR\nRelease discussion.\n\n## Action Items\n\n- Initial action item.",
    createActionConversation: async (_config, instruction) => ({
      send: async () => {
        if (instruction === MEETING_TASKS_INSTRUCTION) {
          actionOrder.push("tasks");
          resolveTaskStarted();
          await taskGate;

          return { text: "### HIGH\n- Ship the release", refusal: false };
        }

        assert.equal(instruction, "Editable recap prompt");
        actionOrder.push("recap");

        return {
          text: JSON.stringify({ title: "Release review", bullets: ["Ship Friday"] }),
          refusal: false,
        };
      },
    }),
    getActionPrompt: (translationKey) =>
      translationKey === RECAP_KEY ? "Editable recap prompt" : null,
  });

  t.after(() => {
    releaseTasks();
    worker.stop();
  });
  worker.onRetentionReady();
  await taskStarted;

  const recapPromise = worker.runSummaryAction({ runId: run.id, action: "recap" });
  assert.deepEqual(actionOrder, ["tasks"]);
  releaseTasks();
  assert.deepEqual(await recapPromise, { success: true });
  await worker.waitForIdle();

  assert.deepEqual(actionOrder, ["tasks", "recap"]);
  const summary = storage.readRunArtifact(run.id, "summary");
  assert.equal(summary.taskStatus, "complete");
  assert.match(summary.text, /Ship the release/);
  assert.match(summary.text, /## Recap/);
});

test("task application preserves a concurrent Action Items edit and exposes a retryable conflict", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });

  const { note, run } = createFinishedRecording(
    db,
    storage,
    validConfig,
    "Manual notes stay here.",
    false,
    180
  );

  let resolveTaskStarted!: () => void;

  const taskStarted = new Promise<void>((resolve) => {
    resolveTaskStarted = resolve;
  });

  let releaseTasks!: () => void;

  const taskGate = new Promise<void>((resolve) => {
    releaseTasks = resolve;
  });

  const worker = workerFor(db, storage, {
    transcribeRemote: async (_request, saveRaw) => {
      await saveRaw(longTranscriptResponse());

      return { success: true };
    },
    summarize: async () => "## TLDR\nSaved Summary.\n\n## Action Items\n\n- Existing task",
    createActionConversation: async () => ({
      send: async () => {
        resolveTaskStarted();
        await taskGate;

        return { text: "### HIGH\n- New task", refusal: false };
      },
    }),
  });

  t.after(() => {
    releaseTasks();
    worker.stop();
  });
  worker.onRetentionReady();
  await taskStarted;

  const humanEdit = "## TLDR\nSaved Summary.\n\n## Action Items\n\n- User's revised task";
  db.db.prepare("UPDATE notes SET enhanced_content = ? WHERE id = ?").run(humanEdit, note.id);
  releaseTasks();
  await worker.waitForIdle();

  const summary = storage.readRunArtifact(run.id, "summary");
  assert.equal(summary.taskStatus, "conflict");
  assert.equal(summary.taskErrorCode, "meeting-summary-edit-conflict");
  assert.equal(db.getNote(note.id).enhanced_content, humanEdit);
  assert.doesNotMatch(summary.text, /New task/);
});

test("task application conflicts when a concurrent heading changes the Action Items boundary", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });

  const { note, run } = createFinishedRecording(
    db,
    storage,
    validConfig,
    "Manual notes stay here.",
    false,
    180
  );

  let resolveTaskStarted!: () => void;

  const taskStarted = new Promise<void>((resolve) => {
    resolveTaskStarted = resolve;
  });

  let releaseTasks!: () => void;

  const taskGate = new Promise<void>((resolve) => {
    releaseTasks = resolve;
  });

  const worker = workerFor(db, storage, {
    transcribeRemote: async (_request, saveRaw) => {
      await saveRaw(longTranscriptResponse());

      return { success: true };
    },
    summarize: async () => "## TLDR\nSaved Summary.\n\n## Action Items\n\n- Existing task",
    createActionConversation: async () => ({
      send: async () => {
        resolveTaskStarted();
        await taskGate;

        return { text: "### HIGH\n- New task", refusal: false };
      },
    }),
  });

  t.after(() => {
    releaseTasks();
    worker.stop();
  });
  worker.onRetentionReady();
  await taskStarted;

  const humanEdit =
    "## TLDR\nSaved Summary.\n\n## Action Items\n\n- Existing task\n\n## Notes\n\nKeep this section.";

  db.db.prepare("UPDATE notes SET enhanced_content = ? WHERE id = ?").run(humanEdit, note.id);
  releaseTasks();
  await worker.waitForIdle();

  const summary = storage.readRunArtifact(run.id, "summary");
  assert.equal(summary.taskStatus, "conflict");
  assert.equal(summary.taskErrorCode, "meeting-summary-edit-conflict");
  assert.equal(db.getNote(note.id).enhanced_content, humanEdit);
  assert.doesNotMatch(summary.text, /New task/);
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

  const transcript = meetingTranscriptArtifactSchema.parse(
    storage.readRunArtifact(run.id, "transcript")
  );

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
  assert.deepEqual(
    transcript.segments.map((segment) => segment.speaker),
    ["speaker_1", "speaker_2"]
  );
});

test("new capture lets an issued remote request save raw but defers normalize and summary", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage, validConfig, "", false, 180);
  let started!: () => void;

  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });

  let finishRequest!: () => void;

  const requestResult = new Promise<void>((resolve) => {
    finishRequest = resolve;
  });

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
  storage.writeRunArtifact(run.id, "provider-response", {
    mic: { text: "", words: [] },
    system: elevenResponse,
  });
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
  storage.writeRunArtifact(run.id, "provider-response", {
    mic: { text: "", words: [] },
    system: elevenResponse,
  });
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
  storage.writeRunArtifact(run.id, "provider-response", {
    mic: { text: "", words: [] },
    system: elevenResponse,
  });
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
    transcribeRemote: async () => {
      asrCalls++;
      throw new Error("ASR must not repeat");
    },
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
  assert.ok(recording.endedAt);
  let requests = 0;

  const worker = workerFor(db, storage, {
    now: () => new Date(Date.parse(recording.endedAt!) + 15_000),
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
  assert.deepEqual(
    storage.readRunArtifact(elevenRun.id, "provider-response").system,
    elevenResponse
  );
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

  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });

  let finishRequest!: () => void;

  const requestResult = new Promise<void>((resolve) => {
    finishRequest = resolve;
  });

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

test("mixer decodes epochs once and uses fixed-track assembly with exact duration", async (t: import("node:test").TestContext) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const note = db.saveNote("Mixer", "", "meeting").note;
  const startedAt = new Date("2026-09-24T10:00:00.000Z");

  const recording = db.createMeetingRecording(
    note.id,
    { config: validConfig },
    startedAt.toISOString()
  );

  const epochs: Array<{ source: "mic" | "system"; index: number; offset: number; bytes: Buffer }> =
    [
      { source: "mic", index: 0, offset: 0, bytes: Buffer.alloc(1920, 1) },
      { source: "system", index: 0, offset: 1440, bytes: Buffer.alloc(1920, 3) },
      { source: "mic", index: 1, offset: 2880, bytes: Buffer.alloc(1920, 5) },
    ];

  for (const epoch of epochs) {
    db.createMeetingRecordingEpoch(
      recording.id,
      epoch.source,
      epoch.index,
      1,
      epoch.offset,
      epoch.offset
    );
    savePcmEpoch(storage, recording.id, epoch.source, epoch.index, epoch.bytes);
    db.updateMeetingRecordingEpochRecovery(recording.id, epoch.source, epoch.index, {
      frameCount: epoch.bytes.length / 2,
      ignoredTrailingBytes: 0,
    });
  }

  db.markMeetingRecordingFinalizing(recording.id);

  const finalized = db.finalizeMeetingRecording(recording.id, {
    captureState: "incomplete",
    endedAt: new Date(startedAt.getTime() + 200).toISOString(),
  }).recording;

  const originalRaw = epochs.map((epoch) =>
    fs.readFileSync(storage.getEpochFilePath(recording.id, epoch.source, epoch.index))
  );

  const commands: Array<{ command: string; args: string[] }> = [];
  const { spawn } = require("node:child_process");

  const result = await prepareMeetingAudio(
    storage,
    finalized,
    db.listMeetingProcessingRuns(recording.id)[0].id,
    db.listMeetingRecordingEpochs(recording.id),
    {
      deps: {
        ffmpegPath: () => getFFmpegPath(),
        availableBytes: (directory: string) => {
          assert.equal(fs.statSync(directory).isDirectory(), true);

          return 1_000_000;
        },
        spawn: (command: string, args: string[], options: import("node:child_process").SpawnOptions) => {
          commands.push({ command, args });
          return spawn(command, args, options);
        },
      },
    }
  );

  const decodes = commands.filter(({ args }) => args.includes("pcm_f32le"));
  assert.equal(decodes.length, 3);
  assert.deepEqual(decodes.map(({ args }) => args[args.indexOf("-i") + 1]).sort(),
    epochs.map(epoch => storage.getEpochFilePath(recording.id, epoch.source, epoch.index)).sort());
  assert.equal(commands.filter(({ command }) => command.endsWith("meeting-resampler")).length, 3);
  const assembly = commands.find(({ args }) => args.includes("-filter_complex"))!;
  const graph = assembly.args[assembly.args.indexOf("-filter_complex") + 1];
  assert.match(graph, /amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,volume=0\.5/);
  assert.doesNotMatch(graph, /asplit|atempo|adelay|atrim/);
  assert.equal(result.frameCount, 4800);
  assert.equal(result.durationSeconds, 4800 / 24_000);
  assert.equal(result.sizeBytes, fs.statSync(result.path).size);
  assert.deepEqual(
    epochs.map((epoch) =>
      fs.readFileSync(storage.getEpochFilePath(recording.id, epoch.source, epoch.index))
    ),
    originalRaw
  );
  const wav = fs.readFileSync(result.path);
  assert.equal(wav.readUInt32LE(wav.indexOf(Buffer.from("data")) + 4), 4800 * 2);
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

  const recording = db.createMeetingRecording(
    note.id,
    { config: validConfig },
    startedAt.toISOString()
  );

  const sourceEpochs: { source: string; offset: number; values: number[][]; raw?: Buffer }[] = [
    {
      source: "mic",
      offset: 0,
      values: [
        [5, 10_000],
        [6, 10_000],
      ],
    },
    {
      source: "system",
      offset: 480,
      values: [
        [5, 6_000],
        [6, 6_000],
      ],
    },
  ];

  for (const [index, epoch] of sourceEpochs.entries()) {
    db.createMeetingRecordingEpoch(recording.id, epoch.source, 0, 1, epoch.offset, epoch.offset);
    const raw = Buffer.alloc(960 * 2);

    for (const [frame, sample] of epoch.values) raw.writeInt16LE(sample, frame * 2);
    savePcmEpoch(storage, recording.id, epoch.source as "mic" | "system", 0, raw);
    db.updateMeetingRecordingEpochRecovery(recording.id, epoch.source, 0, {
      frameCount: raw.length / 2,
      ignoredTrailingBytes: 0,
    });
    sourceEpochs[index].raw = fs.readFileSync(
      storage.getEpochFilePath(recording.id, epoch.source, 0)
    );
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
  assert.ok(
    wav.subarray(dataStart, dataStart + 480 * 2).some((value) => value !== 0),
    "mic signal is audible in its saved interval"
  );
  assert.ok(
    wav.subarray(dataStart + 480 * 2, dataStart + 1440 * 2).some((value) => value !== 0),
    "system signal is audible in its saved interval"
  );

  for (let frame = 1_500; frame < 3_500; frame += 1) {
    assert.equal(
      wav.readInt16LE(dataStart + frame * 2),
      0,
      `timeline gap is silent at frame ${frame}`
    );
  }

  for (const layout of ["stereo", "mic", "system"] as const) {
    const prepared = await prepareMeetingAudio(
      storage,
      finalized,
      run.id,
      db.listMeetingRecordingEpochs(recording.id),
      { layout, deps: { ffmpegPath: () => ffmpegPath } }
    );

    const wav = fs.readFileSync(prepared.path);
    const start = wav.indexOf(Buffer.from("data")) + 8;
    const channels = layout === "stereo" ? 2 : 1;
    assert.equal(wav.readUInt32LE(start - 4), 4800 * 2 * channels);

    const sample = (frame: number, channel = 0) =>
      wav.readInt16LE(start + (frame * channels + channel) * 2);

    if (layout === "system") assert.equal(sample(5), 0);

    if (layout === "stereo") {
      assert.equal(sample(5, 1), 0);
      assert.ok(wav.subarray(start + 480 * 4, start + 1440 * 4).some((value) => value !== 0));
    }

    assert.equal(sample(2000), 0);
    assert.equal(
      (
        await prepareMeetingAudio(
          storage,
          finalized,
          run.id,
          db.listMeetingRecordingEpochs(recording.id),
          { layout, deps: { ffmpegPath: () => ffmpegPath } }
        )
      ).path,
      prepared.path
    );
  }

  for (const epoch of sourceEpochs) {
    assert.deepEqual(
      fs.readFileSync(storage.getEpochFilePath(recording.id, epoch.source, 0)),
      epoch.raw,
      `${epoch.source} raw source remains immutable`
    );
  }
});

for (const provider of ["elevenlabs", "openai", "gemini"] as const) {
  test(`${provider}: both source requests run in parallel, keep overlaps and assign the profile name`, async (t) => {
    const db = createDb(t);

    if (!db) return;
    const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });

    const { run } = createFinishedRecording(db, storage, {
      ...validConfig,
      selfDisplayName: "Автор",
      transcription: { mode: "providers", provider, language: "ru" },
    });

    let release!: () => void;

    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });

    const requests: import("../../src/contracts/uploadTranscription").RemoteTranscriptionRequest[] =
      [];

    const worker = workerFor(
      db,
      storage,
      {
        transcribeRemote: async (request, saveRaw) => {
          requests.push(request);

          if (requests.length === 2) release();
          await bothStarted;
          const mic = request.diarize === false;

          const segments = mic
            ? [{ text: "My words", start: 0.2, end: 0.7, speaker: "A" }]
            : [
                { text: "Remote one", start: 0.1, end: 0.4, speaker: "A" },
                { text: "Remote two", start: 0.5, end: 0.8, speaker: "B" },
              ];

          const text = segments.map((s) => s.text).join(" ");
          await saveRaw(
            provider === "openai"
              ? { text, segments }
              : provider === "elevenlabs"
                ? {
                    text,
                    words: segments.map((s) => ({ ...s, type: "word", speaker_id: s.speaker })),
                  }
                : {
                    status: "completed",
                    output_text: text,
                    steps: [
                      {
                        content: [
                          {
                            annotations: segments.map((s) => ({
                              type: "word_info",
                              text: s.text,
                              speaker: s.speaker,
                              start_offset: `${s.start}s`,
                              end_offset: `${s.end}s`,
                            })),
                          },
                        ],
                      },
                    ],
                  }
          );

          return { success: true };
        },
      },
      false
    );

    t.after(() => worker.stop());
    worker.onRetentionReady();
    await worker.waitForIdle();
    assert.equal(db.getMeetingProcessingRun(run.id).status, "complete");
    assert.equal(requests.length, 2);
    assert.equal(new Set(requests.map((request) => request.requestId)).size, 2);
    assert.deepEqual(
      requests.map((request) => request.diarize),
      [false, true]
    );
    assert.ok(requests[0].filePath.endsWith("-mic.wav"));
    assert.ok(requests[1].filePath.endsWith("-system.wav"));

    if (provider === "openai") assert.equal(requests[0].model, "whisper-1");
    const transcript = storage.readRunArtifact(run.id, "transcript");
    assert.deepEqual(
      transcript.segments.map((s: { speaker: string; start: number }) => [s.speaker, s.start]),
      [
        ["system:A", 0.1],
        ["mic", 0.2],
        ["system:B", 0.5],
      ]
    );
    assert.equal(
      db
        .getMeetingRunSpeakerCorrections(run.id)
        .find((s: { speakerId: string; displayName: string }) => s.speakerId === "mic")
        ?.displayName,
      "Автор"
    );
  });
}

test("a successful mic response survives a worker restart and is not sent again", async (t) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage);
  const calls: boolean[] = [];
  let failSystem = true;

  const transcribeRemote: MeetingProcessingWorkerDeps["transcribeRemote"] = async (
    request,
    saveRaw
  ) => {
    calls.push(request.diarize === true);

    if (request.diarize && failSystem)
      return { success: false, code: "TRANSCRIPTION_FAILED", error: "failed" };
    await saveRaw(elevenResponse);

    return { success: true };
  };

  const worker = workerFor(db, storage, { transcribeRemote }, false);
  worker.onRetentionReady();
  await worker.waitForIdle();
  worker.stop();
  assert.equal(db.getMeetingProcessingRun(run.id).status, "failed");
  assert.equal(storage.hasRunArtifact(run.id, "provider-response-mic"), true);
  assert.equal(storage.hasRunArtifact(run.id, "provider-response"), false);
  const original = storage.readRunArtifact(run.id, "provider-response-mic");
  db.setMeetingProcessingRunState(run.id, {
    stage: "asr",
    status: "blocked",
    errorCode: "provider-limit",
  });
  assert.equal(
    worker.updateBlockedRunConfig({
      runId: run.id,
      configError: null,
      config: {
        ...validConfig,
        transcription: { mode: "providers", provider: "deepgram", language: "en" },
      },
    }),
    null,
    "a cached source fixes the provider for this run"
  );
  db.setMeetingProcessingRunState(run.id, {
    stage: "asr",
    status: "failed",
    errorCode: "TRANSCRIPTION_FAILED",
  });
  failSystem = false;
  const resumed = workerFor(db, storage, { transcribeRemote }, false);
  t.after(() => resumed.stop());
  resumed.retry(run.id);
  resumed.onRetentionReady();
  await resumed.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(run.id).status, "complete");
  assert.deepEqual(calls, [false, true, true]);
  assert.deepEqual(storage.readRunArtifact(run.id, "provider-response-mic"), original);
  assert.equal(
    db
      .getMeetingRunSpeakerCorrections(run.id)
      .find((s: { speakerId: string; displayName: string }) => s.speakerId === "mic")?.displayName,
    "You"
  );
});

test("Deepgram uses one stereo request and distinct channel identities", async (t) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });

  const { run } = createFinishedRecording(db, storage, {
    ...validConfig,
    selfDisplayName: "Owner",
    transcription: { mode: "providers", provider: "deepgram", model: "nova-3", language: "auto" },
  });

  let calls = 0;
  const layouts: unknown[] = [];

  const worker = workerFor(db, storage, {
    mixAudio: async (recording, runId, _epochs, _signal, layout) => {
      layouts.push(layout);

      return {
        path: storage.getDerivedAudioPath(recording.id, runId, layout),
        frameCount: 24000,
        durationSeconds: 1,
        sizeBytes: 48044,
      };
    },
    transcribeRemote: async (request, saveRaw) => {
      calls++;
      assert.equal(request.multichannel, true);
      assert.equal(request.diarize, true);
      assert.ok(request.filePath.endsWith("-stereo.wav"));
      await saveRaw({
        results: {
          channels: [
            { alternatives: [{ transcript: "Me" }] },
            { alternatives: [{ transcript: "Them" }] },
          ],
          utterances: [
            { channel: 1, speaker: 0, transcript: "Them", start: 0.3, end: 0.7 },
            { channel: 0, speaker: 0, transcript: "Me", start: 0.1, end: 0.5 },
          ],
        },
      });

      return { success: true };
    },
  });

  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(run.id).status, "complete");
  assert.equal(calls, 1);
  assert.deepEqual(layouts, ["stereo"]);
  assert.deepEqual(
    storage
      .readRunArtifact(run.id, "transcript")
      .segments.map((s: { speaker: string }) => s.speaker),
    ["mic", "system:Speaker 1"]
  );
  assert.equal(db.getMeetingRunSpeakerCorrections(run.id)[0].displayName, "Owner");
});

test("retry normalizes a saved Deepgram response whose last word ends after the audio", async (t) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });

  const { run } = createFinishedRecording(db, storage, {
    ...validConfig,
    transcription: { mode: "providers", provider: "deepgram", model: "nova-3", language: "auto" },
  });

  const raw = {
    results: {
      channels: [
        { alternatives: [{ transcript: "Me" }] },
        { alternatives: [{ transcript: "Them" }] },
      ],
      utterances: [
        { channel: 0, speaker: 0, transcript: "Me", start: 0.1, end: 0.5 },
        { channel: 1, speaker: 0, transcript: "Them", start: 0.7, end: 3 },
      ],
    },
  };

  storage.writeRunArtifact(run.id, "provider-response", raw);
  assert.equal(db.setMeetingRunArtifact(run.id, "provider-response").success, true);
  assert.equal(
    db.setMeetingProcessingRunState(run.id, {
      stage: "normalize",
      status: "failed",
      errorCode: "transcript-timing-invalid",
    }).success,
    true
  );

  const worker = workerFor(db, storage, {
    transcribeRemote: async () => {
      throw new Error("Cached response must not trigger ASR");
    },
  });

  t.after(() => worker.stop());
  assert.ok(worker.retry(run.id));
  worker.onRetentionReady();
  await worker.waitForIdle();

  assert.equal(db.getMeetingProcessingRun(run.id).status, "complete");
  assert.equal(storage.readRunArtifact(run.id, "transcript").segments[1].end, 1);
  assert.deepEqual(storage.readRunArtifact(run.id, "provider-response"), raw);
});

test("speaker-to-calendar linking crosses IPC, survives restart and enriches only later candidate names", async (t) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { note, recording, run } = createFinishedRecording(db, storage);
  db.updateNote(note.id, { participants: JSON.stringify([{ email: " PERSON@example.com " }]) });
  db.upsertGooglePeople([
    {
      email: "person@example.com",
      displayName: "Google name",
      photoUrl: "https://example.com/photo.jpg",
    },
  ]);
  saveTranscriptArtifact(db, storage, run.id, "I am Maya.", "system:A");
  const worker = workerFor(db, storage);
  t.after(() => worker.stop());
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  registerMeetingProcessingHandlers(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    worker
  );

  const bridge = createMeetingProcessingBridge({
    invoke: async (channel, ...args) => handlers.get(channel)!(null, ...args),
    send() {},
    on: () => {},
    removeListener: () => {},
  });

  const correction = {
    runId: run.id,
    speakerId: "system:A",
    displayName: "Maya Solano",
    profileId: null,
  };

  assert.equal(
    (
      await bridge.meetingProcessingSetSpeakerCorrection({
        ...correction,
        participantEmail: "stranger@example.com",
      })
    ).success,
    false
  );
  assert.equal(
    (
      await bridge.meetingProcessingSetSpeakerCorrection({
        ...correction,
        speakerId: "missing",
        participantEmail: "person@example.com",
      })
    ).success,
    false
  );
  assert.equal(
    (
      await bridge.meetingProcessingSetSpeakerCorrection({
        ...correction,
        participantEmail: "PERSON@example.com",
      })
    ).success,
    true
  );
  db.upsertGooglePeople([
    { email: "person@example.com", displayName: "Refreshed Google name", photoUrl: null },
  ]);
  db.upsertContacts([{ email: "person@example.com", displayName: "Calendar name" }]);
  const reopened = new DatabaseManagerClass();
  t.after(() => reopened.db.close());
  assert.deepEqual(reopened.getContactProfiles(["person@example.com"]), [
    {
      email: "person@example.com",
      display_name: "Maya Solano",
      photo_url: "https://example.com/photo.jpg",
    },
  ]);
  assert.equal(reopened.searchContacts("Maya Solano")[0].email, "person@example.com");
  worker.stop();
  // A new transcript has new speaker IDs: the stored name is a candidate, never an automatic voice match.
  let input: unknown;

  const nextWorker = workerFor(db, storage, {
    now: () => new Date(Date.now() + 300_000),
    nameSpeakers: async (value) => {
      input = value;

      return { speakers: [] };
    },
  });

  t.after(() => nextWorker.stop());

  const next = nextWorker.createRun({
    recordingId: recording.id,
    kind: "reprocess",
    config: validConfig,
  });

  nextWorker.onRetentionReady();
  await nextWorker.waitForIdle();
  assert.deepEqual((input as { participants: unknown[] }).participants, [
    { name: "Maya Solano", email: "PERSON@example.com" },
  ]);
  assert.deepEqual(db.getMeetingRunSpeakerCorrections(next.run.id), []);
  assert.equal(db.getMeetingProcessingRun(next.run.id).hasSummary, true);
});

test("a failed naming repair does not stop a new Summary after retranscription", async (t) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { recording, run } = createFinishedRecording(db, storage, validConfig, "", false, 180);
  let summaries = 0;

  const worker = workerFor(db, storage, {
    now: () => new Date(Date.now() + 300_000),
    transcribeRemote: async (_request, saveRaw) => {
      await saveRaw(longTranscriptResponse());

      return { success: true };
    },
    nameSpeakers: async () => {
      throw Object.assign(new Error("invalid names"), { code: "speaker-name-json-invalid" });
    },
    summarize: async () => `## TLDR\nSummary ${++summaries}`,
  });

  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();

  const next = worker.createRun({
    recordingId: recording.id,
    kind: "reprocess",
    config: validConfig,
  });

  await worker.waitForIdle();
  assert.equal(summaries, 2);
  assert.equal(
    db.getMeetingProcessingRun(next.run.id).speakerNamingErrorCode,
    "speaker-name-json-invalid"
  );
  assert.equal(db.getMeetingProcessingRun(next.run.id).status, "complete");
  assert.equal(storage.readRunArtifact(run.id, "summary").text, "## TLDR\nSummary 1");
  assert.equal(storage.readRunArtifact(next.run.id, "summary").text, "## TLDR\nSummary 2");
});

test("the first grouped transcription keeps the automatic Summary duration threshold", async (t) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { recording, run } = createFinishedRecording(db, storage);
  db.setMeetingProcessingRunState(run.id, { stage: "prepare", status: "cancelled" });

  const grouped = db.createMeetingProcessingRun(recording.id, {
    kind: "reprocess",
    config: validConfig,
  });

  let summaries = 0;

  const worker = workerFor(db, storage, {
    transcribeRemote: async (_request, saveRaw) => {
      await saveRaw(longTranscriptResponse());

      return { success: true };
    },
    summarize: async () => {
      summaries++;

      return "Summary";
    },
  });

  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(grouped.id).status, "complete");
  assert.equal(db.getMeetingProcessingRun(grouped.id).hasTranscript, true);
  assert.equal(summaries, 0);
});

for (const [reply, status] of [
  ["", "zero"],
  ['{"HIGH":["Task"]}', "format-error"],
] as const) {
  test(`task output ${status} makes one request and never asks for JSON repair`, async (t) => {
    const db = createDb(t);

    if (!db) return;
    const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
    const { run } = createFinishedRecording(db, storage, validConfig, "", false, 180);
    let requests = 0;

    const worker = workerFor(db, storage, {
      transcribeRemote: async (_request, saveRaw) => {
        await saveRaw(longTranscriptResponse());

        return { success: true };
      },
      summarize: async () => "## TLDR\nSummary.\n\n## Action Items\n- Initial task",
      createActionConversation: async () => ({
        send: async () => {
          requests++;

          return { text: reply, refusal: false };
        },
      }),
    });

    t.after(() => worker.stop());
    worker.onRetentionReady();
    await worker.waitForIdle();
    const artifact = storage.readRunArtifact(run.id, "summary");
    assert.equal(requests, 1);
    assert.equal(artifact.taskStatus, status);
    assert.match(artifact.text, /## TLDR\nSummary/);

    if (status === "zero") assert.doesNotMatch(artifact.text, /## Action Items/);
    else assert.match(artifact.text, /Initial task/);
  });
}

test("Transcribe determines speaker names while Summary-only never repeats naming or ASR after restart", async (t) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { recording, run: initial } = createFinishedRecording(db, storage, validConfig);
  let asrCalls = 0;
  let namingCalls = 0;
  let summaryCalls = 0;

  const overrides: Partial<MeetingProcessingWorkerDeps> = {
    now: () => new Date(Date.now() + 300_000),
    transcribeRemote: async (_request, saveRaw) => {
      asrCalls += 1;
      await saveRaw(elevenResponse);

      return { success: true };
    },
    nameSpeakers: async (_input, _config, run) => {
      namingCalls += 1;
      assert.equal(run.kind, "reprocess");
      assert.equal(db.getMeetingProcessingRun(run.id).hasTranscript, true);

      return { speakers: [] }; // No supported name: later Summary must still not repeat this request.
    },
    summarize: async () => {
      summaryCalls += 1;

      return "## Summary\nResult.";
    },
  };

  const worker = workerFor(db, storage, overrides);
  t.after(() => worker.stop());
  worker.cancelRun(initial.id);

  const transcribe = worker.createRun({
    recordingId: recording.id,
    kind: "reprocess",
    config: { ...validConfig, generateSummary: false },
  });

  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(transcribe.run.id).status, "complete");
  assert.equal(db.getMeetingProcessingRun(transcribe.run.id).hasSummary, false);
  assert.equal(asrCalls, 1);
  assert.equal(namingCalls, 1);
  assert.equal(summaryCalls, 0);
  worker.stop();

  const restarted = workerFor(db, storage, overrides);
  t.after(() => restarted.stop());

  const summary = restarted.createRun({
    recordingId: recording.id,
    kind: "summary",
    sourceRunId: transcribe.run.id,
    config: validConfig,
  });

  restarted.onRetentionReady();
  await restarted.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(summary.run.id).hasSummary, true);
  assert.equal(asrCalls, 1);
  assert.equal(namingCalls, 1);
  assert.equal(summaryCalls, 1);
});

test("capture interrupting speaker naming resumes normalization without repeating ASR", async (t) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { recording, run: initial } = createFinishedRecording(db, storage, validConfig);
  let asrCalls = 0;
  let namingCalls = 0;

  const worker = workerFor(db, storage, {
    now: () => new Date(Date.now() + 300_000),
    transcribeRemote: async (_request, saveRaw) => {
      asrCalls += 1;
      await saveRaw(elevenResponse);

      return { success: true };
    },
    nameSpeakers: async (input) => {
      namingCalls += 1;

      if (namingCalls === 1) worker.captureStarted();

      return {
        speakers: [
          {
            speakerId: meetingSpeakerNamingInputSchema.parse(input).segments[0].speakerId!,
            name: "Alice",
          },
        ],
      };
    },
    summarize: async () => {
      assert.fail("Transcribe must not generate Summary");
    },
  });

  t.after(() => worker.stop());
  worker.cancelRun(initial.id);

  const result = worker.createRun({
    recordingId: recording.id,
    kind: "reprocess",
    config: { ...validConfig, generateSummary: false },
  });

  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(result.run.id).stage, "normalize");
  assert.equal(db.getMeetingProcessingRun(result.run.id).status, "pending");
  assert.equal(db.getMeetingProcessingRun(result.run.id).hasTranscript, true);
  assert.deepEqual(db.getMeetingRunSpeakerCorrections(result.run.id), []);
  worker.captureStopped();
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(result.run.id).status, "complete");
  assert.equal(db.getMeetingRunSpeakerCorrections(result.run.id)[0].displayName, "Alice");
  assert.equal(namingCalls, 2);
  assert.equal(asrCalls, 1);
});

test("cancel IPC persists the stopped gate and preserves source audio", async (t) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { recording, run } = createFinishedRecording(db, storage, validConfig, "", true);
  const deadline = Date.parse(run.retryAt!);
  let now = deadline - 1;
  let calls = 0;

  const worker = workerFor(db, storage, {
    now: () => new Date(now),
    transcribeRemote: async () => {
      calls += 1;

      return { success: true, text: "Hello." };
    },
  });

  t.after(() => worker.stop());
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  registerMeetingProcessingHandlers(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    worker
  );

  const bridge = createMeetingProcessingBridge({
    invoke: async (channel, ...args) => handlers.get(channel)!(null, ...args),
    send() {},
    on: () => {},
    removeListener: () => {},
  });

  const audioPath = storage.getEpochFilePath(recording.id, "mic", 0);
  const before = fs.readFileSync(audioPath);
  assert.equal((await bridge.meetingProcessingCancelRun(run.id)).success, true);
  assert.equal((await bridge.meetingProcessingCancelRun(run.id)).success, false);
  assert.deepEqual(
    await handlers.get(meetingProcessingChannels.cancelRun)!(null, { runId: "invalid" }),
    {
      success: false,
      error: "Invalid meeting processing cancellation request",
    }
  );
  now = deadline + 1;
  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(calls, 0);
  assert.equal(db.getMeetingProcessingRun(run.id)?.status, "cancelled");
  assert.equal(db.getMeetingProcessingRun(run.id)?.retryAt, null);
  assert.equal(db.getMeetingRecording(recording.id)?.audioState, "available");
  assert.deepEqual(fs.readFileSync(audioPath), before);
});

test("meeting title generation works with known speakers and preserves concurrent rename", async (t) => {
  for (const renamed of [false, true]) {
    const db = createDb(t);

    if (!db) return;
    const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
    const config = { ...validConfig, generateTitle: true, generateSummary: true };
    const { note, run } = createFinishedRecording(db, storage, config);
    db.updateNote(note.id, { title: "Заметка без названия" });
    saveTranscriptArtifact(db, storage, run.id, "Обсуждаем запуск курса.", "speaker_0");
    db.setMeetingRunSpeakerCorrection(run.id, "speaker_0", null, "Owner", "user");
    db.setMeetingProcessingRunState(run.id, {
      stage: "normalize",
      status: "pending",
      retryAt: null,
    });
    let calls = 0;

    const worker = workerFor(db, storage, {
      nameSpeakers: async (input) => {
        calls += 1;
        assert.equal(meetingSpeakerNamingInputSchema.parse(input).generateTitle, true);

        if (renamed) db.updateNote(note.id, { title: "Моё название" });

        return { speakers: [], title: "План запуска курса" };
      },
      summarize: async () => "## Summary\nЗапускаем курс.",
    });

    t.after(() => worker.stop());
    worker.onRetentionReady();
    await worker.waitForIdle();
    worker.stop();
    assert.equal(calls, 1);
    assert.equal(db.getNote(note.id).title, renamed ? "Моё название" : "План запуска курса");

    if (!renamed) {
      assert.equal(
        JSON.parse(db.getMeetingRunLlmSourceSnapshot(run.id)).meetingTitle,
        "План запуска курса"
      );
      assert.equal(db.getMeetingProcessingRun(run.id).hasSummary, true);
    }
  }
});

for (const failure of ["observation-lookup", "part-map"] as const) {
  test(`platform ${failure} failure preserves a saved transcript and continues naming`, async (t: import("node:test").TestContext) => {
    const db = createDb(t);

    if (!db) return;
    const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });

    const { run } = createFinishedRecording(db, storage, {
      ...validConfig,
      generateSummary: false,
    });

    saveTranscriptArtifact(
      db,
      storage,
      run.id,
      "Synthetic speaker introduces herself.",
      "system:fixture"
    );
    db.setMeetingProcessingRunState(run.id, {
      stage: "normalize",
      status: "pending",
      retryAt: null,
    });
    const originalObservations = db.listMeetingPlatformObservations;
    const originalEpochs = db.listMeetingRecordingEpochs;
    t.after(() => {
      db.listMeetingPlatformObservations = originalObservations;
      db.listMeetingRecordingEpochs = originalEpochs;
    });

    const failLookup = () => {
      throw new Error("Synthetic metadata unavailable");
    };

    if (failure === "observation-lookup") db.listMeetingPlatformObservations = failLookup;
    else db.listMeetingRecordingEpochs = failLookup;
    let namingCalls = 0;

    const worker = workerFor(db, storage, {
      nameSpeakers: async () => {
        namingCalls += 1;

        return { speakers: [] };
      },
    });

    t.after(() => worker.stop());
    worker.onRetentionReady();
    await worker.waitForIdle();
    assert.equal(namingCalls, 1);
    assert.equal(db.getMeetingProcessingRun(run.id)?.status, "complete");
    assert.equal(db.getMeetingProcessingRun(run.id)?.hasTranscript, true);
    assert.match(storage.readRunArtifact(run.id, "transcript").text, /Synthetic speaker/);
  });
}

test("native-shaped Zoom intervals resume through production naming into the Note/CLI transcript and new runs", async (t) => {
  const db = createDb(t);

  if (!db) return;

  const {
    zoomSpeakerFixture,
  }: typeof import("../lib/zoomSpeakerFixture.ts") = require("../lib/zoomSpeakerFixture.ts");

  const {
    readNoteTranscript,
  }: typeof import("../../src/helpers/noteTranscriptReader.ts") = require("../../src/helpers/noteTranscriptReader.ts");

  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const note = db.saveNote("Zoom fixture", "", "meeting").note!;

  const recording = db.createMeetingRecording(note.id, {
    config: { ...validConfig, generateSummary: false },
  });

  for (const source of ["mic", "system"] as const) {
    db.createMeetingRecordingEpoch(recording.id, source, 0, 1, 0, 0);
    savePcmEpoch(storage, recording.id, source, 0, Buffer.alloc(14 * 24_000 * 2));
    db.updateMeetingRecordingEpochRecovery(
      recording.id,
      source,
      0,
      storage.recoverEpoch(recording.id, source, 0)
    );
  }

  db.markMeetingRecordingFinalizing(recording.id);

  const { initialRun } = db.finalizeMeetingRecording(recording.id, {
    captureState: "ready",
    endedAt: new Date(Date.parse(recording.startedAt) + 14_000).toISOString(),
  });

  const fixture = zoomSpeakerFixture(recording.id);
  fixture.observations.forEach((o) => db.saveMeetingPlatformObservation(o));
  fixture.anchors.forEach((a) => db.saveMeetingAudioClockAnchor(a));
  // An earlier AX gap does not disable the usable episodes that follow.
  db.setMeetingPlatformCoverage(recording.id, {
    reads: 28,
    samples: fixture.observations.length,
    state: "incomplete",
    reason: "accessibility",
  });

  const transcripts = new Map<
    string,
    import("../../src/contracts/meetingRecording.ts").MeetingTranscriptArtifact
  >();

  let namingCalls = 0;

  const worker = workerFor(db, storage, {
    nameSpeakers: async (input) => {
      namingCalls += 1;
      const run = db.getMeetingRecording(recording.id).currentRunId;
      assert.equal(db.getMeetingRunSpeakerCorrections(run)[0].source, "platform");
      const parsed = meetingSpeakerNamingInputSchema.parse(input);
      assert.deepEqual(parsed.callParticipants, ["Synthetic Guest"]);
      assert.equal(parsed.manualNotes, "");

      return { speakers: [] };
    },
  });

  t.after(() => worker.stop());

  for (const [index, run] of [initialRun, null].entries()) {
    const current =
      run ??
      db.createMeetingProcessingRun(recording.id, {
        kind: "reprocess",
        config: { ...validConfig, generateSummary: false },
      });

    const transcript = {
      ...fixture.transcript,
      segments: [
        ...fixture.transcript.segments.map((s) => ({ ...s, speaker: `system:run-${index}` })),
        { speaker: "mic", text: "Local later", start: 13, end: 14 },
      ],
    };

    transcripts.set(current.id, transcript);
    storage.writeRunArtifact(current.id, "provider-response", { text: transcript.text });
    db.setMeetingRunArtifact(current.id, "provider-response");
    storage.writeRunArtifact(current.id, "transcript", transcript);
    db.setMeetingRunArtifact(current.id, "transcript");
    db.setMeetingProcessingRunState(current.id, {
      stage: "normalize",
      status: "pending",
      retryAt: null,
    });
    worker.onRetentionReady();
    await worker.waitForIdle();
    assert.equal(db.getMeetingProcessingRun(current.id).status, "complete");
    const corrections = db.getMeetingRunSpeakerCorrections(current.id);
    assert.equal(corrections.length, 1);
    assert.equal(corrections[0].speakerId, `system:run-${index}`);
    assert.equal(corrections[0].displayName, "Synthetic Guest");
    const projection = JSON.parse(db.getNote(note.id).transcript ?? "[]");
    assert.equal(projection[0].speakerName, "Synthetic Guest");
    assert.equal(projection[0].speakerLockSource, "platform");
    assert.ok(
      db
        .getMeetingRunPlatformDecisions(current.id)
        .every(
          (d: import("../../src/contracts/meetingRecording.ts").MeetingPlatformDecision) =>
            d.status === "accepted"
        )
    );

    const view = readNoteTranscript(
      {
        listRecordings: (id) => db.listMeetingRecordingsForNote(id),
        listEpochs: (id) => db.listMeetingRecordingEpochs(id),
        getRun: (id) => db.getMeetingProcessingRun(id),
        readTranscript: (id) => transcripts.get(id) ?? null,
        getCorrections: (id) => db.getMeetingRunSpeakerCorrections(id),
        profileEmail: () => null,
        getProjection: () => null,
      },
      note.id
    );

    assert.equal(view.speakers.find((s) => s.source === "system")?.name, "Synthetic Guest");
    assert.equal(view.speakers.find((s) => s.source === "system")?.name_source, "platform");
    assert.equal(view.speakers.find((s) => s.source === "microphone")?.name, null);
  }

  assert.equal(namingCalls, 2);
  assert.ok(storage.readRunArtifact(initialRun.id, "transcript"));
  assert.equal(db.listMeetingAudioClockAnchors(recording.id).length, 14);
});

test("unresolved alignment fails prepare before providers and preserves raw audio on retry", async (t) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { recording, run } = createFinishedRecording(db, storage, validConfig);
  db.db
    .prepare(
      "UPDATE meeting_recording_epochs SET timeline_start_frame = NULL WHERE recording_id = ? AND source = 'mic'"
    )
    .run(recording.id);
  const rawPath = storage.getEpochFilePath(recording.id, "mic", 0);
  const original = fs.readFileSync(rawPath);
  let requests = 0;

  const worker = workerFor(db, storage, {
    transcribeRemote: async () => {
      requests++;
      throw new Error("must not reach provider");
    },
  });

  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(run.id)?.stage, "prepare");
  assert.equal(db.getMeetingProcessingRun(run.id)?.errorCode, "audio-alignment-unavailable");
  assert.equal(db.getMeetingRecording(recording.id)?.captureState, "ready");
  worker.retry(run.id);
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(run.id)?.errorCode, "audio-alignment-unavailable");
  assert.equal(requests, 0);
  assert.deepEqual(fs.readFileSync(rawPath), original);
});

for (const scenario of [
  { name: "saved pending tasks", status: "pending", calls: 1 },
  {
    name: "restart before the Summary run completes",
    status: "pending",
    runInterrupted: true,
    calls: 1,
  },
  { name: "capture postpones pending tasks", status: "pending", capturing: true, calls: 1 },
  { name: "unselected pending tasks", status: "pending", unselected: true, calls: 0 },
  { name: "interrupted running tasks", status: "running", calls: 0, retry: true },
  { name: "old Summary without task status", status: undefined, calls: 0, retry: true },
  { name: "completed tasks", status: "complete", calls: 0 },
  { name: "completed empty tasks", status: "zero", calls: 0 },
  { name: "failed tasks", status: "provider-error", calls: 0 },
] as const) {
  test(`main task recovery: ${scenario.name}`, async (t) => {
    const db = createDb(t);

    if (!db) return;
    const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });

    const { recording, run } = createFinishedRecording(
      db,
      storage,
      validConfig,
      "Manual notes",
      false,
      180
    );

    const initial = workerFor(db, storage, {
      transcribeRemote: async (_request, saveRaw) => {
        await saveRaw(longTranscriptResponse());

        return { success: true };
      },
      summarize: async () => "## Summary\nSaved result.\n\n## Action Items\n- Ship release",
    });

    t.after(() => initial.stop());
    initial.onRetentionReady();
    await initial.waitForIdle();
    initial.stop();
    const artifact = storage.readRunArtifact(run.id, "summary");
    storage.writeRunArtifact(run.id, "summary", { ...artifact, taskStatus: scenario.status });

    if ("runInterrupted" in scenario)
      db.setMeetingProcessingRunState(run.id, {
        stage: "summary",
        status: "running",
        errorCode: null,
        retryAt: null,
      });

    if ("unselected" in scenario)
      db.createMeetingProcessingRun(recording.id, {
        kind: "summary",
        sourceRunId: run.id,
        config: validConfig,
      });
    db.db.close();
    const reopened = new DatabaseManagerClass();
    t.after(() => reopened.db.close());
    let calls = 0;

    const restarted = workerFor(reopened, storage, {
      transcribeRemote: async () => {
        throw new Error("Recovery must reuse the saved transcript");
      },
      summarize: async () => {
        throw new Error("Recovery must reuse the saved Summary");
      },
      createActionConversation: async () => ({
        send: async () => {
          calls++;

          return { text: "### HIGH\n- Ship release", refusal: false };
        },
      }),
    });

    t.after(() => restarted.stop());
    assert.equal(calls, 0, "constructor never starts provider work");

    if ("capturing" in scenario) restarted.captureStarted();
    restarted.onRetentionReady();
    await restarted.waitForIdle();

    if ("capturing" in scenario) {
      assert.equal(calls, 0, "capture keeps pending tasks deferred");
      restarted.captureStopped();
      await restarted.waitForIdle();
    }

    assert.equal(calls, scenario.calls);
    const result = storage.readRunArtifact(run.id, "summary");

    if (scenario.calls) assert.equal(result.taskStatus, "complete");

    if (scenario.status === "running") {
      assert.equal(result.taskStatus, "provider-error");
      assert.equal(result.taskErrorCode, "meeting-summary-task-interrupted");
    }

    restarted.processPending();
    await restarted.waitForIdle();
    assert.equal(calls, scenario.calls, "repeat scheduling never repeats provider work");

    if ("retry" in scenario) {
      assert.deepEqual(await restarted.runSummaryAction({ runId: run.id, action: "tasks" }), {
        success: true,
      });
      assert.equal(calls, 1, "manual tasks remain available for old and interrupted Summaries");
      assert.equal(storage.readRunArtifact(run.id, "summary").taskStatus, "complete");
    }

    assert.equal(reopened.getNote(recording.noteId)?.content, "Manual notes");
  });
}

for (const barrier of ["note", "shutdown"] as const) {
  for (const agent of [false, true]) {
    test(`${barrier} waits for owned Tasks and ${agent ? "queued BB" : "active"} Recap without late publication`, async (t) => {
      const db = createDb(t);

      if (!db) return;
      const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });

      const config: MeetingProcessingConfig = agent
        ? {
            ...validConfig,
            summary: {
              ...validConfig.summary,
              reasoningMode: "agent",
              agentProvider: "codex",
              model: "gpt-6-luna",
              agentReasoningLevel: "low",
            },
          }
        : validConfig;

      const { note, run } = createFinishedRecording(
        db,
        storage,
        config,
        "Manual notes",
        false,
        180
      );

      let release!: () => void;

      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      let tasksStarted!: () => void;

      const started = new Promise<void>((resolve) => {
        tasksStarted = resolve;
      });

      let recapStarted!: () => void;

      const recapReady = new Promise<void>((resolve) => {
        recapStarted = resolve;
      });

      const signals: AbortSignal[] = [];
      const calls: string[] = [];

      const worker = workerFor(db, storage, {
        transcribeRemote: async (_request, saveRaw) => {
          await saveRaw(longTranscriptResponse());

          return { success: true };
        },
        summarize: async () =>
          "## TLDR\nRelease discussion.\n\n## Action Items\n- Initial action item.",
        summarizeAgent: async () =>
          "## TLDR\nRelease discussion.\n\n## Action Items\n- Initial action item.",
        createActionConversation: async (_config, instruction, _run, signal) => {
          signals.push(signal);

          return {
            send: async () => {
              const tasks = instruction === MEETING_TASKS_INSTRUCTION;
              calls.push(tasks ? "tasks" : "recap");

              if (tasks) tasksStarted();
              else recapStarted();
              await gate; // Deliberately ignore abort: the barrier must await settlement.

              return {
                text: tasks
                  ? "### HIGH\n- Late task"
                  : JSON.stringify({ title: "Late recap", bullets: ["Late result"] }),
                refusal: false,
              };
            },
          };
        },
        getActionPrompt: () => "Recap prompt",
      });

      t.after(async () => {
        release();
        await worker.stop();
      });
      worker.onRetentionReady();
      await started;
      const recap = worker.runSummaryAction({ runId: run.id, action: "recap" });

      if (!agent) await recapReady;
      const before = storage.readRunArtifact(run.id, "summary");
      const pending = createFinishedRecording(db, storage).run;

      if (barrier === "note") assert.ok(db.beginMeetingNoteDeletion(note.id));
      let settled = false;

      const completion = (
        barrier === "note" ? worker.cancelNoteForDeletion(note.id) : worker.stop()
      ).then(() => {
        settled = true;
      });

      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false, "provider work still owns the Note until its promise settles");
      assert.ok(signals.every((signal) => signal.aborted));
      assert.ok(db.getNote(note.id));
      assert.equal(
        (await worker.runSummaryAction({ runId: run.id, action: "recap" })).success,
        false
      );
      release();
      await completion;
      assert.equal((await recap).success, false);
      assert.equal(db.getNote(note.id).enhanced_content, before.text);
      assert.equal(storage.readRunArtifact(run.id, "summary").text, before.text);
      assert.deepEqual(calls, agent ? ["tasks"] : ["tasks", "recap"]);
      assert.equal(
        db.getMeetingProcessingRun(pending.id).status,
        "pending",
        "shutdown/deletion does not cancel unrelated pending work"
      );
    });
  }
}

test("audio-only deletion leaves text actions running and does not wait for them", async (t) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });

  const { note, recording, run } = createFinishedRecording(
    db,
    storage,
    validConfig,
    "Manual notes",
    false,
    180
  );

  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  let start!: () => void;

  const started = new Promise<void>((resolve) => {
    start = resolve;
  });

  let actionSignal: AbortSignal | undefined;

  const worker = workerFor(db, storage, {
    transcribeRemote: async (_request, saveRaw) => {
      await saveRaw(longTranscriptResponse());

      return { success: true };
    },
    summarize: async () =>
      "## TLDR\nRelease discussion.\n\n## Action Items\n- Initial action item.",
    createActionConversation: async (_config, _instruction, _run, signal) => ({
      send: async () => {
        actionSignal = signal;
        start();
        await gate;

        return { text: "### HIGH\n- Ship the release", refusal: false };
      },
    }),
  });

  t.after(async () => {
    release();
    await worker.stop();
  });
  worker.onRetentionReady();
  await started;
  assert.ok(db.beginMeetingAudioDeletion(recording.id));
  await worker.cancelRecordingForDeletion(recording.id);
  assert.equal(actionSignal?.aborted, false);
  release();
  await worker.waitForIdle();
  assert.match(db.getNote(note.id).enhanced_content, /Ship the release/);
  assert.equal(storage.readRunArtifact(run.id, "summary").taskStatus, "complete");
});

test("shutdown waits for ASR settlement, preserves retry state and stops new claims", async (t) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage);
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  let start!: () => void;

  const started = new Promise<void>((resolve) => {
    start = resolve;
  });

  let asrSignal: AbortSignal | undefined;
  let calls = 0;

  const worker = workerFor(db, storage, {
    transcribeRemote: async (_request, saveRaw, signal) => {
      calls++;
      asrSignal = signal;
      start();
      await gate;
      await saveRaw(elevenResponse);

      return { success: true };
    },
  });

  t.after(async () => {
    release();
    await worker.stop();
  });
  worker.onRetentionReady();
  await started;
  const pending = createFinishedRecording(db, storage).run;
  let settled = false;

  const completion = worker.stop().then(() => {
    settled = true;
  });

  assert.equal(asrSignal?.aborted, true);
  worker.processPending();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await completion;
  assert.equal(calls, 1);
  assert.equal(db.getMeetingProcessingRun(run.id).status, "pending");
  assert.equal(db.getMeetingProcessingRun(pending.id).status, "pending");
  assert.equal(storage.readRunArtifact(run.id, "provider-response"), null);
});

for (const barrier of ["note", "shutdown"] as const) {
  test(`${barrier} waits for conversation creation and never sends a queued request afterward`, async (t) => {
    const db = createDb(t);

    if (!db) return;
    const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });

    const { note, run } = createFinishedRecording(
      db,
      storage,
      validConfig,
      "Manual notes",
      false,
      180
    );

    let release!: () => void;

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let start!: () => void;

    const started = new Promise<void>((resolve) => {
      start = resolve;
    });

    let sent = 0;

    const worker = workerFor(db, storage, {
      transcribeRemote: async (_request, saveRaw) => {
        await saveRaw(longTranscriptResponse());

        return { success: true };
      },
      summarize: async () =>
        "## TLDR\nRelease discussion.\n\n## Action Items\n- Initial action item.",
      createActionConversation: async () => {
        start();
        await gate;

        return {
          send: async () => {
            sent++;

            return { text: "### HIGH\n- Late task", refusal: false };
          },
        };
      },
    });

    t.after(async () => {
      release();
      await worker.stop();
    });
    worker.onRetentionReady();
    await started;
    const IPCHandlers = require("../../src/helpers/ipcHandlers.ts");

    const {
      createMeetingAudioOperationRegistry,
    } = require("../../src/helpers/meetingAudioExport.ts");

    const intent = barrier === "note" ? db.beginMeetingNoteDeletion(note.id) : null;
    let settled = false;

    const completion = (
      intent
        ? IPCHandlers.prototype._finishMeetingDeletion.call(
            {
              databaseManager: db,
              audioStorageManager: { meetingRecordings: storage },
              _meetingAudioOperations: createMeetingAudioOperationRegistry(),
              _meetingProcessing: worker,
              _asyncMirrorDelete: () => {},
            },
            intent
          )
        : worker.stop()
    ).then((result: unknown) => {
      settled = true;

      return result;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.ok(db.getNote(note.id));
    assert.ok(storage.readRunArtifact(run.id, "summary"));
    release();
    const result = await completion;
    assert.equal(sent, 0);

    if (intent) {
      assert.equal(result, true);
      assert.equal(db.getNote(note.id), null);
      assert.equal(db.getMeetingProcessingRun(run.id), null);
      assert.equal(storage.readRunArtifact(run.id, "summary"), null);
    } else {
      assert.ok(db.getNote(note.id));
      assert.equal(
        storage.readRunArtifact(run.id, "summary").taskErrorCode,
        "meeting-summary-task-interrupted"
      );
    }
  });
}

test("audio deletion does not wait for another Note's active ASR", async (t) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage);
  const other = createFinishedRecording(db, storage);
  assert.equal(db.beginMeetingAudioDeletion(other.recording.id)?.kind, "audio");
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  let start!: () => void;

  const started = new Promise<void>((resolve) => {
    start = resolve;
  });

  let signal: AbortSignal | undefined;

  const worker = workerFor(db, storage, {
    transcribeRemote: async (_request, saveRaw, value) => {
      signal = value;
      start();
      await gate;
      await saveRaw(elevenResponse);

      return { success: true };
    },
  });

  t.after(async () => {
    release();
    await worker.stop();
  });
  worker.onRetentionReady();
  await started;
  await worker.cancelRecordingForDeletion(other.recording.id);
  assert.equal(signal?.aborted, false);
  assert.equal(db.getMeetingProcessingRun(run.id).status, "running");
  release();
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(run.id).status, "complete");
});

test("audio deletion waits for local speaker recognition after cloud ASR", async (t) => {
  const db = createDb(t);

  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { recording, run } = createFinishedRecording(db, storage);
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  let start!: () => void;

  const started = new Promise<void>((resolve) => {
    start = resolve;
  });

  let signal: AbortSignal | undefined;

  const worker = workerFor(db, storage, {
    recognizeSpeakers: async (_recording, _run, _transcript, _path, value) => {
      signal = value;
      start();
      await gate;

      return [{ speakerId: "system:speaker_0", profileId: null, displayName: "Late name" }];
    },
  });

  t.after(async () => {
    release();
    await worker.stop();
  });
  worker.onRetentionReady();
  await started;
  assert.ok(db.beginMeetingAudioDeletion(recording.id));
  let settled = false;

  const deletion = worker.cancelRecordingForDeletion(recording.id).then(() => {
    settled = true;
  });

  assert.equal(signal?.aborted, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await deletion;
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(run.id).status, "cancelled");
  assert.equal(
    db
      .getMeetingRunSpeakerCorrections(run.id)
      .some((item: { displayName: string }) => item.displayName === "Late name"),
    false
  );
});

for (const mode of ["providers", "local"] as const) {
  test(`audio deletion preserves text-only naming after ${mode} normalization`, async (t) => {
    const db = createDb(t);

    if (!db) return;
    const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });

    const config: MeetingProcessingConfig =
      mode === "providers"
        ? validConfig
        : {
            ...validConfig,
            transcription: {
              mode: "local",
              language: "en",
              local: { provider: "whisper", model: "base", options: { diarize: true } },
            },
          };

    const { note, recording, run } = createFinishedRecording(
      db,
      storage,
      config,
      "Manual notes",
      false,
      180
    );

    let release!: () => void;

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let start!: () => void;

    const started = new Promise<void>((resolve) => {
      start = resolve;
    });

    let namingSignal: AbortSignal | undefined;
    let recognitions = 0;

    const worker = workerFor(db, storage, {
      transcribeRemote: async (_request, saveRaw) => {
        await saveRaw(longTranscriptResponse());

        return { success: true };
      },
      transcribeLocal: async () => ({ success: true, text: "x".repeat(2500) }),
      diarizeLocal: async () => [{ speaker: "speaker_0", start: 0, end: 1 }],
      recognizeSpeakers: async () => {
        recognitions++;

        return [];
      },
      nameSpeakers: async (_input, _config, _run, signal) => {
        namingSignal = signal;
        start();
        await gate;

        return { speakers: [] };
      },
      summarize: async () => "## TLDR\nSummary survives audio deletion.",
    });

    t.after(async () => {
      release();
      await worker.stop();
    });
    worker.onRetentionReady();
    await started;
    assert.equal(recognitions, 1);
    const intent = db.beginMeetingAudioDeletion(recording.id);
    assert.ok(intent);
    await worker.cancelRecordingForDeletion(recording.id);
    assert.equal(namingSignal?.aborted, false);
    storage.removeRecordingAudio(recording.id);
    assert.equal(db.completeMeetingAudioDeletion(intent.id).success, true);
    release();
    await worker.waitForIdle();
    assert.equal(db.getMeetingProcessingRun(run.id).status, "complete");
    assert.match(db.getNote(note.id).enhanced_content, /Summary survives/);
  });
}

for (const summaryOnly of [false, true]) {
  test(`${summaryOnly ? "Summary-only" : "Transcript"} speaker correction updates the selected transcript without replacing manual Summary`, async (t) => {
    const {
      NoteReadService,
    }: typeof import("../../src/helpers/noteReadService.ts") = require("../../src/helpers/noteReadService.ts");

    const {
      formatJson,
    }: typeof import("../../src/helpers/transcriptFormatter.ts") = require("../../src/helpers/transcriptFormatter.ts");

    const db = createDb(t);
    assert.ok(db);
    const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
    const { note, recording, run: source } = createFinishedRecording(db, storage);
    saveTranscriptArtifact(db, storage, source.id, "Release on Friday.", "system:A");
    db.setMeetingProcessingRunState(source.id, { stage: "summary", status: "complete" });

    const selected = summaryOnly
      ? db.createMeetingProcessingRun(recording.id, {
          kind: "summary",
          sourceRunId: source.id,
          config: validConfig,
        })
      : source;

    const artifact = { text: "## TLDR\nArtifact Summary.", speakerCorrectionRevision: 0 };
    storage.writeRunArtifact(selected.id, "summary", artifact);
    assert.equal(db.setMeetingRunArtifact(selected.id, "summary").success, true);
    db.setMeetingProcessingRunState(selected.id, { stage: "summary", status: "complete" });
    db.selectMeetingProcessingRun(recording.id, selected.id, {
      transcript: JSON.stringify([
        {
          speaker: "system:A",
          text: "Release on Friday.",
          timestamp: 0,
          endTimestamp: 0.5,
          speakerName: "Old name",
          speakerPlatform: "google-meet",
        },
      ]),
      summary: artifact.text,
      summaryPrompt: "Saved prompt",
    });
    assert.equal(
      db.updateNote(note.id, { enhanced_content: "## TLDR\nManual edits stay here." }).success,
      true
    );
    const before = db.getNote(note.id)!;
    const notifications: number[] = [];

    const worker = workerFor(db, storage, {
      onNoteProjectionChanged: (id) => notifications.push(id),
    });

    t.after(() => worker.stop());
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    registerMeetingProcessingHandlers(
      { handle: (channel, handler) => handlers.set(channel, handler) },
      worker
    );

    const bridge = createMeetingProcessingBridge({
      invoke: async (channel, ...args) => handlers.get(channel)!(null, ...args),
      send() {},
      on: () => {},
      removeListener: () => {},
    });

    // The renderer sends the source run ID even when a Summary-only result is selected.
    assert.deepEqual(
      await bridge.meetingProcessingSetSpeakerCorrection({
        runId: source.id,
        speakerId: "system:A",
        displayName: "Corrected name",
        profileId: null,
      }),
      { success: true }
    );
    const after = db.getNote(note.id)!;
    assert.equal(after.enhanced_content, "## TLDR\nManual edits stay here.");
    assert.equal(after.enhanced_content, before.enhanced_content);
    assert.equal(after.enhancement_prompt, before.enhancement_prompt);
    assert.equal(after.enhanced_at_content_hash, before.enhanced_at_content_hash);
    assert.deepEqual(storage.readRunArtifact(selected.id, "summary"), artifact);
    assert.deepEqual(notifications, [note.id]);
    const segments = JSON.parse(after.transcript!);
    assert.equal(segments[0].speakerName, "Corrected name");
    assert.equal(segments[0].speakerPlatform, undefined);
    assert.equal(segments[0].speakerLockSource, "user");
    assert.equal(JSON.parse(formatJson(after, segments, {})).segments[0].speaker, "Corrected name");

    const output = new NoteReadService(db, storage).readOutput({
      noteId: note.id,
      scope: "run",
      runId: selected.id,
    });

    assert.equal(output.scope, "run");

    if (output.scope !== "run") throw new Error("Expected run output");
    assert.equal(output.result!.speakerCorrections[0].displayName, "Corrected name");
    assert.equal(output.result!.speakerCorrectionRevision, 1);
    assert.equal(output.result!.summary!.speakerCorrectionRevision, 0);
    assert.equal(output.summaryFreshness.status, "stale");
    assert.ok(output.summaryFreshness.reasons.includes("speaker-corrections-changed"));

    const other = db.createMeetingProcessingRun(recording.id, {
      kind: "reprocess",
      config: validConfig,
    });

    saveTranscriptArtifact(db, storage, other.id, "Another version.", "system:A");
    db.selectMeetingProcessingRun(recording.id, selected.id, null);
    const selectedNote = db.getNote(note.id)!;
    assert.equal(
      (
        await bridge.meetingProcessingSetSpeakerCorrection({
          runId: other.id,
          speakerId: "system:A",
          displayName: "Other name",
          profileId: null,
        })
      ).success,
      true
    );
    assert.deepEqual(
      db.getNote(note.id),
      selectedNote,
      "a correction of another transcript must not touch the Note"
    );
    assert.deepEqual(notifications, [note.id]);
    const reopened = new DatabaseManagerClass();
    t.after(() => reopened.db.close());
    assert.deepEqual(reopened.getNote(note.id), selectedNote);
    assert.equal(reopened.getMeetingRecording(recording.id)?.currentRunId, selected.id);
    assert.equal(
      JSON.parse(
        formatJson(
          reopened.getNote(note.id)!,
          JSON.parse(reopened.getNote(note.id)!.transcript!),
          {}
        )
      ).segments[0].speaker,
      "Corrected name"
    );
  });
}

test("list-for-note retains explicit versus legacy source selection", (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { recording, run } = createFinishedRecording(db, storage, validConfig);
  db.db.prepare("UPDATE meeting_recording_epochs SET timeline_start_frame = NULL WHERE recording_id = ? AND source = 'mic'").run(recording.id);
  const worker = workerFor(db, storage);
  t.after(() => worker.stop());
  let result = worker.listForNote(recording.noteId)[0];
  assert.equal(result.recording.id, recording.id);
  assert.equal(result.runs[0].run.hasExplicitAudioParts, true);
  db.db.prepare("UPDATE meeting_recording_epochs SET timeline_start_frame = 0 WHERE recording_id = ? AND source = 'mic'").run(recording.id);
  db.db.prepare("UPDATE meeting_processing_runs SET source_recording_ids_json = NULL WHERE id = ?").run(run.id);
  result = worker.listForNote(recording.noteId)[0];
  assert.equal(result.runs[0].run.hasExplicitAudioParts, false);
  assert.deepEqual(result.runs[0].run.sourceRecordingIds, [recording.id]);
});

test("listing an active recording does not read its growing alignment history", (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { recording } = createFinishedRecording(db, storage, validConfig);
  db.db.prepare("UPDATE meeting_recordings SET capture_state = 'recording', ended_at = NULL WHERE id = ?").run(recording.id);
  const original = db.listMeetingRecordingEpochs.bind(db);
  let reads = 0;
  db.listMeetingRecordingEpochs = (id: string) => { reads++; return original(id); };
  const worker = workerFor(db, storage);
  t.after(() => worker.stop());
  const result = worker.listForNote(recording.noteId)[0];
  assert.equal(result.recording.durationSeconds, null);
  assert.equal(reads, 0);
});

test("Stop automatically processes usable parts, preserves skipped audio and persists a partial result", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const note = db.saveNote("Automatic recovery", "", "meeting").note!;
  const config = { ...validConfig, generateSummary: true };
  const base = Date.now() - 120000;
  const parts = [0, 1, 2].map((index) => {
    const recording = db.createMeetingRecording(note.id, { config }, new Date(base + index * 2000).toISOString());
    for (const source of ["mic", "system"] as const) {
      db.createMeetingRecordingEpoch(recording.id, source, 0, 1, 0, index === 1 && source === "mic" ? null : 0);
      savePcmEpoch(storage, recording.id, source, 0, Buffer.alloc(4800, 1));
      db.updateMeetingRecordingEpochRecovery(recording.id, source, 0, storage.recoverEpoch(recording.id, source, 0));
    }
    return db.finalizeMeetingRecording(recording.id, {
      captureState: index === 1 ? "incomplete" : "ready",
      endedAt: new Date(base + index * 2000 + 1000).toISOString(),
      errorCode: index === 1 ? "audio-write-failed" : null,
      processingNotBefore: new Date(base + 10000).toISOString(),
    });
  });
  const bad = parts[1].recording;
  const rawPath = storage.getEpochFilePath(bad.id, "mic", 0);
  const original = fs.readFileSync(rawPath);
  const used: string[][] = [];
  let requests = 0;
  let summaries = 0;
  const worker = workerFor(db, storage, {
    mixAudio: async (recording, runId, epochs) => {
      used.push([...new Set(epochs.map((epoch) => epoch.recordingId))]);
      return { path: storage.getDerivedAudioPath(recording.id, runId), frameCount: 48000, durationSeconds: 2, sizeBytes: 4096 };
    },
    transcribeRemote: async (_request, saveRaw) => {
      requests++;
      await saveRaw(elevenResponse);
      return { success: true, text: "parsed by adapter" };
    },
    nameSpeakers: async () => ({ speakers: [] }),
    summarize: async () => { summaries++; return "## Summary\nAvailable discussion."; },
  }, false);
  t.after(() => worker.stop());
  worker.onRetentionReady();
  await worker.waitForIdle();
  const run = db.getMeetingProcessingRun(parts[2].initialRun.id)!;
  assert.equal(run.status, "complete");
  assert.equal(run.hasTranscript, true);
  assert.equal(run.hasSummary, true);
  assert.deepEqual(run.sourceRecordingIds, parts.map((part) => part.recording.id));
  assert.deepEqual(run.omittedRecordingIds, [bad.id]);
  assert.ok(used.length > 0);
  assert.ok(used.every((ids) => JSON.stringify(ids) === JSON.stringify([parts[0].recording.id, parts[2].recording.id])));
  assert.equal(requests, 2, "each usable source is sent once, with no request for the failed start");
  assert.equal(summaries, 1);
  assert.deepEqual(fs.readFileSync(rawPath), original);
  assert.equal(db.getMeetingRecording(bad.id)?.captureState, "incomplete");
  await worker.stop();
  db.close();
  const reopened = new DatabaseManagerClass();
  try {
    assert.deepEqual(reopened.getMeetingProcessingRun(run.id)!.omittedRecordingIds, [bad.id]);
    const summary = reopened.createMeetingProcessingRun(run.recordingId, {
      kind: "summary", sourceRunId: run.id, config, configError: null,
    });
    assert.deepEqual(summary.omittedRecordingIds, [bad.id], "summary-only processing keeps the partial-audio marker");
  } finally { reopened.close(); }
});

test("a malformed historical recording cannot block healthy queued work or trigger historical requests", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const broken = createFinishedRecording(db, storage, validConfig);
  db.db
    .prepare("UPDATE meeting_recordings SET ended_at = ?, source_metadata_json = '{}' WHERE id = ?")
    .run(new Date(Date.parse(broken.recording.startedAt) - 1000).toISOString(), broken.recording.id);
  const historical = createFinishedRecording(db, storage, validConfig);
  for (const run of [broken.run, historical.run]) {
    db.setMeetingProcessingRunState(run.id, {
      stage: "prepare",
      status: "failed",
      errorCode: "audio-alignment-unavailable",
      retryAt: null,
    });
  }
  const healthy = createFinishedRecording(db, storage, validConfig);
  let requests = 0;
  const worker = workerFor(db, storage, {
    transcribeRemote: async (_request, saveRaw) => {
      requests++;
      await saveRaw(elevenResponse);
      return { success: true, text: "parsed by adapter" };
    },
  }, false);
  t.after(() => worker.stop());
  assert.doesNotThrow(() => worker.onRetentionReady());
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(broken.run.id)!.status, "failed");
  assert.equal(db.getMeetingProcessingRun(historical.run.id)!.status, "failed");
  assert.equal(db.getMeetingProcessingRun(healthy.run.id)!.status, "complete");
  assert.equal(db.getMeetingProcessingRun(healthy.run.id)!.hasTranscript, true);
  assert.equal(requests, 2, "only the queued meeting may be sent to ASR");
  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(requests, 2, "retention synchronization must not replay historical errors");
});

test("a historical preparation failure needs one explicit retry and is not replayed after restart", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const { run } = createFinishedRecording(db, storage, validConfig);
  db.setMeetingProcessingRunState(run.id, { stage: "prepare", status: "failed", errorCode: "audio-alignment-unavailable", retryAt: null });
  let requests = 0;
  const overrides = {
    transcribeRemote: async (_request: unknown, saveRaw: (response: unknown) => Promise<void>) => {
      requests++;
      await saveRaw(elevenResponse);
      return { success: true, text: "parsed by adapter" };
    },
  };
  const worker = workerFor(db, storage, overrides, false);
  t.after(() => worker.stop());
  worker.onRetentionReady();
  worker.onRetentionReady();
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(run.id)!.status, "failed");
  assert.equal(requests, 0, "opening the app does not submit failed historical audio");
  assert.ok(worker.retry(run.id));
  await worker.waitForIdle();
  assert.equal(db.getMeetingProcessingRun(run.id)!.hasTranscript, true);
  assert.equal(requests, 2);
  await worker.stop();
  const restarted = workerFor(db, storage, overrides, false);
  t.after(() => restarted.stop());
  restarted.onRetentionReady();
  await restarted.waitForIdle();
  assert.equal(requests, 2, "opening the app after success must not submit the audio again");
});

for (const scenario of ["cancelled", "provider-error", "cached-response"] as const) {
  test(`automatic audio recovery does not resubmit ${scenario}`, async (t) => {
    const db = createDb(t);
    if (!db) return;
    const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
    const { run } = createFinishedRecording(db, storage, validConfig);
    if (scenario === "cached-response") {
      storage.writeRunArtifact(run.id, "provider-response", elevenResponse);
      db.setMeetingRunArtifact(run.id, "provider-response");
    }
    const status = scenario === "cancelled" ? "cancelled" : "failed";
    const errorCode = scenario === "provider-error" ? "unsupported-provider" : "audio-alignment-unavailable";
    db.setMeetingProcessingRunState(run.id, { stage: "prepare", status, errorCode, retryAt: null });
    let requests = 0;
    const worker = workerFor(db, storage, { transcribeRemote: async () => { requests++; throw new Error("must not resend"); } }, false);
    t.after(() => worker.stop());
    worker.onRetentionReady();
    await worker.waitForIdle();
    assert.equal(requests, 0);
    assert.equal(db.getMeetingProcessingRun(run.id)!.status, status);
  });
}

for (const barrier of ["quit", "audio", "note"] as const) {
  test(`${barrier} barrier awaits preparation child close before releasing recording ownership`, async t => {
    const db = createDb(t); if (!db) return;
    const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
    const config = { ...validConfig, transcription: { ...validConfig.transcription, provider: "deepgram", model: "nova-3", credentialRef: "DEEPGRAM_API_KEY" } };
    const { note, recording, run } = createFinishedRecording(db, storage, config, "Preserved manual note");
    const children: Array<{ child: import("node:events").EventEmitter; killed: boolean; close(): void }> = [];
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    let providerCalls = 0;
    const worker = workerFor(db, storage, {
      mixAudio: undefined,
      mixerDeps: { ffmpegPath: () => getFFmpegPath(), resamplerPath: () => require("node:path").resolve("resources/bin/meeting-resampler"), spawn: (_command, args) => {
        const child = new EventEmitter(); child.stderr = new EventEmitter();
        let closed = false;
        const entry = { child, killed: false, close() { if (!closed) { closed = true; child.emit("close", null); } } };
        child.kill = () => { entry.killed = true; return true; };
        fs.writeFileSync(args.at(-1)!, "private partial decoded data"); children.push(entry);
        if (children.length === 2) started(); return child;
      } },
      transcribeRemote: async () => { providerCalls++; throw new Error("preparation must not reach a provider"); },
    }, false);
    t.after(async () => { children.forEach(entry => entry.close()); await worker.stop(); });
    worker.onRetentionReady(); await ready;
    let settled = false;
    const closing = (barrier === "quit" ? worker.stop() : barrier === "audio" ? worker.cancelRecordingForDeletion(recording.id) : worker.cancelNoteForDeletion(note.id)).then(() => { settled = true; });
    await new Promise(setImmediate); assert.equal(settled, false); assert.ok(children.every(entry => entry.killed));
    assert.equal(db.getNote(note.id)!.content, "Preserved manual note"); assert.equal(providerCalls, 0);
    children[0].close(); await new Promise(setImmediate); assert.equal(settled, false);
    children[1].close(); await closing;
    assert.equal(providerCalls, 0); assert.equal(db.getMeetingProcessingRun(run.id)!.status, barrier === "quit" ? "pending" : "cancelled");
    assert.deepEqual(fs.readdirSync(require("node:path").join(storage.recordingsRoot, recording.id, "derived")), []);
    assert.ok(fs.existsSync(storage.getEpochFilePath(recording.id, "mic", 0)));
    assert.ok(fs.existsSync(storage.getEpochFilePath(recording.id, "system", 0)));
  });
}
