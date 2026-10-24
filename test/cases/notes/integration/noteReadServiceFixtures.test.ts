import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDb } from "../../../helpers/harness/db.ts";
import { installElectronStub, getUserDataDir } from "../../../helpers/harness/electronStub.ts";
import { MeetingRecordingStorage } from "../../../../src/helpers/meetingRecordingStorage.ts";
import { NoteReadService } from "../../../../src/helpers/noteReadService.ts";
import type { MeetingProcessingConfig } from "../../../../src/contracts/meetingRecording.ts";

installElectronStub();

// #418 follow-up fixtures (from the PR #414 ledger divergence classes):
// show-view participant priority + email matching (B9), generation-freshness
// reason literals through a seeded store (B8), ownership/digest source
// resolution (B7). Tests observe behavior; no production changes.

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
    instruction: "Summarize",
    reasoningMode: "providers",
    provider: "openai",
  },
};

function fixture(t: import("node:test").TestContext) {
  const db = createDb(t)!;
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const reader = new NoteReadService(db, storage);
  const note = db.saveNote("Meeting title", "manual", "meeting").note!;
  const recording = db.createMeetingRecording(note.id, { config }, "2026-10-01T10:00:00.000Z");
  db.markMeetingRecordingFinalizing(recording.id);

  const run = db.finalizeMeetingRecording(recording.id, {
    captureState: "ready",
    endedAt: "2026-10-01T10:00:01.000Z",
    sourceMetadata: { captureEndFrame: 24000 },
  }).initialRun;

  db.setMeetingProcessingRunState(run.id, { status: "running", stage: "normalize" });
  storage.writeRunArtifact(run.id, "provider-response", {});
  assert.equal(db.setMeetingRunArtifact(run.id, "provider-response").success, true);
  storage.writeRunArtifact(run.id, "transcript", {
    text: "source transcript",
    segments: [{ start: 0, end: 1, speaker: "speaker_0", text: "source transcript" }],
  });
  storage.writeRunArtifact(run.id, "summary", {
    text: "artifact summary",
    speakerCorrectionRevision: 0,
  });
  assert.equal(db.setMeetingRunArtifact(run.id, "transcript").success, true);
  assert.equal(db.setMeetingRunArtifact(run.id, "summary").success, true);
  db.setMeetingProcessingRunState(run.id, { status: "complete", stage: "summary" });
  db.updateNote(note.id, { enhanced_content: "manual projection", transcript: "projection text" });

  return { db, storage, reader, note, recording, run };
}

function snapshot(f: ReturnType<typeof fixture>) {
  return {
    version: 1,
    sourceRunId: f.run.id,
    sourceRecordingIds: [f.recording.id],
    meetingTitle: f.note.title,
    participants: [],
    manualNotes: f.note.content,
    manualNoteRevision: createHash("sha256").update(f.note.content).digest("hex"),
    speakerCorrectionRevision: 0,
    transcriptSegments: [
      { id: "segment_1", speakerId: "speaker_0", speakerName: null, text: "source transcript" },
    ],
    promptModel: config.summary,
  };
}

function seedSnapshot(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const base = snapshot(f) as Record<string, unknown>;
  f.db.setMeetingRunLlmSourceSnapshot(f.run.id, JSON.stringify({ ...base, ...overrides }));
}

test("show view: stored-name precedence is learned > people > display (B9)", (t) => {
  const db = createDb(t)!;
  const reader = new NoteReadService(db, { readRunArtifact: () => null } as never);
  const note = db.saveNote("Priority", "", "meeting").note!;
  const email = "ann@example.org";
  db.upsertContacts([{ email, displayName: "Stored Display" }]);
  db.upsertGooglePeople([{ email, displayName: "Stored People", photoUrl: null }]);
  // learned_name has no public write API; seed the row directly (same store the
  // production learned-name path writes).
  (db as unknown as { sql: { prepare: (s: string) => { run: (...args: unknown[]) => void } } }).sql
    .prepare("UPDATE contacts SET learned_name = 'Stored Learned' WHERE email = ?")
    .run(email);
  db.updateNote(note.id, {
    participants: JSON.stringify([{ email: "Ann@Example.org", displayName: "Contact Name" }]),
    transcript: JSON.stringify([
      { text: "hello", speaker: "spk", timestamp: 1, endTimestamp: 2 },
    ]),
  });

  const view = reader.show(db.getNote(note.id)!);
  assert.equal(view.participants.length, 1);
  assert.equal(view.participants[0].name, "Stored Learned");
  assert.deepEqual(view.participants[0].stored_names, {
    display_name: "Stored Display",
    people_name: "Stored People",
    learned_name: "Stored Learned",
  });
});

test("show view: a spoken speaker without a stored contact is appended with own name (B9)", (t: import("node:test").TestContext) => {
  const db = createDb(t)!;
  const reader = new NoteReadService(db, { readRunArtifact: () => null } as never);
  const note = db.saveNote("Append", "", "meeting").note!;
  // The transcript comes from the stored-projection arm (raw entries carry
  // speakerName/email); the show view appends spoken speakers that are not
  // already among the note's participants.
  db.updateNote(note.id, {
    participants: JSON.stringify([{ email: "other@example.org", displayName: "Other" }]),
    transcript: JSON.stringify([
      { text: "hello", speaker: "spoken voice", speakerName: "Spoken Voice", source: "mic", timestamp: 1, endTimestamp: 2 },
    ]),
  });

  const view = reader.show(db.getNote(note.id)!);
  const appended = view.participants.find((person) => person.email === null && person.name === "Spoken Voice");
  assert.ok(appended, "the spoken speaker is appended");
  assert.equal(view.participants.filter((person) => person.email === "other@example.org").length, 1);
});

test("show view: a spoken speaker whose email differs only by case does not duplicate the participant (B9)", (t) => {
  const f = fixture(t);
  // The projection arm stores no speaker email, so only a run transcript can
  // carry one; it comes from the speaker correction's participant email. The
  // correction also rewrites the stored projection, which must be valid JSON.
  f.db.updateNote(f.note.id, {
    participants: JSON.stringify([{ email: "Ann@Example.org", displayName: "Ann Example" }]),
    transcript: JSON.stringify([{ text: "source transcript", speaker: "speaker_0" }]),
  });
  assert.equal(
    f.db.setMeetingRunSpeakerCorrection(f.run.id, "speaker_0", null, "Ann Example", "user", "ann@example.org").success,
    true
  );

  const view = f.reader.show(f.db.getNote(f.note.id)!);
  assert.equal(view.participants.length, 1, "a case-differing email must not append a duplicate participant");
  assert.equal(view.participants[0].email, "Ann@Example.org");
});

test("show view: a spoken speaker with a different email is appended (B9)", (t) => {
  const f = fixture(t);
  f.db.updateNote(f.note.id, {
    participants: JSON.stringify([{ email: "other@example.org", displayName: "Other" }]),
    transcript: JSON.stringify([{ text: "source transcript", speaker: "speaker_0" }]),
  });
  assert.equal(
    f.db.setMeetingRunSpeakerCorrection(f.run.id, "speaker_0", null, "Ann Example", "user", "ann@example.org").success,
    true
  );

  const view = f.reader.show(f.db.getNote(f.note.id)!);
  assert.equal(view.participants.length, 2);
  assert.equal(view.participants.filter((person) => person.email === "ann@example.org").length, 1);
});

test("freshness reasons: participants drift, correction revision drift and config drift each surface verbatim (B8)", (t) => {
  const f = fixture(t);
  f.db.setMeetingProcessingRunState(f.run.id, { status: "running", stage: "summary" });
  seedSnapshot(f);
  f.db.updateNote(f.note.id, { participants: JSON.stringify([{ email: "drift@example.org" }]) });
  const read = () => f.reader.readOutput({ scope: "run", noteId: f.note.id, runId: f.run.id });

  const drifted = read();
  assert.equal(drifted.summaryFreshness.status, "stale");
  assert.deepEqual(drifted.summaryFreshness.reasons, ["participants-changed"]);

  // Correction revision drift (snapshot says 0, authoritative revision advances).
  // The correction apply walks the note's stored transcript JSON, so seed valid JSON.
  const corrections = fixture(t);
  corrections.db.updateNote(corrections.note.id, {
    transcript: JSON.stringify([{ text: "source transcript", speaker: "speaker_0" }]),
  });
  corrections.db.setMeetingProcessingRunState(corrections.run.id, { status: "running", stage: "summary" });
  seedSnapshot(corrections);
  corrections.db.setMeetingRunSpeakerCorrection(corrections.run.id, "speaker_0", null, "Suggested", "model");
  assert.equal(
    corrections.db.applyAutomaticMeetingSpeakerCorrections(corrections.run.id, corrections.run.id, 1, [], "model", ["speaker_0"]),
    true
  );
  const revoked = corrections.reader.readOutput({ scope: "run", noteId: corrections.note.id, runId: corrections.run.id });
  assert.equal(revoked.summaryFreshness.status, "stale");
  // Both drift checks push this reason; the Set keeps one copy.
  assert.deepEqual(revoked.summaryFreshness.reasons, ["speaker-corrections-changed"]);

  // Summary config drift (snapshot promptModel vs the run's config.summary).
  const configured = fixture(t);
  configured.db.setMeetingProcessingRunState(configured.run.id, { status: "running", stage: "summary" });
  seedSnapshot(configured, { promptModel: { actionId: "notes.actions.builtin.detailedNotes", instruction: "Different", reasoningMode: "providers", provider: "openai" } });
  const configDrift = configured.reader.readOutput({ scope: "run", noteId: configured.note.id, runId: configured.run.id });
  assert.equal(configDrift.summaryFreshness.status, "stale");
  assert.deepEqual(configDrift.summaryFreshness.reasons, ["summary-config-changed"]);
});

test("freshness source resolution: snapshot bound to a foreign run reports generation-metadata-unavailable (B7/B8)", (t) => {
  const f = fixture(t);
  f.db.setMeetingProcessingRunState(f.run.id, { status: "running", stage: "summary" });
  const foreign = { ...snapshot(f), sourceRunId: "00000000-0000-4000-8000-00000000000f" };
  f.db.setMeetingRunLlmSourceSnapshot(f.run.id, JSON.stringify(foreign));
  const output = f.reader.readOutput({ scope: "run", noteId: f.note.id, runId: f.run.id });
  assert.equal(output.summaryFreshness.status, "unknown");
  assert.deepEqual(output.summaryFreshness.reasons, ["generation-metadata-unavailable"]);
});

test("freshness digest: manual-notes change surfaces the manual-notes-changed reason verbatim (B8/B7 digest)", (t) => {
  const f = fixture(t);
  f.db.setMeetingProcessingRunState(f.run.id, { status: "running", stage: "summary" });
  seedSnapshot(f);
  f.db.updateNote(f.note.id, { content: "changed content" });
  const output = f.reader.readOutput({ scope: "run", noteId: f.note.id, runId: f.run.id });
  assert.equal(output.summaryFreshness.status, "stale");
  assert.deepEqual(output.summaryFreshness.reasons, ["manual-notes-changed"]);
});
