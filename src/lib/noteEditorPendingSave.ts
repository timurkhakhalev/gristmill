export interface NoteEditorDraft {
  readonly noteId: number;
  readonly title: string;
  readonly content: string;
  readonly enhancedContent: string | null;
  /** The user typed in this field since the last accepted external value. */
  readonly dirtyTitle?: boolean;
  readonly dirtyContent?: boolean;
}

export type NoteDraftMutation =
  | { sourceNoteId: number; field: "title" | "content"; value: string }
  | { sourceNoteId: number; field: "enhancedContent"; value: string | null };

export interface PendingDocumentSnapshot {
  readonly noteId: number;
  title?: string;
  content?: string;
}

export interface PendingEnhancedSnapshot {
  readonly noteId: number;
  readonly enhancedContent: string | null;
}

export type PendingNoteUpdates = {
  readonly title?: string;
  readonly content?: string;
  readonly enhanced_content?: string | null;
};

export interface PendingNoteWrite {
  readonly noteId: number;
  readonly updates: PendingNoteUpdates;
}

interface NoteDraftSource {
  readonly id: number;
  readonly title: string;
  readonly content: string;
  readonly enhanced_content?: string | null;
}

export interface NoteTransitionPlan {
  readonly writes: PendingNoteWrite[];
  readonly nextDraft: NoteEditorDraft | null;
}

export function shouldCancelPendingSavesForDelete(
  activeNoteId: number | null,
  deletedNoteId: number
): boolean {
  return activeNoteId === deletedNoteId;
}

export function applyNoteDraftMutation(
  draft: NoteEditorDraft | null,
  mutation: NoteDraftMutation
): NoteEditorDraft | null {
  if (!draft || mutation.sourceNoteId !== draft.noteId) return null;

  if (mutation.field === "enhancedContent") {
    return { ...draft, enhancedContent: mutation.value };
  }

  return {
    ...draft,
    [mutation.field]: mutation.value,
    ...(mutation.field === "title" ? { dirtyTitle: true } : { dirtyContent: true }),
  };
}

// An external update (chat tool, processing) meets the user's dirty fields:
// a field the user typed keeps the local value and stays dirty (its pending
// save will land); untouched fields accept the external value, so autosave
// never republishes stale text over fresher data (#157). The dropped dirty
// flags tell the caller an in-flight snapshot of that field may still carry
// stale text and should be resaved after the pending write lands.
export function acceptExternalNoteUpdate(
  draft: NoteEditorDraft,
  external: { title?: string; content?: string }
): { draft: NoteEditorDraft; droppedDirty: { title: boolean; content: boolean } } {
  const next = { ...draft };
  const droppedDirty = { title: false, content: false };

  if (external.title !== undefined) {
    if (draft.dirtyTitle) {
      droppedDirty.title = true;
    } else {
      next.title = external.title;
      next.dirtyTitle = false;
    }
  }

  if (external.content !== undefined) {
    if (draft.dirtyContent) {
      droppedDirty.content = true;
    } else {
      next.content = external.content;
      next.dirtyContent = false;
    }
  }

  return { draft: next, droppedDirty };
}

// Trims a pending snapshot to the fields the user actually edited, so a
// debounced write never republishes fields it did not capture — an external
// update to those fields must survive the autosave (#157).
export function collectPendingNoteWrites(
  document: PendingDocumentSnapshot | null,
  enhanced: PendingEnhancedSnapshot | null
): PendingNoteWrite[] {
  const writes: PendingNoteWrite[] = [];

  if (document) {
    const updates: { title?: string; content?: string; enhanced_content?: string | null } = {};

    if (document.title !== undefined) updates.title = document.title;

    if (document.content !== undefined) updates.content = document.content;

    if (enhanced && enhanced.noteId === document.noteId) {
      updates.enhanced_content = enhanced.enhancedContent;
    }

    writes.push({ noteId: document.noteId, updates });

    if (enhanced && enhanced.noteId !== document.noteId) {
      writes.push({
        noteId: enhanced.noteId,
        updates: { enhanced_content: enhanced.enhancedContent },
      });
    }
  } else if (enhanced) {
    writes.push({
      noteId: enhanced.noteId,
      updates: { enhanced_content: enhanced.enhancedContent },
    });
  }

  return writes;
}

export function planNoteTransition(
  nextNote: NoteDraftSource | null,
  document: PendingDocumentSnapshot | null,
  enhanced: PendingEnhancedSnapshot | null
): NoteTransitionPlan {
  return {
    writes: collectPendingNoteWrites(document, enhanced),
    nextDraft: nextNote
      ? {
          noteId: nextNote.id,
          title: nextNote.title,
          content: nextNote.content,
          enhancedContent: nextNote.enhanced_content ?? null,
        }
      : null,
  };
}

export type EventDraftHandoffMode = "replace" | "append";

// What a calendar-event draft hands to the note owner that replaces it: the
// full latest draft, read after every await, applied by the editor's own
// pending-save pipeline. "replace" is for a note the create call just made
// (its content already carries the early snapshot); "append" is for a note
// that already existed, where the typed text must not clobber the manual
// content the note picked up elsewhere.
export interface EventDraftHandoff {
  noteId: number;
  note: NoteDraftSource;
  mode: EventDraftHandoffMode;
  draft: { title?: string; content?: string };
}

export function applyEventDraftHandoff(
  draft: NoteEditorDraft,
  handoff: EventDraftHandoff
): NoteEditorDraft {
  const pending = handoff.draft;

  const content =
    pending.content === undefined
      ? draft.content
      : handoff.mode === "append" && draft.content
        ? `${draft.content}\n\n${pending.content}`
        : pending.content;

  // A typed draft title is the user's deliberate input and wins even over an
  // existing note's title; an untouched field leaves the note's value alone.
  const title = pending.title === undefined ? draft.title : pending.title;

  if (title === draft.title && content === draft.content) return draft;

  return {
    ...draft,
    title,
    content,
    // The handoff is the user's input even though the editor never saw the
    // keystroke: the changed fields must be persisted by the next save.
    ...(title !== draft.title ? { dirtyTitle: true } : {}),
    ...(content !== draft.content ? { dirtyContent: true } : {}),
  };
}
