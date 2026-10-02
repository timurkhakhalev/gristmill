import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../components/ui/useToast";
import type { NoteMoveTarget } from "./useNoteDragAndDrop";
import type { NoteItem } from "../contracts/notes";
import { initializeActions } from "../stores/actionStore";
import { parseTranscriptSegments } from "../utils/parseTranscriptSegments";
import { isExplicitSpeakerCount, resolveExpectedSpeakerCount } from "../utils/participants";
import { isMeetingAutoEndEligible } from "../helpers/meetingRecordingSession";
import {
  createFolder,
  getNoteFromStore,
  initializeNotes,
  loadFolders,
  revealContainer,
  setActiveContext,
  setActiveNoteId,
  useActiveContext,
  useActiveFolderId,
  useActiveNoteId,
  useFolders,
  useSpaces,
} from "../stores/noteStore";
import {
  resumeMeeting,
  startRecording as storeStartRecording,
  useMeetingRecordingStore,
} from "../stores/meetingRecordingStore";

/** Tree-level note actions shared by the app sidebar (SpacesTree) and the
 * notes view (overview empty states, editor move-to-folder). Thin wrappers
 * over the note/meeting stores so both surfaces stay in sync. */
export function useNotesTreeActions() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const spaces = useSpaces();
  const folders = useFolders();
  const activeContext = useActiveContext();
  const activeFolderId = useActiveFolderId();
  const activeNoteId = useActiveNoteId();
  const isTranscribing = useMeetingRecordingStore((s) => s.isRecording);

  const startRecordingForNote = useCallback(async (note: NoteItem | null, resume = false) => {
    if (!resume) await initializeActions();
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
    async (spaceId: number, folderId: number | null) => {
      const result = await window.electronAPI.saveNote(
        t("notes.list.untitledNote"),
        "",
        "personal",
        null,
        null,
        folderId,
        spaceId
      );
      if (result.success && result.note) {
        setActiveContext(result.note.space_id, result.note.folder_id);
        revealContainer(result.note.space_id, result.note.folder_id);
        setActiveNoteId(result.note.id);
        // A new note is a recording waiting to happen: start it unless one is already live.
        if (!isTranscribing) void startRecordingForNote(result.note);
        return result.note;
      }
      return null;
    },
    [t, isTranscribing, startRecordingForNote]
  );

  const privateSpaceId = useMemo(
    () => spaces.find((s) => s.kind === "private")?.id ?? null,
    [spaces]
  );

  const handleNewNoteInPrivate = useCallback(() => {
    if (privateSpaceId == null) return Promise.resolve(null);
    return handleNewNoteIn(privateSpaceId, null);
  }, [privateSpaceId, handleNewNoteIn]);

  const handleNewNote = useCallback(() => {
    if (activeContext) return handleNewNoteIn(activeContext.spaceId, activeContext.folderId);
    return handleNewNoteInPrivate();
  }, [activeContext, handleNewNoteIn, handleNewNoteInPrivate]);

  const handleNotesAdded = useCallback(async () => {
    if (activeFolderId) {
      await initializeNotes(null, 50, activeFolderId);
    }
    loadFolders();
  }, [activeFolderId]);

  const handleDelete = useCallback(async (id: number) => {
    await window.electronAPI.deleteNote(id);
  }, []);

  const handleMoveNote = useCallback(
    async (noteId: number, target: NoteMoveTarget) => {
      // A move takes the note out of all its folders, like moving a file.
      await window.electronAPI.updateNote(noteId, {
        folder_ids: target.folderIds ?? (target.folderId != null ? [target.folderId] : []),
        space_id: target.spaceId,
      });
      if (noteId === activeNoteId) {
        setActiveContext(target.spaceId, target.folderId);
        revealContainer(target.spaceId, target.folderId);
      }
    },
    [activeNoteId]
  );

  const handleMoveToFolder = useCallback(
    async (noteId: number, folderId: number) => {
      const folder = folders.find((f) => f.id === folderId);
      if (!folder) return;
      await handleMoveNote(noteId, { spaceId: folder.space_id, folderId });
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
          : activeContext?.spaceId === note.space_id && note.folder_id == null;
      if (!stillListed) {
        setActiveContext(note.space_id, note.folder_id);
        revealContainer(note.space_id, note.folder_id);
      }
    },
    [activeNoteId, activeContext]
  );

  const handleCreateFolderAndAdd = useCallback(
    async (noteId: number, folderName: string) => {
      const note = getNoteFromStore(noteId);
      const spaceId = note?.space_id ?? privateSpaceId;
      if (spaceId == null) return;
      const result = await createFolder(folderName, spaceId);
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
    [privateSpaceId, handleSetNoteFolders, toast, t]
  );

  const handleCreateFolderAndMove = useCallback(
    async (noteId: number, folderName: string) => {
      const spaceId = getNoteFromStore(noteId)?.space_id ?? privateSpaceId;
      if (spaceId == null) return;
      const result = await createFolder(folderName, spaceId);
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
    [privateSpaceId, handleMoveToFolder, toast, t]
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
