import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDb } from "../../../helpers/harness/db.ts";
import { getUserDataDir } from "../../../helpers/harness/electronStub.ts";
import { MeetingRecordingStorage } from "../../../../src/helpers/meetingRecordingStorage.ts";
import { NoteReadService } from "../../../../src/helpers/noteReadService.ts";
import type { MeetingProcessingConfig } from "../../../../src/contracts/meetingRecording.ts";

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
    model: "gpt-4o-mini",
    credentialRef: "OPENAI_API_KEY",
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

test("Note projection has unknown origin while explicit historical run keeps its artifact after a new pending run", (t) => {
  const f = fixture(t);
  const newer = f.db.createMeetingProcessingRun(f.recording.id, { kind: "reprocess", config });
  const projection = f.reader.readOutput({ scope: "note", noteId: f.note.id });
  assert.equal(projection.scope, "note");

  if (projection.scope !== "note") return;
  assert.equal(projection.summary, "manual projection");
  assert.deepEqual(projection.summaryProvenance, { source: "note-projection", runIds: [] });
  assert.equal(projection.summaryFreshness.status, "unknown");
  assert.equal(projection.currentRuns[0].runId, newer.id);
  const historical = f.reader.readOutput({ scope: "run", noteId: f.note.id, runId: f.run.id });
  assert.equal(historical.scope, "run");

  if (historical.scope !== "run") return;
  assert.equal(historical.result?.summary?.text, "artifact summary");
  assert.deepEqual(historical.summaryProvenance.runIds, [f.run.id]);
  assert.equal(historical.summaryFreshness.status, "unknown");
  assert.equal(f.db.getMeetingRecording(f.recording.id)?.currentRunId, newer.id);
  assert.equal(f.db.getNote(f.note.id)?.enhanced_content, "manual projection");
});

test("Summary-only reads expose distinct Summary and transcript origins without Note fallback", (t) => {
  const f = fixture(t);

  const summary = f.db.createMeetingProcessingRun(f.recording.id, {
    kind: "summary",
    sourceRunId: f.run.id,
    config,
  });

  let output = f.reader.readOutput({ scope: "run", noteId: f.note.id, runId: summary.id });
  assert.equal(output.scope, "run");

  if (output.scope !== "run") return;
  assert.deepEqual(output.transcriptProvenance.runIds, [f.run.id]);
  assert.deepEqual(output.summaryProvenance.runIds, [f.run.id]);
  f.db.setMeetingProcessingRunState(summary.id, { status: "running", stage: "summary" });
  f.storage.writeRunArtifact(summary.id, "summary", {
    text: "new summary",
    speakerCorrectionRevision: 0,
  });
  f.db.setMeetingRunArtifact(summary.id, "summary");
  output = f.reader.readOutput({ scope: "run", noteId: f.note.id, runId: summary.id });
  assert.equal(output.scope, "run");

  if (output.scope !== "run") return;
  assert.deepEqual(output.summaryProvenance.runIds, [summary.id]);
  assert.equal(output.result?.summary?.text, "new summary");
});

test("freshness uses saved generation and authoritative corrections, including a cleared model tombstone", (t) => {
  const f = fixture(t);
  f.db.setMeetingProcessingRunState(f.run.id, { status: "running", stage: "summary" });
  assert.equal(f.db.setMeetingRunLlmSourceSnapshot(f.run.id, JSON.stringify(snapshot(f))), true);
  const read = () => f.reader.readOutput({ scope: "run", noteId: f.note.id, runId: f.run.id });
  assert.equal(read().summaryFreshness.status, "current");
  f.db.updateNote(f.note.id, { content: "changed", title: "changed title" });
  assert.deepEqual(read().summaryFreshness.reasons, ["manual-notes-changed", "title-changed"]);
  f.db.updateNote(f.note.id, { content: f.note.content, title: f.note.title });
  f.db.updateNote(f.note.id, {
    transcript: JSON.stringify([{ text: "source transcript", speaker: "speaker_0" }]),
  });
  f.db.setMeetingRunSpeakerCorrection(f.run.id, "speaker_0", null, "Suggested", "model");
  assert.equal(
    f.db.applyAutomaticMeetingSpeakerCorrections(f.run.id, f.run.id, 1, [], "model", ["speaker_0"]),
    true
  );
  const revoked = read();
  assert.equal(revoked.summaryFreshness.status, "stale");
  assert.ok(revoked.summaryFreshness.reasons.includes("speaker-corrections-changed"));

  if (revoked.scope === "run") {
    assert.deepEqual(revoked.result?.speakerCorrections, []);
    assert.ok(revoked.result!.speakerCorrectionRevision > 0);
  }
});

test("missing and invalid run artifacts never become a complete Note projection result", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.storage.createRunDirectory(f.run.id), "summary.json"),
    JSON.stringify({ invalid: true })
  );
  const invalid = f.reader.readOutput({ scope: "run", noteId: f.note.id, runId: f.run.id });
  assert.equal(invalid.scope, "run");

  if (invalid.scope !== "run") return;
  assert.equal(invalid.result, null);
  assert.ok(invalid.diagnostics.length);
  assert.equal(invalid.summaryFreshness.status, "unknown");
  const empty = f.db.createMeetingProcessingRun(f.recording.id, { kind: "reprocess", config });
  const missing = f.reader.readOutput({ scope: "run", noteId: f.note.id, runId: empty.id });
  assert.equal(missing.scope, "run");

  if (missing.scope !== "run") return;
  assert.equal(missing.result?.summary, null);
  assert.ok(missing.diagnostics.includes("summary-artifact-missing"));
  assert.equal(f.db.getNote(f.note.id)?.enhanced_content, "manual projection");
});

test("Note without recordings reads manual/upload projection, and foreign run requests fail", (t) => {
  const f = fixture(t);
  const plain = f.db.saveNote("Upload", "draft", "upload").note!;
  f.db.updateNote(plain.id, { transcript: "uploaded text", enhanced_content: "edited summary" });
  const output = f.reader.readOutput({ scope: "note", noteId: plain.id });
  assert.equal(output.scope, "note");

  if (output.scope !== "note") return;
  assert.equal(output.transcript.text, "uploaded text");
  assert.equal(output.transcript.segments, null);
  assert.deepEqual(output.transcriptSources, []);
  assert.equal(output.transcriptFreshness.status, "unknown");
  assert.throws(
    () => f.reader.readOutput({ scope: "run", noteId: plain.id, runId: f.run.id }),
    /not-owned/
  );
  assert.throws(() => f.reader.readOutput({ scope: "note", noteId: 99999 }), /not-found/);
});

test("invalid aggregate artifacts retain diagnostics without replacing them with the Note projection", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.storage.createRunDirectory(f.run.id), "transcript.json"),
    JSON.stringify({ invalid: true })
  );
  const output = f.reader.readOutput({ scope: "note", noteId: f.note.id });
  assert.equal(output.scope, "note");

  if (output.scope !== "note") return;
  assert.equal(output.transcript.status, "error");
  assert.equal(output.transcript.text, null);
  assert.equal(output.summary, "manual projection");
  assert.deepEqual(output.transcriptSources, []);
  assert.equal(output.transcriptFreshness.status, "unknown");
  assert.ok(output.diagnostics.includes("transcript-artifact-invalid"));
});
