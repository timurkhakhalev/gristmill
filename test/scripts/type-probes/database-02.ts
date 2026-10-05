// @probe-name "the full adapter graph compiles under strict settings"
// @probe-codes []
// @probe-origin test/scripts/databaseTypeProbe.test.js
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
  const conversation: AgentConversationRow | null = manager.createAgentConversation(
    "t",
    note?.id ?? null,
    space?.id ?? null,
    folders[0]?.id ?? null
  );
  const message: AgentMessageRow | null = manager.addAgentMessage(
    conversation?.id ?? 0,
    "user",
    "hi",
    { tool: "x" }
  );
  const metadata: unknown =
    message?.metadata === null ? null : JSON.parse(message?.metadata ?? "null");
  void metadata;
  const container: ContainerConversationRow[] = manager.getConversationsForContainer(
    space?.id ?? 0,
    null,
    10
  );
  const preview: ConversationPreviewRow[] = manager.getAgentConversationsWithPreview();
  const events: CalendarEventRow[] = manager.getUpcomingEvents(60);
  const inRange = manager.getCalendarEventsInRange("2026-09-15T00:00:00Z", "2026-09-16T00:00:00Z", [
    "google",
  ]);
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
    {
      id: "e1",
      calendar_id: "c1",
      start_time: "2026-09-15 10:00:00",
      end_time: "2026-09-15 11:00:00",
    },
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
