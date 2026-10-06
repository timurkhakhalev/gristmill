import type { NoteItem, NoteMutationResult, NoteUpdate } from "../contracts/notes.js";
import type { NoteRow } from "./database.js";
import debugLogger from "./debugLogger.js";
import { sendNoteAdded, sendNoteUpdated } from "./notesEvents.js";

// Row/result shapes mirror DatabaseManager.saveNote/updateNote: the service
// consumes the manager's typed results directly, so a wrong-shaped response
// is a TypeScript error instead of a runtime zod throw.
export interface NoteWriteDeps {
  database: {
    saveNote(
      title: string,
      content: string,
      noteType?: string,
      sourceFile?: string | null,
      audioDuration?: number | null,
      folderId?: number | null,
      spaceId?: number | null
    ): { success: boolean; note: NoteRow | null };
    updateNote(
      id: number,
      updates: NoteUpdate
    ): { success: boolean; error?: string; note?: NoteRow | null };
  };
  mirrorWrite(note: NoteItem): void;
  refreshMeetingSpeakerConfigFromNote(noteId: number, note: NoteItem): void;
}

// Owns durable edits from UI and BB. SQL, meeting artifacts and deletion keep
// their existing owners. A failed projection cannot undo a committed edit.
export class NoteWriteService {
  constructor(private readonly deps: NoteWriteDeps) {}

  saveNote(
    title: string,
    content: string,
    noteType?: string,
    sourceFile: string | null = null,
    audioDuration: number | null = null,
    folderId: number | null = null,
    spaceId: number | null = null
  ): NoteMutationResult {
    const result = this.deps.database.saveNote(
      title,
      content,
      noteType,
      sourceFile,
      audioDuration,
      folderId,
      spaceId
    );

    if (!result.success || !result.note) return { success: false, error: "Note not found" };

    this.publish(result.note, sendNoteAdded);

    return { success: true, note: result.note };
  }

  updateNote(id: number, updates: NoteUpdate): NoteMutationResult {
    const result = this.deps.database.updateNote(id, updates);

    // A false result keeps the manager's own error verbatim (contract tests
    // pin these shapes); success without a row cannot address a note.
    // A false result keeps the manager's own error verbatim (contract tests
    // pin these shapes); success without a row cannot address a note.
    if (!result.success)
      return result.error === undefined
        ? { success: false }
        : { success: false, error: result.error };

    if (!result.note) return { success: false, error: "Note not found" };

    const note = result.note;

    this.publish(note, sendNoteUpdated);

    // Participant edits refresh capture configuration. Speaker names belong
    // to processing-run corrections, not generic Note edits.
    if (updates.participants) {
      this.afterCommit("speaker configuration", id, () =>
        this.deps.refreshMeetingSpeakerConfigFromNote(id, note)
      );
    }

    return { success: true, note };
  }

  // SAFETY: notesEvents' send functions schema-parse their payload
  // (parseOrDrop) and drop invalid shapes, so NoteItem is the contract.
  private publish(note: NoteItem, send: (note: NoteItem) => void): void {
    setImmediate(() => this.afterCommit("event", note.id, () => send(note)));
    this.afterCommit("Markdown mirror", note.id, () => this.deps.mirrorWrite(note));
  }

  private afterCommit(effect: string, noteId: number, run: () => void): void {
    try {
      run();
    } catch (error) {
      debugLogger.error(
        "Note effect failed after commit",
        {
          effect,
          noteId,
          error: error instanceof Error ? error.message : String(error),
        },
        "notes"
      );
    }
  }
}
