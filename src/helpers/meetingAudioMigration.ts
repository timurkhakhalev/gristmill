import fs from "fs";
import path from "path";
import type { SqliteDatabase } from "./database.js";
import { meetingRecordingIdSchema, meetingSourceSchema } from "../contracts/meetingRecording.js";
import { convertMeetingPcm, inspectMeetingOpus } from "./meetingOpus.js";

/** Bootstrap cutover: until the transaction commits, every PCM original remains usable. */
export function migrateMeetingAudio(database: SqliteDatabase, userData: string): void {
  // SAFETY: this query selects the sqlite_master row for the table we created,
  // so a syntax-only read of its schema is the migration contract.
  const schema = database
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'meeting_recording_epochs'")
    .get() as { sql: string };

  if (!schema.sql.includes("'pcm_s16le'")) {
    removeMigratedPcm(database, userData);

    return;
  }

  // SAFETY: the join selects the migration columns this function created; the
  // .all() result is the epoch list the migration loop then validates per row.
  const rows = database
    .prepare(
      "SELECT e.*, r.audio_state FROM meeting_recording_epochs e JOIN meeting_recordings r ON r.id = e.recording_id"
    )
    .all() as Array<{
    recording_id: string;
    source: string;
    epoch_index: number;
    relative_path: string;
    audio_state: string;
    frame_count: number;
    state: string;
  }>;

  const backup = path.join(userData, "meeting-audio-before-opus");

  if (
    fs.existsSync(backup) &&
    (!fs.lstatSync(backup).isDirectory() || fs.lstatSync(backup).isSymbolicLink())
  )
    throw new Error("Unsafe migration backup directory");

  if (!fs.existsSync(backup)) fs.mkdirSync(backup, { mode: 0o700 });
  const dbBackup = path.join(backup, "database.sqlite");

  if (!fs.existsSync(dbBackup)) {
    const temporary = `${dbBackup}.tmp`;
    fs.rmSync(temporary, { force: true });
    database.prepare("VACUUM INTO ?").run(temporary);
    fs.chmodSync(temporary, 0o600);
    syncPath(temporary);
    fs.renameSync(temporary, dbBackup);
    syncPath(backup);
    syncPath(userData);
  }

  const updates: Array<{ row: (typeof rows)[number]; frames: number; error: string | null }> = [];

  for (const row of rows) {
    meetingRecordingIdSchema.parse(row.recording_id);
    meetingSourceSchema.parse(row.source);

    if (!Number.isSafeInteger(row.epoch_index) || row.epoch_index < 0 || row.epoch_index > 999_999)
      throw new Error("Invalid migration epoch");
    const relative = `${row.source}/epoch-${String(row.epoch_index).padStart(6, "0")}.pcm`;

    if (row.relative_path !== relative) throw new Error("Invalid migration audio path");
    const original = path.join(userData, "audio", "meetings", row.recording_id, relative);
    const destination = original.replace(/\.pcm$/, ".opus");
    // Refuse symlinks anywhere in the managed source or backup directory.
    assertMigrationPath(userData, original);
    assertMigrationPath(userData, destination);
    assertMigrationPath(userData, path.join(backup, row.recording_id, relative));

    if (row.audio_state !== "available" || !fs.existsSync(original)) {
      updates.push({
        row,
        frames: row.audio_state === "available" ? 0 : row.frame_count,
        error: row.audio_state === "available" ? "missing-epoch" : null,
      });
      continue;
    }

    const saved = path.join(backup, row.recording_id, relative);
    fs.mkdirSync(path.dirname(saved), { recursive: true, mode: 0o700 });

    if (!fs.existsSync(saved)) {
      fs.linkSync(original, saved);

      for (
        let directory = path.dirname(saved);
        directory !== userData;
        directory = path.dirname(directory)
      )
        syncPath(directory);
      syncPath(userData);
    }

    const frames = Math.floor(fs.statSync(original).size / 2);

    if (!frames) {
      fs.closeSync(
        fs.openSync(
          destination,
          fs.constants.O_CREAT |
            fs.constants.O_WRONLY |
            fs.constants.O_TRUNC |
            (fs.constants.O_NOFOLLOW ?? 0),
          0o600
        )
      );
      updates.push({ row, frames, error: "empty-epoch" });
      continue;
    }

    const ready = fs.existsSync(destination) ? inspectMeetingOpus(destination) : null;

    if (!ready || ready.errorCode || ready.ignoredTrailingBytes || ready.frameCount !== frames)
      convertMeetingPcm(original, destination);
    updates.push({
      row,
      frames,
      error: fs.statSync(original).size % 2 ? "pcm-trailing-byte" : null,
    });
  }

  database.transaction(() => {
    database.exec(
      schema.sql
        .replace("meeting_recording_epochs", "meeting_recording_epochs_opus")
        .replace("'pcm_s16le'", "'opus'")
        .replace("ignored_trailing_bytes BETWEEN 0 AND 1", "ignored_trailing_bytes >= 0")
    );
    database.exec(
      "INSERT INTO meeting_recording_epochs_opus SELECT recording_id, source, epoch_index, start_frame, sample_rate, channels, 'opus', replace(relative_path, '.pcm', '.opus'), state, frame_count, 0, error_code, created_at, updated_at FROM meeting_recording_epochs"
    );

    for (const { row, frames, error } of updates) {
      database
        .prepare(
          "UPDATE meeting_recording_epochs_opus SET frame_count = ?, state = ?, error_code = COALESCE(?, error_code) WHERE recording_id = ? AND source = ? AND epoch_index = ?"
        )
        .run(
          frames,
          error ? "incomplete" : row.state,
          error,
          row.recording_id,
          row.source,
          row.epoch_index
        );

      if (error)
        database
          .prepare(
            "UPDATE meeting_recordings SET capture_state = CASE WHEN capture_state = 'ready' THEN 'incomplete' ELSE capture_state END, capture_error_code = COALESCE(capture_error_code, ?) WHERE id = ?"
          )
          .run(error, row.recording_id);
    }

    database.exec(
      "DROP TABLE meeting_recording_epochs; ALTER TABLE meeting_recording_epochs_opus RENAME TO meeting_recording_epochs"
    );
  })();

  // The backup's hard links retain originals without duplicating their disk blocks.
  for (const row of rows)
    fs.rmSync(path.join(userData, "audio", "meetings", row.recording_id, row.relative_path), {
      force: true,
    });
}

/** Finish unlinking originals if the process stopped after the SQL commit. */
function removeMigratedPcm(database: SqliteDatabase, userData: string): void {
  const backup = path.join(userData, "meeting-audio-before-opus");

  if (!fs.existsSync(backup)) return;

  // SAFETY: this is the migration table's two-column projection; each
  // recording_id is schema-validated and the path is regex-checked below.
  const rows = database
    .prepare("SELECT recording_id, relative_path FROM meeting_recording_epochs")
    .all() as Array<{ recording_id: string; relative_path: string }>;

  for (const row of rows) {
    meetingRecordingIdSchema.parse(row.recording_id);

    if (!/^(mic|system)\/epoch-\d{6}\.opus$/.test(row.relative_path))
      throw new Error("Invalid migrated audio path");
    const relative = row.relative_path.replace(/\.opus$/, ".pcm");
    const original = path.join(userData, "audio", "meetings", row.recording_id, relative);
    const saved = path.join(backup, row.recording_id, relative);
    assertMigrationPath(userData, original);
    assertMigrationPath(userData, saved);

    if (!fs.existsSync(original) || !fs.existsSync(saved)) continue;
    const a = fs.statSync(original);
    const b = fs.statSync(saved);

    if (a.isFile() && a.ino === b.ino && a.dev === b.dev) fs.unlinkSync(original);
  }
}

function assertMigrationPath(userData: string, file: string): void {
  for (let current = file; current !== userData; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
      throw new Error("Unsafe audio migration path");
  }
}

function syncPath(filePath: string): void {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));

  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
