// Strict compiler probes for the typed SQLite adapter: internal row shapes
// are load-bearing at the SQL boundary, so a wrong row field or a wrong
// method dependency shape must fail compilation. The positive graph is the
// strict main tsconfig (database.ts is part of it); diagnostics below were
// verified against actual tsc output.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");
const configPath = path.join(root, "tsconfig.main.json");

function probeDiagnostics(source) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsed.options.strict, true);
  const probe = path.join(root, "database-type-probe.ts");
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...args) =>
    file === probe
      ? ts.createSourceFile(file, source, languageVersion, true)
      : readSource(file, languageVersion, ...args);
  const program = ts.createProgram([probe], { ...parsed.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  return {
    codes: diagnostics.map((d) => d.code).sort((a, b) => a - b),
    cleanup: () => {
      if (fs.existsSync(probe)) fs.rmSync(probe, { force: true });
    },
  };
}

test("wrong row usage and wrong method dependencies fail compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
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
`);
  try {
    assert.ok(codes.length > 0, "wrong usage must not compile");
    // Verified against an actual strict tsc run: 2554 (constructor args),
    // 2345 (getNotes signature), 2322 ×7 (row/field assignments).
    assert.ok(codes.includes(2554), `constructor misuse must fail, got ${codes.join(",")}`);
    assert.ok(codes.includes(2345), `method signature misuse must fail, got ${codes.join(",")}`);
    assert.ok(codes.includes(2322), `row field misuse must fail, got ${codes.join(",")}`);
    assert.equal(
      codes.filter((code) => code === 2322).length,
      7,
      `each wrong row field reports its own diagnostic, got ${codes.join(",")}`
    );
  } finally {
    cleanup();
  }
});

test("the full adapter graph compiles under strict settings", () => {
  const { codes, cleanup } = probeDiagnostics(`
import {
  DatabaseManager,
  type NoteRow,
  type FolderRow,
  type SpaceRow,
  type ActionRow,
  type TranscriptionRow,
  type AgentConversationRow,
  type AgentMessageRow,
  type ContainerConversationRow,
  type ConversationPreviewRow,
  type CalendarEventRow,
  type CalendarAccountRow,
  type ContactRow,
  type SpeakerProfileRow,
  type SpeakerMappingRow,
  type NoteSpeakerEmbeddingRow,
  type GoogleCalendarRow,
  type MicrosoftCalendarRow,
  type AppleCalendarRow,
  type GoogleTokenRow,
  type MicrosoftTokenRow,
} from "./src/helpers/database.js";
import { buildNoteSearchQuery } from "./src/helpers/noteSearch.js";
import { parseDbTimestamp, toDbTimestamp, hasExplicitTimeZone } from "./src/helpers/dbTimestamp.js";

async function useAll(): Promise<string> {
  const manager = new DatabaseManager();
  const space: SpaceRow | null = manager.getSpace(1);
  const folders: FolderRow[] = manager.getFolders(space?.id ?? null);
  const note: NoteRow | null = manager.getNote(1);
  const noteFolder: number | null = note?.folder_id ?? null;
  const notes: NoteRow[] = manager.getNotes(null, 100, noteFolder, space?.id ?? null);
  const actions: ActionRow[] = manager.getActions();
  const action = manager.createAction("n", "d", "p");
  const builtinFlag: number = action.action?.is_builtin ?? 0;
  const transcriptions: TranscriptionRow[] = manager.getTranscriptions(10);
  const stamp: Date | null = parseDbTimestamp(transcriptions[0]?.timestamp);
  const written: string | null = toDbTimestamp(stamp ?? null);
  const hasZone: boolean = hasExplicitTimeZone(written);
  const conversation: AgentConversationRow | null = manager.createAgentConversation("t", note?.id ?? null, space?.id ?? null, folders[0]?.id ?? null);
  const message: AgentMessageRow | null = manager.addAgentMessage(conversation?.id ?? 0, "user", "hi", { tool: "x" });
  const metadata: unknown = message?.metadata === null ? null : JSON.parse(message?.metadata ?? "null");
  void metadata;
  const container: ContainerConversationRow[] = manager.getConversationsForContainer(space?.id ?? 0, null, 10);
  const preview: ConversationPreviewRow[] = manager.getAgentConversationsWithPreview();
  const events: CalendarEventRow[] = manager.getUpcomingEvents(60);
  const inRange = manager.getCalendarEventsInRange("2026-09-15T00:00:00Z", "2026-09-16T00:00:00Z", ["google"]);
  const accounts: CalendarAccountRow[] = manager.getGoogleAccounts();
  const contacts: ContactRow[] = manager.searchContacts("a@b.c");
  const profiles: SpeakerProfileRow[] = manager.getSpeakerProfiles(false);
  const mappings: SpeakerMappingRow[] = manager.getSpeakerMappings(1);
  const embeddings: NoteSpeakerEmbeddingRow[] = manager.getNoteSpeakerEmbeddings(1);
  const embeddingBuffer: Buffer | undefined = embeddings[0]?.embedding;
  const gcal: GoogleCalendarRow[] = manager.getGoogleCalendars(null);
  const selected: number = gcal[0]?.is_selected ?? 0;
  const mcal: MicrosoftCalendarRow[] = manager.getSelectedMicrosoftCalendars();
  const acal: AppleCalendarRow[] = manager.getAppleCalendars();
  const tokens: GoogleTokenRow | null = manager.getGoogleTokens();
  const msTokens: MicrosoftTokenRow | null = manager.getMicrosoftTokensByEmail("a@b.c");
  const fts: NoteRow[] = manager.searchNotes(buildNoteSearchQuery("meeting"), 10, null, null);
  manager.upsertCalendarEvents([
    { id: "e1", calendar_id: "c1", start_time: "2026-09-15 10:00:00", end_time: "2026-09-15 11:00:00" },
  ]);
  manager.close();
  return [
    folders.length,
    notes.length,
    actions.length,
    builtinFlag,
    String(hasZone),
    events.length,
    inRange.length,
    accounts.length,
    container.length,
    preview.length,
    contacts.length,
    profiles.length,
    mappings.length,
    String(embeddingBuffer?.length ?? 0),
    selected,
    mcal.length,
    acal.length,
    String(tokens !== null),
    String(msTokens !== null),
    fts.length,
  ].join();
}
void useAll;
`);
  try {
    assert.deepEqual(codes, []);
  } finally {
    cleanup();
  }
});
