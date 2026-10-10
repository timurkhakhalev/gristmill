import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { DatabaseManager } from "./db.js";
import type { MeetingRecordingStorage } from "../../../src/helpers/meetingRecordingStorage.js";
import {
  meetingRecordingIdSchema,
  meetingSourceSchema,
} from "../../../src/contracts/meetingRecording.ts";

const scalar = z.union([z.string(), z.number().finite(), z.null()]);
const row = z.record(z.string(), scalar);
const transportSchema = z.object({
  format: z.literal(1),
  recordings: z.array(row).min(1),
  epochs: z.array(row),
  alignments: z.array(row),
  intervals: z.array(row),
  files: z.array(
    z.object({
      recording_id: meetingRecordingIdSchema,
      source: meetingSourceSchema,
      epoch_index: z.number().int().nonnegative().safe(),
      file: z.string().min(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
  ),
});

export function meetingAudioFileHash(filePath: string) {
  const hash = createHash("sha256"),
    fd = fs.openSync(filePath, "r"),
    block = Buffer.alloc(1024 * 1024);
  try {
    let size: number;
    while ((size = fs.readSync(fd, block, 0, block.length, null)))
      hash.update(block.subarray(0, size));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export function replayMeetingFixture(
  directory: string,
  db: DatabaseManager,
  storage: MeetingRecordingStorage
) {
  const root = fs.realpathSync(directory),
    repository = fs.realpathSync(path.resolve(__dirname, "../../.."));
  assert.ok(
    root !== repository && !root.startsWith(repository + path.sep),
    "private fixture must be outside checkout"
  );
  const input = transportSchema.parse(
    JSON.parse(fs.readFileSync(path.join(root, "raw-rows.json"), "utf8"))
  );
  const insert = (table: string, rows: z.infer<typeof row>[]) => {
    const schema = z
      .array(z.object({ name: z.string() }).loose())
      .parse(db.db.prepare(`PRAGMA table_info(${table})`).all());
    const names = new Set(schema.map((column) => column.name));
    for (const value of rows) {
      const columns = Object.keys(value);
      assert.ok(
        columns.every((column) => names.has(column)),
        "unknown raw SQL column"
      );
      db.db
        .prepare(
          `INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`
        )
        .run(...columns.map((column) => value[column]));
    }
  };
  db.db.transaction(() => {
    const notes = new Set(
      input.recordings.map((recording) =>
        z.number().int().positive().safe().parse(recording.note_id)
      )
    );
    for (const id of notes)
      db.db
        .prepare("INSERT INTO notes (id,title,content,note_type) VALUES (?,?,?,?)")
        .run(id, "Private replay", "", "meeting");
    insert("meeting_recordings", input.recordings);
    insert("meeting_recording_epochs", input.epochs);
    insert("meeting_recording_epoch_alignments", input.alignments);
    insert("meeting_recording_intentional_intervals", input.intervals);
  })();
  for (const file of input.files) {
    assert.equal(
      path.basename(file.file),
      file.file,
      "private source reference must be a basename"
    );
    const source = fs.realpathSync(path.join(root, file.file));
    assert.equal(path.dirname(source), root);
    assert.equal(meetingAudioFileHash(source), file.sha256, "transport source changed");
    storage.createEpochFile(file.recording_id, file.source, file.epoch_index);
    const target = storage.getEpochFilePath(file.recording_id, file.source, file.epoch_index);
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o600);
    assert.equal(meetingAudioFileHash(target), file.sha256);
    assert.equal(
      meetingAudioFileHash(source),
      file.sha256,
      "transport source changed during replay"
    );
  }
  // Only production readers establish DTO contracts; raw rows are never cast to them.
  return input.recordings.map((raw) => {
    const id = meetingRecordingIdSchema.parse(raw.id);
    const recording = db.getMeetingRecording(id);
    assert.ok(recording);
    return {
      recording,
      epochs: db.listMeetingRecordingEpochs(id),
      intervals: db.listMeetingIntentionalIntervals(id),
    };
  });
}
