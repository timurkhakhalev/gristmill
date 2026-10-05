import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Plus } from "../icons";
import NoteEditor from "./NoteEditor";
import NoteSkeleton from "./NoteSkeleton";
import { CONTENT_ENTER_CLASS } from "../ui/Skeleton";
import { cn } from "../lib/utils";
import AddNotesToFolderDialog from "./AddNotesToFolderDialog";
import type { NoteItem } from "../../contracts/notes";
import logger from "../../utils/logger";
import { parseTranscriptSegments } from "../../utils/parseTranscriptSegments";
import { isExplicitSpeakerCount, resolveExpectedSpeakerCount } from "../../utils/participants";
import type { CalendarEvent } from "../../contracts/calendar";
import {
  useNotes,
  useFolders,
  useActiveNote,
  useActiveNoteId,
  useActiveFolderId,
  initializeNotesTree,
  setActiveNoteId,
  getNoteFromStore,
  retainNoteEditorUpdates,
  flushNoteEditorWrites,
  useNoteEditorSave,
  getNoteEditorUpdates,
} from "../../stores/noteStore";
import {
  useMeetingRecordingStore,
  startRecording as storeStartRecording,
  pauseMeeting,
  finishMeeting,
  lockSpeaker,
  setSessionDiarizationEnabled,
  setSessionExpectedCount,
} from "../../stores/meetingRecordingStore";
import { useNotesOnboarding } from "../../hooks/useNotesOnboarding";
import { useNotesTreeActions } from "../../hooks/useNotesTreeActions";
import NotesOnboarding from "./NotesOnboarding";
import { defaultFolderDisplayName, notesEmptyTitleKey } from "./shared";
import { isMeetingAutoEndEligible } from "../../helpers/meetingRecordingSession";
import { handleMeetingRecordingRequest } from "../../helpers/meetingRecordingRequest";
import {
  acceptExternalNoteUpdate,
  applyNoteDraftMutation,
  applyEventDraftHandoff,
  planNoteTransition,
  type EventDraftHandoff,
  type NoteEditorDraft,
  type PendingDocumentSnapshot,
  type PendingEnhancedSnapshot,
} from "../../lib/noteEditorPendingSave";

function makeContentHash(content: string): string {
  return String(content.length) + "-" + content.slice(0, 50);
}

interface PendingDocumentSave extends PendingDocumentSnapshot {
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingEnhancedSave extends PendingEnhancedSnapshot {
  readonly timer: ReturnType<typeof setTimeout>;
}

type PendingSaveReason = "switch" | "overview" | "unmount";

interface PersonalNotesViewProps {
  onOpenSettings?: (section: string) => void;
  meetingRecordingRequest?: {
    noteId: number;
    folderId: number | null;
    event: any;
  } | null;
  onMeetingRecordingRequestHandled?: () => void;
  /** Top bar already shows Back when the window is a narrow note surface. */
  chromeProvidesBack?: boolean;
  /** A calendar-event draft's latest typed revision, consumed once on mount. */
  eventDraftHandoff?: React.MutableRefObject<EventDraftHandoff | null>;
}

export default function PersonalNotesView({
  onOpenSettings,
  meetingRecordingRequest,
  onMeetingRecordingRequestHandled,
  chromeProvidesBack = false,
  eventDraftHandoff,
}: PersonalNotesViewProps) {
  const { t } = useTranslation();
  const notes = useNotes();
  const activeNoteId = useActiveNoteId();
  const activeFolderId = useActiveFolderId();
  const editorSave = useNoteEditorSave(activeNoteId);
  const isSaving = editorSave?.saving ?? false;
  const [draft, setDraftState] = useState<NoteEditorDraft | null>(null);
  const draftRef = useRef<NoteEditorDraft | null>(null);
  const [showAddNotesDialog, setShowAddNotesDialog] = useState(false);
  const pendingDocumentRef = useRef<PendingDocumentSave | null>(null);
  const pendingEnhancedRef = useRef<PendingEnhancedSave | null>(null);

  const commitDraft = useCallback((next: NoteEditorDraft | null) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);

  const flushPendingSaves = useCallback((_reason: PendingSaveReason) => {
    for (const ref of [pendingDocumentRef, pendingEnhancedRef]) {
      const pending = ref.current;
      if (pending) {
        clearTimeout(pending.timer);
        ref.current = null;
        void flushNoteEditorWrites(pending.noteId);
      }
    }
  }, []);

  const transitionToNote = useCallback((nextNote: NoteItem | null, reason: "switch" | "overview") => {
    flushPendingSaves(reason);
    const nextDraft = planNoteTransition(nextNote, null, null).nextDraft;
    if (nextDraft && nextNote) {
      const retained = getNoteEditorUpdates(nextNote.id);
      commitDraft({ ...nextDraft,
        title: retained.title ?? nextDraft.title,
        content: retained.content ?? nextDraft.content,
        enhancedContent: retained.enhanced_content !== undefined ? retained.enhanced_content : nextDraft.enhancedContent,
        dirtyTitle: retained.title !== undefined,
        dirtyContent: retained.content !== undefined,
      });
    } else commitDraft(null);
  }, [commitDraft, flushPendingSaves]);
  const { isComplete: isOnboardingComplete, complete: completeOnboarding } = useNotesOnboarding();
  const {
    startRecordingForNote,
    handleNewNoteIn,
    handleNewNote,
    handleNotesAdded,
    handleMoveNote,
    handleSetNoteFolders,
    handleCreateFolderAndAdd,
  } = useNotesTreeActions();

  const isTranscribing = useMeetingRecordingStore((s) => s.isRecording);
  const diarizationSessionId = useMeetingRecordingStore((s) => s.diarizationSessionId);
  const recordingNoteId = useMeetingRecordingStore((s) => s.recordingNoteId);
  const sessionDiarizationEnabled = useMeetingRecordingStore((s) => s.sessionDiarizationEnabled);
  const sessionExpectedCount = useMeetingRecordingStore((s) => s.sessionExpectedCount);
  const userTouchedStepper = useMeetingRecordingStore((s) => s.userTouchedStepper);
  const meetingRecordingAllowed = true;
  const folders = useFolders();

  useEffect(() => {
    initializeNotesTree();
  }, []);

  const activeNote = useActiveNote();

  // Derive folder name and calendar event name for the metadata chips
  const activeFolderName = useMemo(() => {
    if (!activeNote?.folder_id) return null;
    const folder = folders.find((f) => f.id === activeNote.folder_id);
    return folder ? defaultFolderDisplayName(folder, t) : null;
  }, [activeNote?.folder_id, folders, t]);

  // The editor's move-to-folder chip only offers folders in the note's own
  // space; cross-space moves change the audience and need an explicit confirm.
  const editorFolders = useMemo(
    () => (activeNote ? folders.filter((f) => f.space_id === activeNote.space_id) : folders),
    [activeNote, folders]
  );

  const [calendarEvent, setCalendarEvent] = useState<CalendarEvent | null>(null);
  useEffect(() => {
    if (!activeNote?.calendar_event_id) {
      setCalendarEvent(null);
      return;
    }
    window.electronAPI.gcalGetEvent(activeNote.calendar_event_id).then((result) => {
      setCalendarEvent(result?.success ? result.event : null);
    });
  }, [activeNote?.calendar_event_id]);

  const calendarEventName = calendarEvent?.summary ?? null;

  const startRecording = useCallback(
    () => startRecordingForNote(activeNote ?? null),
    [activeNote, startRecordingForNote]
  );

  const stopRecording = useCallback(async () => {
    await finishMeeting();
  }, []);

  useEffect(() => {
    const currentDraft = draftRef.current;

    if (!activeNote) {
      // Space/folder activation shows its overview by clearing activeNoteId.
      if (currentDraft || pendingDocumentRef.current || pendingEnhancedRef.current) {
        transitionToNote(null, "overview");
      }
      return;
    }

    if (!currentDraft || activeNote.id !== currentDraft.noteId) {
      // Captured writes retain the old owner while the complete next draft is
      // installed atomically.
      transitionToNote(activeNote, "switch");
      return;
    }

    // External update (e.g. AI chat tool), even while a save is queued: the
    // queued write is field-scoped, so fields the user never typed accept the
    // external value and dirty user fields keep the local value for their
    // pending save (#157).
    const retained = getNoteEditorUpdates(activeNote.id);
    const { draft: merged } = acceptExternalNoteUpdate({ ...currentDraft,
      title: retained.title ?? currentDraft.title,
      content: retained.content ?? currentDraft.content,
      dirtyTitle: retained.title !== undefined,
      dirtyContent: retained.content !== undefined,
    }, {
      title: activeNote.title,
      content: activeNote.content,
    });
    commitDraft({ ...merged,
      enhancedContent: retained.enhanced_content !== undefined
        ? retained.enhanced_content
        : (activeNote.enhanced_content ?? null),
    });
  }, [activeNote, editorSave, commitDraft, transitionToNote]);

  const scheduleDocumentSave = useCallback((snapshot: NoteEditorDraft) => {
    // Only the fields the user edited are captured: a debounced write must
    // not republish fields an external update (chat tool, processing) just
    // changed under us (#157). Nothing dirty means nothing to write — leave
    // any queued write intact instead of cancelling it.
    if (!snapshot.dirtyTitle && !snapshot.dirtyContent) return;
    const current = pendingDocumentRef.current;
    if (current) clearTimeout(current.timer);

    const pending: PendingDocumentSave = {
      noteId: snapshot.noteId,
      title: snapshot.dirtyTitle ? snapshot.title : undefined,
      content: snapshot.dirtyContent ? snapshot.content : undefined,
      timer: setTimeout(() => {
        if (pendingDocumentRef.current !== pending) return;
        pendingDocumentRef.current = null;
        void flushNoteEditorWrites(pending.noteId);
      }, 1000),
    };
    retainNoteEditorUpdates(pending.noteId, {
      ...(pending.title !== undefined ? { title: pending.title } : {}),
      ...(pending.content !== undefined ? { content: pending.content } : {}),
    });
    pendingDocumentRef.current = pending;
  }, []);

  const scheduleEnhancedSave = useCallback((snapshot: NoteEditorDraft) => {
    const current = pendingEnhancedRef.current;
    if (current) clearTimeout(current.timer);

    const pending: PendingEnhancedSave = {
      noteId: snapshot.noteId,
      enhancedContent: snapshot.enhancedContent,
      timer: setTimeout(() => {
        if (pendingEnhancedRef.current !== pending) return;
        pendingEnhancedRef.current = null;
        void flushNoteEditorWrites(pending.noteId);
      }, 1000),
    };
    retainNoteEditorUpdates(pending.noteId, { enhanced_content: pending.enhancedContent });
    pendingEnhancedRef.current = pending;
  }, []);

  const handleTitleChange = useCallback(
    (sourceNoteId: number, title: string) => {
      const next = applyNoteDraftMutation(draftRef.current, {
        sourceNoteId,
        field: "title",
        value: title,
      });
      if (!next) return;
      commitDraft(next);
      scheduleDocumentSave(next);
    },
    [commitDraft, scheduleDocumentSave]
  );

  const handleContentChange = useCallback(
    (sourceNoteId: number, content: string) => {
      const next = applyNoteDraftMutation(draftRef.current, {
        sourceNoteId,
        field: "content",
        value: content,
      });
      if (!next) return;
      commitDraft(next);
      scheduleDocumentSave(next);
    },
    [commitDraft, scheduleDocumentSave]
  );

  const handleEnhancedContentChange = useCallback(
    (sourceNoteId: number, content: string) => {
      const next = applyNoteDraftMutation(draftRef.current, {
        sourceNoteId,
        field: "enhancedContent",
        value: content,
      });
      if (!next) return;
      commitDraft(next);
      scheduleEnhancedSave(next);
    },
    [commitDraft, scheduleEnhancedSave]
  );

  // Materialization carries its saved row through lazy mount. If navigation
  // already selected another Note, persist the handoff under its own owner
  // without replacing that editor or cancelling its pending timer.
  const handleEventDraftHandoff = useCallback((handoff: EventDraftHandoff) => {
    void (async () => {
      const cached = getNoteFromStore(handoff.noteId);
      const fetched = !cached && handoff.mode === "append"
        ? await window.electronAPI.getNote(handoff.noteId)
        : handoff.note;
      if (!fetched) return; // A deleted Note must not be recreated.
      const stored = getNoteFromStore(handoff.noteId) ?? fetched;
      const retained = getNoteEditorUpdates(handoff.noteId);
      const current = draftRef.current?.noteId === handoff.noteId
        ? draftRef.current
        : { noteId: handoff.noteId, title: retained.title ?? stored.title,
            content: retained.content ?? stored.content, enhancedContent: stored.enhanced_content ?? null };
      const merged = applyEventDraftHandoff(current, handoff);
      if (!merged.dirtyTitle && !merged.dirtyContent) return;
      if (draftRef.current?.noteId === handoff.noteId) {
        commitDraft(merged);
        scheduleDocumentSave(merged);
      } else {
        retainNoteEditorUpdates(handoff.noteId, {
          ...(merged.dirtyTitle ? { title: merged.title } : {}),
          ...(merged.dirtyContent ? { content: merged.content } : {}),
        });
        void flushNoteEditorWrites(handoff.noteId);
      }
    })().catch(error => {
      // Keep the handoff for the next editor mount if its merge-base read fails.
      if (eventDraftHandoff && !eventDraftHandoff.current) eventDraftHandoff.current = handoff;
      logger.warn("Failed to prepare event draft handoff", { error: (error as Error).message }, "notes");
    });
  }, [commitDraft, eventDraftHandoff, scheduleDocumentSave]);
  // The pending handoff arrives before this view mounts (ControlPanel holds
  // it in a ref while the note is created): drain it once on mount. One-shot
  // by design — only the mount-time handoff exists.
  useEffect(() => {
    const pending = eventDraftHandoff?.current;
    if (!pending) return;
    eventDraftHandoff.current = null;
    handleEventDraftHandoff(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot mount drain
  }, []);

  useEffect(() => {
    return () => { draftRef.current = null; flushPendingSaves("unmount"); };
  }, [flushPendingSaves]);

  // Boolean flag so actions enable during recording without re-rendering on every transcript update.
  const hasLiveTranscript = useMeetingRecordingStore(
    (s) => s.recordingNoteId === activeNote?.id && !!s.transcript
  );
  const activeNoteRawTranscript = activeNote?.transcript || "";
  const activeDraft = draft?.noteId === activeNote?.id ? draft : null;
  // A note that arrives after its skeleton fades in; an instantly available one does not.
  const [skeletonNoteId, setSkeletonNoteId] = useState<number | null>(null);
  const showNoteSkeleton = activeNoteId != null && !activeNote;
  useEffect(() => {
    if (showNoteSkeleton) setSkeletonNoteId(activeNoteId);
  }, [showNoteSkeleton, activeNoteId]);
  const enterFromSkeleton = activeNote != null && activeNote.id === skeletonNoteId;
  const editorNote = activeNote
    ? {
        ...activeNote,
        title: activeDraft ? activeDraft.title : activeNote.title,
        content: activeDraft ? activeDraft.content : activeNote.content,
        enhanced_content: activeDraft
          ? activeDraft.enhancedContent
          : (activeNote.enhanced_content ?? null),
      }
    : null;
  const editorEnhancedContent = editorNote?.enhanced_content ?? null;

  const isEnhancementStale = useMemo(() => {
    if (!editorEnhancedContent || !activeNote?.enhanced_at_content_hash) return false;
    const currentHash = makeContentHash(`${editorNote?.content ?? ""}\n${activeNoteRawTranscript}`);
    return currentHash !== activeNote.enhanced_at_content_hash;
  }, [
    activeNote?.enhanced_at_content_hash,
    activeNoteRawTranscript,
    editorEnhancedContent,
    editorNote?.content,
  ]);

  useEffect(() => {
    if (!meetingRecordingRequest || activeNoteId !== meetingRecordingRequest.noteId) return;
    const note = activeNote?.id === meetingRecordingRequest.noteId ? activeNote : null;
    const seedSegments = note?.transcript ? parseTranscriptSegments(note.transcript) : [];
    void handleMeetingRecordingRequest({
      args: {
        noteId: meetingRecordingRequest.noteId,
        noteTitle: note?.title ?? null,
        folderId: note?.folder_id ?? meetingRecordingRequest.folderId ?? null,
        seedSegments,
        diarizationEnabled:
          note?.diarization_enabled == null ? null : note.diarization_enabled === 1,
        expectedCount: resolveExpectedSpeakerCount(note),
        expectedCountIsExplicit: isExplicitSpeakerCount(note?.expected_speaker_count),
        // Requests come from meeting detection, so a note that hasn't loaded
        // yet is still a meeting note.
        autoEndEligible: note ? isMeetingAutoEndEligible(note) : true,
      },
      startRecording: storeStartRecording,
      restoreFromMeetingMode: async () => {
        await window.electronAPI?.restoreFromMeetingMode?.();
      },
      onHandled: () => onMeetingRecordingRequestHandled?.(),
    }).catch((error) => {
      logger.warn(
        "Failed to handle automatic meeting recording request",
        { error: (error as Error).message },
        "meeting"
      );
    });
  }, [meetingRecordingRequest, activeNoteId, activeNote, onMeetingRecordingRequestHandled]);

  // Final and periodic transcript persistence live in MeetingRecordingMount /
  // the store — this view can be unmounted when an auto-end stop fires.
  const isActiveNoteRecording = isTranscribing && recordingNoteId === activeNote?.id;

  if (!isOnboardingComplete) {
    return <NotesOnboarding onComplete={completeOnboarding} />;
  }

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {editorNote ? (
          <div
            key={editorNote.id}
            className={cn("flex min-h-0 flex-1 flex-col", enterFromSkeleton && CONTENT_ENTER_CLASS)}
          >
            {editorSave?.error && (
              <div role="alert" className="flex items-center gap-3 px-4 py-2 text-sm text-danger">
                <span>{t("notes.editor.saveFailed")}</span>
                <button type="button" disabled={isSaving} onClick={() => { void flushNoteEditorWrites(editorNote.id); }}>
                  {t("common.retry")}
                </button>
              </div>
            )}
            <NoteEditor
              key={editorNote.id}
              note={editorNote}
              onTitleChange={handleTitleChange}
              onBackToNotes={chromeProvidesBack ? undefined : () => setActiveNoteId(null)}
              onContentChange={handleContentChange}
              isSaving={isSaving}
              isRecording={isActiveNoteRecording}
              isProcessing={false}
              recordingAllowed={meetingRecordingAllowed}
              onStartRecording={startRecording}
              onStopRecording={stopRecording}
              onPauseRecording={() => { void pauseMeeting(); }}
              onResumeRecording={() => { void startRecordingForNote(activeNote ?? null, true); }}
              enhancement={
                editorEnhancedContent
                  ? {
                      content: editorEnhancedContent,
                      isStale: isEnhancementStale,
                      onChange: handleEnhancedContentChange,
                    }
                  : undefined
              }
              diarizationSessionId={diarizationSessionId}
              onLiveSpeakerLock={lockSpeaker}
              sessionDiarizationEnabled={sessionDiarizationEnabled}
              sessionExpectedCount={sessionExpectedCount}
              userTouchedStepper={userTouchedStepper}
              onSetSessionDiarizationEnabled={setSessionDiarizationEnabled}
              onSetSessionExpectedCount={setSessionExpectedCount}
              folderName={activeFolderName}
              calendarEvent={calendarEvent}
              folders={editorFolders}
              onSetFolders={handleSetNoteFolders}
              onCreateFolderAndAdd={handleCreateFolderAndAdd}
            />
          </div>
        ) : showNoteSkeleton ? (
          // The note's container is still loading into the store.
          <NoteSkeleton />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center -mt-6">
            <svg
              className="text-foreground dark:text-white mb-5"
              width="72"
              height="64"
              viewBox="0 0 72 64"
              fill="none"
            >
              <rect
                x="22"
                y="2"
                width="32"
                height="42"
                rx="3"
                transform="rotate(6 38 23)"
                fill="currentColor"
                fillOpacity={0.025}
                stroke="currentColor"
                strokeOpacity={0.06}
              />
              <rect
                x="18"
                y="5"
                width="32"
                height="42"
                rx="3"
                transform="rotate(3 34 26)"
                fill="currentColor"
                fillOpacity={0.04}
                stroke="currentColor"
                strokeOpacity={0.08}
              />
              <rect
                x="14"
                y="8"
                width="32"
                height="42"
                rx="3"
                fill="currentColor"
                fillOpacity={0.05}
                stroke="currentColor"
                strokeOpacity={0.1}
              />
              <rect
                x="20"
                y="16"
                width="16"
                height="2"
                rx="1"
                fill="currentColor"
                fillOpacity={0.08}
              />
              <rect
                x="20"
                y="21"
                width="20"
                height="2"
                rx="1"
                fill="currentColor"
                fillOpacity={0.06}
              />
              <rect
                x="20"
                y="26"
                width="12"
                height="2"
                rx="1"
                fill="currentColor"
                fillOpacity={0.05}
              />
              <rect
                x="20"
                y="31"
                width="18"
                height="2"
                rx="1"
                fill="currentColor"
                fillOpacity={0.04}
              />
              <circle
                cx="54"
                cy="50"
                r="5"
                fill="currentColor"
                fillOpacity={0.03}
                stroke="currentColor"
                strokeOpacity={0.06}
              />
              <path
                d="M51.5 50L53 51.5L56.5 48"
                stroke="currentColor"
                strokeOpacity={0.12}
                strokeWidth={1.2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {notes.length === 0 ? (
              <>
                <h3 className="text-xs font-semibold text-muted mb-1">
                  {t(notesEmptyTitleKey(activeFolderId != null))}
                </h3>
                <p className="text-xs text-muted text-center max-w-55 mb-4">
                  {t("notes.empty.description")}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleNewNote}
                    className="flex items-center gap-1.5 px-4 h-7 rounded-md bg-primary/8 dark:bg-primary/10 border border-primary/12 dark:border-primary/15 text-xs font-medium text-primary/70 hover:bg-primary/12 hover:text-primary hover:border-primary/20 transition-colors"
                  >
                    <Plus size={11} />
                    {t("notes.empty.createNote")}
                  </button>
                  {/* AddNotesToFolderDialog only mounts for folder contexts —
                      space-root empty states offer just "Create note". */}
                  {activeFolderId != null && (
                    <button
                      onClick={() => setShowAddNotesDialog(true)}
                      className="flex items-center gap-1.5 px-4 h-7 rounded-md border border-foreground/8 dark:border-white/10 text-xs text-muted hover:text-muted hover:border-foreground/15 hover:bg-default dark:hover:bg-white/3 transition-colors"
                    >
                      {t("notes.addToFolder.addExisting")}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <h3 className="text-xs font-semibold text-muted mb-1">
                  {t("notes.empty.selectTitle")}
                </h3>
                <p className="text-xs text-muted text-center max-w-50">
                  {t("notes.empty.selectDescription")}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {activeFolderId && (
        <AddNotesToFolderDialog
          open={showAddNotesDialog}
          onOpenChange={setShowAddNotesDialog}
          targetFolderId={activeFolderId}
          onNotesAdded={handleNotesAdded}
        />
      )}

    </div>
  );
}
