import type { SqliteDatabase } from "./database.js";

/** One-way, atomic metadata cutover. Raw audio and decision identities stay intact. */
export function migrateMeetingPlatformEvidence(database: SqliteDatabase): void {
  database.transaction(() => {
    const old = database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meeting_zoom_observations'"
      )
      .get();

    if (old)
      database.exec(
        "ALTER TABLE meeting_zoom_observations RENAME TO meeting_platform_observations"
      );
    database.exec(`
      CREATE TABLE IF NOT EXISTS meeting_platform_observations (
        id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES meeting_recordings(id) ON DELETE CASCADE, evidence_json TEXT NOT NULL
      );
      DROP INDEX IF EXISTS meeting_zoom_observations_recording;
      CREATE INDEX IF NOT EXISTS meeting_platform_observations_recording ON meeting_platform_observations(recording_id);
      UPDATE meeting_platform_observations SET evidence_json = json_set(evidence_json,
        '$.platform', 'zoom', '$.bindingId', json_extract(evidence_json, '$.sessionId'),
        '$.activeParticipantIds', CASE WHEN json_extract(evidence_json, '$.activity') IN ('explicit', 'end')
          THEN json_array(json_extract(evidence_json, '$.instanceKey')) ELSE json('[]') END,
        '$.clockGeneration', json('null'), '$.clockUncertaintyNs', '0')
      WHERE json_type(evidence_json, '$.platform') IS NULL;
      UPDATE meeting_run_platform_decisions SET decisions_json = (
        SELECT json_group_array(CASE WHEN json_type(value, '$.platform') IS NULL
          THEN json_set(value, '$.platform', 'zoom') ELSE json(value) END)
        FROM json_each(meeting_run_platform_decisions.decisions_json)
      ) WHERE EXISTS (SELECT 1 FROM json_each(meeting_run_platform_decisions.decisions_json) WHERE json_type(value, '$.platform') IS NULL);
    `);

    const columns = database.pragma("table_info(meeting_run_speaker_corrections)") as Array<{
      name: string;
    }>;

    if (!columns.some((column) => column.name === "platform")) {
      database.exec(
        "ALTER TABLE meeting_run_speaker_corrections ADD COLUMN platform TEXT CHECK(platform IN ('zoom', 'google-meet', 'telemost'))"
      );
      database.exec(
        "UPDATE meeting_run_speaker_corrections SET platform = 'zoom' WHERE source = 'platform'"
      );
    }

    const definition = database
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'meeting_run_speaker_corrections'")
      .get() as { sql: string };

    if (!definition.sql.includes("'telemost'")) {
      database.exec(`
        CREATE TABLE meeting_run_speaker_corrections_telemost (
          run_id TEXT NOT NULL REFERENCES meeting_processing_runs(id) ON DELETE CASCADE,
          speaker_id TEXT NOT NULL,
          profile_id INTEGER REFERENCES speaker_profiles(id) ON DELETE SET NULL,
          display_name TEXT NOT NULL,
          participant_email TEXT,
          source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('voice', 'platform', 'model', 'user')),
          revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
          platform TEXT CHECK(platform IN ('zoom', 'google-meet', 'telemost')),
          PRIMARY KEY (run_id, speaker_id)
        );
        INSERT INTO meeting_run_speaker_corrections_telemost
          SELECT run_id, speaker_id, profile_id, display_name, participant_email, source, revision, platform
          FROM meeting_run_speaker_corrections;
        DROP TABLE meeting_run_speaker_corrections;
        ALTER TABLE meeting_run_speaker_corrections_telemost RENAME TO meeting_run_speaker_corrections;
      `);
    }
  })();
}
