import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createDb } from "../../../../helpers/harness/db.ts";
import { getUserDataDir } from "../../../../helpers/harness/electronStub.ts";
import type {
  MeetingProcessingConfig,
  MeetingTranscriptArtifact,
} from "../../../../../src/contracts/meetingRecording.ts";

const flush = () => new Promise<void>((done) => setImmediate(done));

test("calendar and guarded processing projections update the enabled mirror and rebuild repairs failures", async (t) => {
  const db = createDb(t)!;
  const repo = path.resolve(__dirname, "../../../../..");

  const { IPCHandlers } = require(
    path.join(repo, "dist-main/src/helpers/ipcHandlers.js")
  ) as typeof import("../../../../../src/helpers/ipcHandlers.ts");

  const mirror = require(
    path.join(repo, "dist-main/src/helpers/markdownMirror.js")
  ) as import("../../../../../src/helpers/markdownMirror.ts").MarkdownMirror;

  const owner = Object.create(IPCHandlers.prototype) as InstanceType<typeof IPCHandlers>;
  owner.databaseManager = db;
  owner._noteFilesEnabled = true;
  const directory = path.join(getUserDataDir(), "mirror");
  mirror.init(directory);

  const { MeetingDetectionEngine } =
    require("../../../../../src/helpers/meetingDetectionEngine.ts") as typeof import("../../../../../src/helpers/meetingDetectionEngine.ts");

  const engine = new MeetingDetectionEngine(
    { getActiveMeetingState: () => ({ activeMeeting: null }) },
    new EventEmitter() as any,
    Object.assign(new EventEmitter(), { resetPrompt() {} }) as any,
    { queueMeetingNoteNavigation: async () => {}, dismissMeetingNotification() {} },
    db
  );

  const requested: Array<NonNullable<ReturnType<typeof db.getNote>>> = [];

  const requestMirror = (noteId: number) => {
    requested.push(db.getNote(noteId)!);
    owner._asyncMirrorWrite({ id: noteId });
  };

  engine.onNoteSaved = requestMirror;
  db.saveAppleCalendars([{ id: "calendar", title: "Calendar" }]);

  const event = {
    id: "event",
    calendar_id: "calendar",
    provider: "apple",
    summary: "Calendar",
    start_time: new Date(Date.now() + 86_400_000).toISOString(),
    end_time: new Date(Date.now() + 90_000_000).toISOString(),
    attendees: JSON.stringify([{ email: "guest@example.com", displayName: "Guest" }]),
    attendees_count: 1,
  };

  db.upsertCalendarEvents([event]);
  const created = engine.createCalendarEventNote(event.id, { content: "Calendar manual text" });
  assert.ok(created);
  await flush();
  const notePath = path.join(directory, "Personal", `${created.noteId}-calendar.md`);

  const transcriptPath = path.join(
    directory,
    "Personal",
    `${created.noteId}-calendar-transcript.md`
  );

  assert.match(fs.readFileSync(notePath, "utf8"), /Calendar manual text/);
  assert.equal(db.getNote(created.noteId)!.calendar_event_id, event.id);
  assert.match(db.getNote(created.noteId)!.participants!, /Guest/);
  assert.equal(requested[0].calendar_event_id, event.id, "request follows linked metadata commit");
  assert.match(requested[0].participants!, /Guest/);
  assert.equal(engine.createCalendarEventNote(event.id)!.noteId, created.noteId);
  assert.equal(requested.length, 1, "reusing an unchanged Note does not duplicate effects");
  await engine.startManualMeeting();
  await flush();
  const manualId = requested.at(-1)!.id;
  assert.ok(
    fs.readdirSync(path.join(directory, "Personal")).some((file) => file.startsWith(`${manualId}-`))
  );
  const joinedEvent = { ...event, id: "joined-event", summary: "Joined" };
  db.upsertCalendarEvents([joinedEvent]);
  engine.activeDetections.set("calendar:join", {
    source: "calendar",
    key: joinedEvent.id,
    event: joinedEvent,
  } as any);
  await engine.handleNotificationResponse("calendar:join", "start");
  await flush();
  assert.equal(requested.at(-1)!.calendar_event_id, joinedEvent.id);
  const joinedId = requested.at(-1)!.id;
  assert.ok(fs.existsSync(path.join(directory, "Personal", `${joinedId}-joined.md`)));
  engine.onNoteSaved = () => {
    throw new Error("projection request failed");
  };

  db.upsertCalendarEvents([{ ...event, id: "failed-effect", summary: "Saved effect failure" }]);

  const failedEffect = engine.createCalendarEventNote("failed-effect", {
    content: "Still committed",
  });

  assert.ok(failedEffect);
  assert.equal(db.getNote(failedEffect.noteId)!.content, "Still committed");
  engine.onNoteSaved = requestMirror;

  const config: MeetingProcessingConfig = {
    transcription: {
      mode: "providers",
      provider: "elevenlabs",
      model: "scribe_v2",
      language: "en",
      credentialRef: "ELEVENLABS_API_KEY",
    },
    summary: {
      actionId: "notes.actions.builtin.detailedNotes",
      instruction: "Summary",
      reasoningMode: "providers",
      provider: "openai",
      model: "gpt-4o-mini",
      credentialRef: "OPENAI_API_KEY",
    },
  };

  const { MeetingRecordingStorage } =
    require("../../../../../src/helpers/meetingRecordingStorage.ts") as typeof import("../../../../../src/helpers/meetingRecordingStorage.ts");

  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const recording = db.createMeetingRecording(created.noteId, { config });

  const finalized = db.finalizeMeetingRecording(recording.id, {
    captureState: "incomplete",
    endedAt: new Date(Date.parse(recording.startedAt) + 1000).toISOString(),
  });

  const source = finalized.initialRun;

  const transcript: MeetingTranscriptArtifact = {
    text: "Spoken result",
    diarized: true,
    segments: [{ speaker: "system:A", text: "Spoken result", start: 0, end: 0.5 }],
  };

  storage.writeRunArtifact(source.id, "provider-response", { text: transcript.text });
  db.setMeetingRunArtifact(source.id, "provider-response");
  storage.writeRunArtifact(source.id, "transcript", transcript);
  db.setMeetingRunArtifact(source.id, "transcript");
  db.setMeetingProcessingRunState(source.id, {
    stage: "summary",
    status: "complete",
    errorCode: null,
    retryAt: null,
  });

  const { MeetingProcessingWorker } =
    require("../../../../../src/helpers/meetingProcessing.ts") as typeof import("../../../../../src/helpers/meetingProcessing.ts");

  const worker = new MeetingProcessingWorker({
    database: db,
    storage,
    isCaptureActive: () => false,
    transcribeRemote: async () => {
      throw new Error("unexpected ASR");
    },
    transcribeLocal: async () => {
      throw new Error("unexpected ASR");
    },
    diarizeLocal: async () => [],
    summarize: async () => "## Summary\nGenerated Summary",
    getCredential: () => "synthetic-key",
    onNoteProjectionChanged: (id) => owner._publishMeetingNoteProjection(id),
  });

  t.after(() => worker.stop());

  const summary = worker.createRun({
    recordingId: recording.id,
    sourceRunId: source.id,
    kind: "summary",
    config,
  });

  worker.onRetentionReady();
  await worker.waitForIdle();
  await flush();
  assert.equal(db.getMeetingProcessingRun(summary.run.id)!.status, "complete");
  assert.match(fs.readFileSync(notePath, "utf8"), /Generated Summary/);
  assert.match(fs.readFileSync(transcriptPath, "utf8"), /Spoken result/);
  assert.equal(
    worker.setSpeakerCorrection({
      runId: summary.run.id,
      speakerId: "system:A",
      profileId: null,
      displayName: "Confirmed Speaker",
    }),
    true
  );
  await flush();
  assert.match(fs.readFileSync(transcriptPath, "utf8"), /Confirmed Speaker/);

  db.updateNote(created.noteId, { enhanced_content: "Recovered Summary" });
  const outside = path.join(getUserDataDir(), "outside.md");
  fs.writeFileSync(outside, "untouched");
  fs.unlinkSync(notePath);
  fs.symlinkSync(outside, notePath);
  owner._publishMeetingNoteProjection(created.noteId);
  await flush();
  assert.equal(db.getNote(created.noteId)!.enhanced_content, "Recovered Summary");
  assert.equal(fs.readFileSync(outside, "utf8"), "untouched");
  fs.unlinkSync(notePath);
  owner._rebuildMirror(undefined);
  assert.match(fs.readFileSync(notePath, "utf8"), /Recovered Summary/);

  db.updateNote(created.noteId, { transcript: null, enhanced_content: null });
  owner._publishMeetingNoteProjection(created.noteId);
  await flush();
  assert.equal(fs.existsSync(transcriptPath), false, "empty projection removes stale transcript");
  assert.match(fs.readFileSync(notePath, "utf8"), /Calendar manual text/);
  db.updateNote(created.noteId, { enhanced_content: "Disabled update" });
  owner._publishMeetingNoteProjection(created.noteId);
  owner._noteFilesEnabled = false;
  await flush();
  assert.doesNotMatch(fs.readFileSync(notePath, "utf8"), /Disabled update/);
});
