import {
  noteMutationResultSchema,
  type NoteItem,
  type NoteMutationResult,
  type NoteUpdate,
} from "../contracts/notes.js";
import debugLogger from "./debugLogger.js";
import { sendNoteAdded, sendNoteUpdated } from "./notesEvents.js";

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
    ): unknown;
    updateNote(id: number, updates: NoteUpdate): unknown;
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
    const result = this.parseResult(
      this.deps.database.saveNote(
        title,
        content,
        noteType,
        sourceFile,
        audioDuration,
        folderId,
        spaceId
      )
    );

    if (result.success) this.publish(result.note, sendNoteAdded);

    return result;
  }

  updateNote(id: number, updates: NoteUpdate): NoteMutationResult {
    const result = this.parseResult(this.deps.database.updateNote(id, updates));

    if (!result.success) return result;
    this.publish(result.note, sendNoteUpdated);

    // Participant edits refresh capture configuration. Speaker names belong
    // to processing-run corrections, not generic Note edits.
    if (updates.participants) {
      this.afterCommit("speaker configuration", id, () =>
        this.deps.refreshMeetingSpeakerConfigFromNote(id, result.note)
      );
    }

    return result;
  }

  private parseResult(raw: unknown): NoteMutationResult {
    const result = noteMutationResultSchema.safeParse(raw);

    if (!result.success) {
      throw new Error("DatabaseManager returned an unexpected note mutation result");
    }

    return result.data;
  }

  private publish(note: NoteItem, send: (note: unknown) => void): void {
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
