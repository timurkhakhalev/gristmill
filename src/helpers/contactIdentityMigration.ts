import { z } from "zod";
import type { SqliteDatabase } from "./database.js";

const legacyParticipantSchema = z
  .object({
    contactId: z.number().int().positive().optional(),
    email: z.string().nullish(),
    displayName: z.string().nullish(),
  })
  .passthrough()
  .refine(
    (person) => person.email != null || person.displayName != null || person.contactId != null
  );

/** The profile table remains in place so its incoming voice-history links survive. */
export function migrateContactIdentity(database: SqliteDatabase): void {
  const columns = database.pragma<Array<{ name: string }>>("table_info(contacts)");

  if (columns.some((column) => column.name === "id")) return;
  database.transaction(() => {
    database.exec(`
      CREATE TABLE contacts_identity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE CHECK(email IS NULL OR (email <> '' AND email = lower(trim(email)))),
        telegram_username TEXT COLLATE NOCASE UNIQUE,
        display_name TEXT, people_name TEXT, learned_name TEXT, photo_url TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO contacts_identity (email, display_name, people_name, learned_name, photo_url, created_at, updated_at)
        SELECT NULLIF(lower(trim(email)), ''), display_name, people_name, learned_name, photo_url, created_at, updated_at FROM contacts ORDER BY rowid;
      DROP TABLE contacts;
      ALTER TABLE contacts_identity RENAME TO contacts;
      ALTER TABLE speaker_profiles ADD COLUMN contact_id INTEGER REFERENCES contacts(id);
      ALTER TABLE meeting_run_speaker_corrections ADD COLUMN participant_contact_id INTEGER REFERENCES contacts(id);
      ALTER TABLE notes ADD COLUMN participant_context_frozen INTEGER NOT NULL DEFAULT 0;
    `);

    const resolve = (email: string | null | undefined, name?: string | null): number => {
      const normalized = email?.trim().toLowerCase() || null;

      const existing = normalized
        ? database
            .prepare("SELECT id FROM contacts WHERE email = ?")
            .get<{ id: number }>(normalized)
        : undefined;

      return (
        existing?.id ??
        Number(
          database
            .prepare("INSERT INTO contacts (email, display_name) VALUES (?, ?)")
            .run(normalized, name ?? null).lastInsertRowid
        )
      );
    };

    for (const note of database
      .prepare("SELECT id, participants FROM notes WHERE participants IS NOT NULL")
      .all<{ id: number; participants: string }>()) {
      let parsed: unknown;

      try {
        parsed = JSON.parse(note.participants);
      } catch {
        continue;
      }

      const list = z.array(z.unknown()).safeParse(parsed);

      if (!list.success) continue;

      const participants = list.data.map((entry) => {
        const result = legacyParticipantSchema.safeParse(entry);

        if (!result.success) return entry;
        const person = result.data;

        const explicit =
          person.contactId &&
          database
            .prepare("SELECT id FROM contacts WHERE id = ?")
            .get<{ id: number }>(person.contactId);

        return {
          ...person,
          contactId: explicit ? explicit.id : resolve(person.email, person.displayName),
          email: person.email?.trim() ? person.email : null,
          displayName: person.displayName ?? null,
        };
      });

      database
        .prepare("UPDATE notes SET participants = ? WHERE id = ?")
        .run(JSON.stringify(participants), note.id);
    }

    for (const profile of database
      .prepare(
        "SELECT id, email, display_name FROM speaker_profiles WHERE NULLIF(trim(email), '') IS NOT NULL"
      )
      .all<{ id: number; email: string; display_name: string }>()) {
      database
        .prepare("UPDATE speaker_profiles SET contact_id = ? WHERE id = ?")
        .run(resolve(profile.email, profile.display_name), profile.id);
    }

    for (const correction of database
      .prepare(
        "SELECT run_id, speaker_id, participant_email, display_name FROM meeting_run_speaker_corrections WHERE NULLIF(trim(participant_email), '') IS NOT NULL"
      )
      .all<{
        run_id: string;
        speaker_id: string;
        participant_email: string;
        display_name: string;
      }>()) {
      database
        .prepare(
          "UPDATE meeting_run_speaker_corrections SET participant_contact_id = ? WHERE run_id = ? AND speaker_id = ?"
        )
        .run(
          resolve(correction.participant_email, correction.display_name),
          correction.run_id,
          correction.speaker_id
        );
    }

    database.exec(`
      ALTER TABLE speaker_profiles DROP COLUMN email;
      UPDATE notes SET participant_context_frozen = 1 WHERE NULLIF(enhanced_content, '') IS NOT NULL OR EXISTS (
        SELECT 1 FROM meeting_processing_runs r JOIN meeting_recordings m ON m.id = r.recording_id
        WHERE m.note_id = notes.id AND r.llm_source_snapshot_json IS NOT NULL
      );
    `);

    if (database.pragma<unknown[]>("foreign_key_check").length)
      throw new Error("Contact identity migration violates foreign keys");
  })();
}
