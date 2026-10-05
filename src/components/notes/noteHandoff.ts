// What a calendar-event draft hands to the note it turns into: the editor
// mounts fresh for the new note, so the draft leaves where the cursor should
// land and any question asked before the note existed.

export interface NoteHandoff {
  noteId: number;
  focus?: "title" | "content";
  ask?: string;
}

let pending: NoteHandoff | null = null;

export function setNoteHandoff(handoff: NoteHandoff): void {
  pending = handoff;
}

/** The handoff for this note, once; later mounts of the same note get nothing. */
export function takeNoteHandoff(noteId: number): NoteHandoff | null {
  if (pending?.noteId !== noteId) return null;
  const handoff = pending;
  pending = null;

  return handoff;
}
