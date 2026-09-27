// @probe-name "wrong row usage and wrong method dependencies fail compilation"
// @probe-codes [2322,2322,2322,2322,2322,2322,2322,2345,2554]
// @probe-origin test/scripts/databaseTypeProbe.test.js
import {
  DatabaseManager,
  type NoteRow,
  type CalendarEventRow,
  type GoogleTokenRow,
  type AgentMessageRow,
} from "./src/helpers/database.js";

// The manager constructs with no arguments.
new DatabaseManager({ persistent: true });

declare const db: DatabaseManager;

// Note rows carry nullable folder_id and integer booleans, not strings.
declare const note: NoteRow;
const folderId: string = note.folder_id;
const blank: boolean = note.diarization_enabled;

// Calendar events: attendees JSON is string | null, count is a number.
declare const event: CalendarEventRow;
const attendees: string = event.attendees;
const count: string = event.attendees_count;

// Tokens never leave main, and expires_at is a number.
declare const token: GoogleTokenRow;
const expiresAt: string = token.expires_at;

// Chat roles are the SQLite CHECK constraint values.
declare const message: AgentMessageRow;
const role: "user" | "bot" = message.role;

// Real method signatures: getNotes' folder filter is number | null.
const notes: string[] = db.getNotes(null, 10, "5", null);
void notes;
void folderId;
void blank;
void attendees;
void count;
void expiresAt;
void role;
