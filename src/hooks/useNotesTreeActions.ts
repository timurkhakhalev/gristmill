import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../components/ui/useToast";
import type { NoteMoveTarget } from "./useNoteDragAndDrop";
import type { NoteItem } from "../contracts/notes";
import { parseTranscriptSegments } from "../utils/parseTranscriptSegments";
import { isExplicitSpeakerCount, resolveExpectedSpeakerCount } from "../utils/participants";
import { isMeetingAutoEndEligible } from "../helpers/meetingRecordingSession";
import {
  createFolder,
  getNoteFromStore,
  initializeNotes,
  loadFolders,
  openNoteRow,
  revealContainer,
  runInBackground,
  setActiveContext,
  useActiveContext,
  useActiveFolderId,
  useActiveNoteId,
  useFolders,
} from "../stores/noteStore";
import {
  resumeMeeting,
  startRecording as storeStartRecording,
  useMeetingRecordingStore,
} from "../stores/meetingRecordingStore";

/** Tree-level note actions shared by the app sidebar (NotesTree) and the
 * notes view (overview empty states, editor move-to-folder). Thin wrappers
 * over the note/meeting stores so both surfaces stay in sync. */
export function useNotesTreeActions() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const folders = useFolders();
  const activeContext = useActiveContext();
  const activeFolderId = useActiveFolderId();
  const activeNoteId = useActiveNoteId();
  const isTranscribing = useMeetingRecordingStore((s) => s.isRecording);

  const startRecordingForNote = useCallback(async (note: NoteItem | null, resume = false) => {
    const seedSegments = note?.transcript ? parseTranscriptSegments(note.transcript) : [];

    const args = {
      noteId: note?.id ?? null,
      noteTitle: note?.title ?? null,
      folderId: note?.folder_id ?? null,
      seedSegments,
      diarizationEnabled: note?.diarization_enabled == null ? null : note.diarization_enabled === 1,
      expectedCount: resolveExpectedSpeakerCount(note),
      expectedCountIsExplicit: isExplicitSpeakerCount(note?.expected_speaker_count),
      autoEndEligible: isMeetingAutoEndEligible(note),
    };

    await (resume ? resumeMeeting(args) : storeStartRecording(args));
  }, []);

  const handleNewNoteIn = useCallback(
    async (folderId: number | null) => {
      const result = await window.electronAPI.saveNote(
        t("notes.list.untitledNote"),
        "",
        "personal",
        null,
        null,
        folderId
      );

      if (result.success && result.note) {
        setActiveContext(result.note.folder_id);
        revealContainer(result.note.folder_id);
        // Hold the full row in case the container is not loaded (#185).
        await openNoteRow(result.note);

        // A new note is a recording waiting to happen: start it unless one is already live.
        if (!isTranscribing) {
          runInBackground(startRecordingForNote(result.note), "Recording start failed");
        }

        return result.note;
      }

      return null;
    },
    [t, isTranscribing, startRecordingForNote]
  );

  const handleNewNote = useCallback(() => {
    return handleNewNoteIn(activeContext?.folderId ?? null);
  }, [activeContext, handleNewNoteIn]);

  const handleNotesAdded = useCallback(async () => {
    if (activeFolderId) {
      await initializeNotes(null, 50, activeFolderId);
    }

    await loadFolders();
  }, [activeFolderId]);

  const handleDelete = useCallback(async (id: number) => {
    return window.electronAPI.deleteNote(id);
  }, []);

  const handleMoveNote = useCallback(
    async (noteId: number, target: NoteMoveTarget) => {
      // A move takes the note out of all its folders, like moving a file.
      const result = await window.electronAPI.updateNote(noteId, {
        folder_ids: target.folderIds ?? (target.folderId != null ? [target.folderId] : []),
      });

      // A rejected move leaves the note where it was; do not follow it.
      if (!result.success) return;

      if (noteId === activeNoteId) {
        setActiveContext(target.folderId);
        revealContainer(target.folderId);
      }
    },
    [activeNoteId]
  );

  const handleMoveToFolder = useCallback(
    async (noteId: number, folderId: number) => {
      const folder = folders.find((f) => f.id === folderId);

      if (!folder) return;
      await handleMoveNote(noteId, { folderId });
    },
    [folders, handleMoveNote]
  );

  const handleSetNoteFolders = useCallback(
    async (noteId: number, folderIds: number[]) => {
      const result = await window.electronAPI.updateNote(noteId, { folder_ids: folderIds });

      if (!result.success || noteId !== activeNoteId) return;
      // Unticking the folder being browsed would orphan the open note; follow it.
      const note = result.note;

      const stillListed =
        activeContext?.folderId != null
          ? note.folder_ids.includes(activeContext.folderId)
          : note.folder_id == null;

      if (!stillListed) {
        setActiveContext(note.folder_id);
        revealContainer(note.folder_id);
      }
    },
    [activeNoteId, activeContext]
  );

  const handleCreateFolderAndAdd = useCallback(
    async (noteId: number, folderName: string) => {
      const note = getNoteFromStore(noteId);
      const result = await createFolder(folderName);

      if (result.success && result.folder) {
        await handleSetNoteFolders(noteId, [...(note?.folder_ids ?? []), result.folder.id]);
      } else if (result.error) {
        toast({
          title: t("notes.folders.couldNotCreate"),
          description: result.error,
          variant: "destructive",
        });
      }
    },
    [handleSetNoteFolders, toast, t]
  );

  const handleCreateFolderAndMove = useCallback(
    async (noteId: number, folderName: string) => {
      const result = await createFolder(folderName);

      if (result.success && result.folder) {
        await handleMoveToFolder(noteId, result.folder.id);
      } else if (result.error) {
        toast({
          title: t("notes.folders.couldNotCreate"),
          description: result.error,
          variant: "destructive",
        });
      }
    },
    [handleMoveToFolder, toast, t]
  );

  return {
    startRecordingForNote,
    handleNewNoteIn,
    handleNewNote,
    handleNotesAdded,
    handleDelete,
    handleMoveNote,
    handleMoveToFolder,
    handleSetNoteFolders,
    handleCreateFolderAndMove,
    handleCreateFolderAndAdd,
  };
}
