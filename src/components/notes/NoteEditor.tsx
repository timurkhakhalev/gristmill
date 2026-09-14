import { useState, useRef, useEffect, useMemo, useCallback, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { useUiLocale } from "../../hooks/useUiLocale";
import {
  Loader2,
  FileText,
  Sparkles,
  AlignLeft,
  MessageSquareText,
  Mic,
  LinkIcon,
  FolderOpen,
  Search,
  Plus,
  Check,
} from "../icons";
import { RichTextEditor } from "../ui/RichTextEditor";
import type { Editor } from "@tiptap/react";
import { MeetingTranscriptChat, SelectionBar } from "./MeetingTranscriptChat";
import {
  useMeetingRecordingStore,
  type TranscriptSegment,
} from "../../stores/meetingRecordingStore";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu";
import { cn } from "../lib/utils";
import type { FolderItem } from "../../types/electron";
import type { NoteItem } from "../../contracts/notes";
import type { ActionProcessingState } from "../../hooks/useActionProcessing";
import ActionProcessingOverlay from "./ActionProcessingOverlay";
import NoteBottomBar from "./NoteBottomBar";
import NoteRecordControl, { RecordingWave } from "./NoteRecordControl";
import EmptyStateCard from "../ui/EmptyStateCard";
import { Button } from "../ui/button";
import EmbeddedChat, { type EmbeddedChatMode } from "./EmbeddedChat";
import { useEmbeddedChat } from "../../hooks/useEmbeddedChat";
import { formatNoteDate, formatShortDate } from "../../utils/dateFormatting";
import { collectKnownPeople } from "../../utils/llmTranscript";
import { parseTranscriptSegments } from "../../utils/parseTranscriptSegments";
import {
  applyTranscriptSpeakerPatch,
  lockTranscriptSpeaker,
  serializeTranscriptSegments,
} from "../../utils/transcriptSpeakerState";
import NoteParticipants from "./NoteParticipants";
import type { CalendarAttendee } from "../../types/calendar";
import { observeFloatingChatLayout } from "./floatingChatLayout";
import { NOTE_META_CHIP_CLASS, defaultFolderDisplayName, folderMatchesQuery } from "./shared";

const SEGMENT_BUTTON_CLASS =
  "relative z-1 flex h-[26px] items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors duration-150";

const TRANSCRIPT_EXPORT_LABEL_KEYS = {
  txt: "notes.editor.asTranscriptText",
  srt: "notes.editor.asSubtitles",
  md: "notes.editor.asTranscriptMarkdown",
  json: "notes.editor.asJson",
} as const;
const NOTE_EXPORT_LABEL_KEYS = {
  md: "notes.editor.asMarkdown",
  txt: "notes.editor.asPlainText",
} as const;

export interface Enhancement {
  content: string;
  isStale: boolean;
  onChange: (sourceNoteId: number, content: string) => void;
}

type MeetingViewMode = "raw" | "transcript" | "enhanced";

type SpeakerProfileOption = { id?: number; display_name: string; email: string | null };

interface NoteExportOption {
  id: string;
  label: string;
  onSelect: () => void;
}

function buildKnownSpeakers(
  profiles: SpeakerProfileOption[],
  segments: TranscriptSegment[],
  mappings: Record<string, string>
): SpeakerProfileOption[] {
  const seen = new Set<string>();
  const list: SpeakerProfileOption[] = [];
  for (const p of profiles) {
    const key = p.display_name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(p);
  }
  for (const segment of segments) {
    if (!segment.speaker) continue;
    const name = mappings[segment.speaker] || segment.speakerName;
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ display_name: name, email: null });
  }
  return list;
}

type LiveMeetingTranscriptChatProps = Omit<
  ComponentProps<typeof MeetingTranscriptChat>,
  | "segments"
  | "micPartial"
  | "systemPartial"
  | "systemPartialSpeakerId"
  | "systemPartialSpeakerName"
  | "isRecording"
>;

// Subscribes to live transcript state at this leaf so per-update re-renders
// don't reach the editor/chat (which would drop text selection).
function LiveMeetingTranscriptChat({
  speakerProfiles,
  speakerMappings,
  ...props
}: LiveMeetingTranscriptChatProps) {
  const segments = useMeetingRecordingStore((s) => s.segments);
  const micPartial = useMeetingRecordingStore((s) => s.micPartial);
  const systemPartial = useMeetingRecordingStore((s) => s.systemPartial);
  const systemPartialSpeakerId = useMeetingRecordingStore((s) => s.systemPartialSpeakerId);
  const systemPartialSpeakerName = useMeetingRecordingStore((s) => s.systemPartialSpeakerName);

  const knownSpeakers = useMemo(
    () => buildKnownSpeakers(speakerProfiles ?? [], segments, speakerMappings ?? {}),
    [segments, speakerMappings, speakerProfiles]
  );

  return (
    <MeetingTranscriptChat
      {...props}
      isRecording
      segments={segments}
      micPartial={micPartial}
      systemPartial={systemPartial}
      systemPartialSpeakerId={systemPartialSpeakerId}
      systemPartialSpeakerName={systemPartialSpeakerName}
      speakerMappings={speakerMappings}
      speakerProfiles={knownSpeakers}
    />
  );
}

interface NoteEditorProps {
  note: NoteItem;
  onTitleChange: (sourceNoteId: number, title: string) => void;
  onContentChange: (sourceNoteId: number, content: string) => void;
  isSaving: boolean;
  isRecording: boolean;
  isProcessing: boolean;
  recordingAllowed?: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onExportNote?: (format: "md" | "txt") => void;
  onExportTranscript?: (format: "txt" | "srt" | "json" | "md") => void;
  enhancement?: Enhancement;
  actionPicker?: React.ReactNode;
  /** Runs the built-in Generate Notes action; enables the post-recording summary pill. */
  onGenerateSummary?: () => void;
  actionProcessingState?: ActionProcessingState;
  actionName?: string | null;
  diarizationSessionId?: string | null;
  onLiveSpeakerLock?: (speakerId: string, displayName: string) => void;
  sessionDiarizationEnabled?: boolean;
  sessionExpectedCount?: number;
  userTouchedStepper?: boolean;
  onSetSessionDiarizationEnabled?: (enabled: boolean) => void;
  onSetSessionExpectedCount?: (count: number) => void;
  folderName?: string | null;
  calendarEventName?: string | null;
  folders?: FolderItem[];
  onMoveToFolder?: (noteId: number, folderId: number) => void;
  onCreateFolderAndMove?: (noteId: number, folderName: string) => void;
}

export default function NoteEditor({
  note,
  onTitleChange,
  onContentChange,
  isSaving,
  isRecording,
  isProcessing,
  recordingAllowed = true,
  onStartRecording,
  onStopRecording,
  onExportNote,
  onExportTranscript,
  enhancement,
  actionPicker,
  onGenerateSummary,
  actionProcessingState,
  actionName,
  diarizationSessionId,
  onLiveSpeakerLock,
  sessionDiarizationEnabled,
  sessionExpectedCount,
  userTouchedStepper,
  onSetSessionDiarizationEnabled,
  onSetSessionExpectedCount,
  folderName,
  calendarEventName,
  folders,
  onMoveToFolder,
  onCreateFolderAndMove,
}: NoteEditorProps) {
  const { t } = useTranslation();
  const locale = useUiLocale();
  const [viewMode, setViewMode] = useState<MeetingViewMode>("raw");
  const [chatMode, setChatMode] = useState<EmbeddedChatMode>("hidden");
  const [folderSearch, setFolderSearch] = useState("");
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [isDiarizing, setIsDiarizing] = useState(false);
  const canEditNote = true;
  const canMoveToFolders = true;
  const [diarizedSegments, setDiarizedSegments] = useState<TranscriptSegment[] | null>(null);
  const [speakerMappings, setSpeakerMappings] = useState<Record<string, string>>({});
  const [speakerProfiles, setSpeakerProfiles] = useState<
    Array<{ id: number; display_name: string; email: string | null }>
  >([]);
  const editorRef = useRef<Editor | null>(null);

  const embeddedChat = useEmbeddedChat({
    noteId: note.id,
    folderId: note.folder_id,
    noteTitle: note.title,
    noteContent: note.content,
    noteTranscript: note.transcript ?? undefined,
  });
  const titleRef = useRef<HTMLDivElement>(null);
  const prevNoteIdRef = useRef<number>(note.id);

  const segmentContainerRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<React.CSSProperties>({ opacity: 0 });
  const scheduleUiUpdate = useCallback((callback: () => void) => {
    const frameId = window.requestAnimationFrame(callback);
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  const hasMeetingTranscript = !!note.transcript;

  const filteredFolders = useMemo(
    () =>
      folderSearch && folders
        ? folders.filter((f) => folderMatchesQuery(f, t, folderSearch))
        : (folders ?? []),
    [folders, folderSearch, t]
  );

  const displaySegments = useMemo<TranscriptSegment[]>(() => {
    if (diarizedSegments && diarizedSegments.length > 0) return diarizedSegments;
    return parseTranscriptSegments(note.transcript || "");
  }, [diarizedSegments, note.transcript]);

  const hasChatSegments = displaySegments.length > 0;
  // A finished recording with no AI summary yet offers one from the transcript view.
  const showSummaryCallout =
    viewMode === "transcript" &&
    !isRecording &&
    hasChatSegments &&
    !enhancement &&
    canEditNote &&
    !!onGenerateSummary &&
    actionProcessingState !== "processing";

  const knownSpeakers = useMemo(
    () => buildKnownSpeakers(speakerProfiles, displaySegments, speakerMappings),
    [displaySegments, speakerMappings, speakerProfiles]
  );

  const parsedParticipants = useMemo<CalendarAttendee[]>(() => {
    try {
      return note.participants ? JSON.parse(note.participants) : [];
    } catch {
      return [];
    }
  }, [note.participants]);

  const mentionPeople = useMemo(
    () =>
      collectKnownPeople(
        { selfName: null, selfEmail: null, participants: parsedParticipants },
        speakerMappings,
        displaySegments
      ),
    [parsedParticipants, speakerMappings, displaySegments]
  );

  const refreshSpeakerProfiles = useCallback(() => {
    window.electronAPI?.getSpeakerProfiles?.().then((profiles) => {
      setSpeakerProfiles(
        (profiles || []).map((profile) => ({
          id: profile.id,
          display_name: profile.display_name,
          email: profile.email,
        }))
      );
    });
  }, []);

  const updateSegmentIndicator = useCallback(() => {
    const container = segmentContainerRef.current;
    if (!container) return;

    const buttons = container.querySelectorAll<HTMLButtonElement>("[data-segment-button]");
    const activeBtn = Array.from(buttons).find((btn) => btn.dataset.segmentValue === viewMode);
    if (!activeBtn) return;

    const cr = container.getBoundingClientRect();
    const br = activeBtn.getBoundingClientRect();
    setIndicatorStyle({
      width: br.width,
      height: br.height,
      transform: `translateX(${br.left - cr.left}px)`,
      opacity: 1,
    });
  }, [viewMode]);

  useEffect(() => {
    updateSegmentIndicator();
  }, [updateSegmentIndicator]);

  useEffect(() => {
    const observer = new ResizeObserver(() => updateSegmentIndicator());
    if (segmentContainerRef.current) observer.observe(segmentContainerRef.current);
    return () => observer.disconnect();
  }, [updateSegmentIndicator]);

  const prevProcessingStateRef = useRef(actionProcessingState);
  useEffect(() => {
    let cancelScheduledUpdate: (() => void) | undefined;

    if (prevProcessingStateRef.current === "processing" && actionProcessingState === "success") {
      cancelScheduledUpdate = scheduleUiUpdate(() => setViewMode("enhanced"));
    }
    prevProcessingStateRef.current = actionProcessingState;

    return cancelScheduledUpdate;
  }, [actionProcessingState, scheduleUiUpdate]);

  useEffect(() => {
    if (note.id !== prevNoteIdRef.current) {
      prevNoteIdRef.current = note.id;
      return scheduleUiUpdate(() => {
        setChatMode("hidden");
        setDiarizedSegments(null);
        setIsDiarizing(false);
        setSpeakerMappings({});
        setViewMode("raw");
        if (titleRef.current && titleRef.current.textContent !== note.title) {
          titleRef.current.textContent = note.title || "";
        }
        editorRef.current?.commands.focus();
      });
    }
  }, [note.id, note.title, scheduleUiUpdate]);

  useEffect(() => {
    window.electronAPI?.getSpeakerMappings?.(note.id).then((mappings) => {
      const map: Record<string, string> = {};
      for (const m of mappings || []) map[m.speaker_id] = m.display_name;
      setSpeakerMappings(map);
    });
    refreshSpeakerProfiles();
  }, [note.id, refreshSpeakerProfiles]);

  useEffect(() => {
    if (titleRef.current && titleRef.current.textContent !== note.title) {
      titleRef.current.textContent = note.title || "";
    }
  }, [note.title]);

  const prevRecordingForDiarizationRef = useRef(false);
  useEffect(() => {
    if (prevRecordingForDiarizationRef.current && !isRecording && diarizationSessionId) {
      const cancelScheduledUpdate = scheduleUiUpdate(() => setIsDiarizing(true));
      prevRecordingForDiarizationRef.current = isRecording;
      return cancelScheduledUpdate;
    }
    prevRecordingForDiarizationRef.current = isRecording;
  }, [diarizationSessionId, isRecording, scheduleUiUpdate]);

  // Persistence happens in meetingRecordingStore's module-level listener
  // (#1495); this only mirrors a published result into the rendered note's UI.
  const completedDiarization = useMeetingRecordingStore((s) => s.completedDiarization);
  useEffect(() => {
    if (!completedDiarization || completedDiarization.noteId !== note.id) return;
    // Consume so a remount can't repaint this overlay over newer edits; the
    // transcript itself is already persisted.
    useMeetingRecordingStore.setState({ completedDiarization: null });
    setIsDiarizing(false);

    const enriched = completedDiarization.segments;
    if (enriched.length === 0) return;
    setDiarizedSegments(enriched);

    const autoMappings: Record<string, string> = {};
    for (const s of enriched) {
      if (s.speakerName && s.speaker) autoMappings[s.speaker] = s.speakerName;
    }
    if (Object.keys(autoMappings).length > 0) {
      setSpeakerMappings((prev) => ({ ...autoMappings, ...prev }));
    }
  }, [completedDiarization, note.id]);

  const persistDisplaySegments = useCallback(
    async (nextSegments: TranscriptSegment[], updateOverlay = true) => {
      if (updateOverlay) {
        setDiarizedSegments(nextSegments);
      }
      await window.electronAPI?.updateNote(note.id, {
        transcript: serializeTranscriptSegments(nextSegments),
      });
    },
    [note.id]
  );

  const handleMapSpeaker = useCallback(
    async (
      speakerId: string,
      displayName: string,
      email?: string | null,
      profileId?: number | null
    ) => {
      setSpeakerMappings((prev) => ({ ...prev, [speakerId]: displayName }));
      await window.electronAPI?.setSpeakerMapping?.(
        note.id,
        speakerId,
        displayName,
        email,
        profileId
      );

      if (isRecording) {
        onLiveSpeakerLock?.(speakerId, displayName);
        refreshSpeakerProfiles();
        return;
      }

      const currentSegments = displaySegments.map((s) =>
        s.speaker === speakerId
          ? lockTranscriptSpeaker(s, {
              speakerName: displayName,
              speaker: speakerId,
              speakerIsPlaceholder: false,
              suggestedName: undefined,
              suggestedProfileId: undefined,
            })
          : s
      );
      await persistDisplaySegments(currentSegments, !!diarizedSegments || !isRecording);

      refreshSpeakerProfiles();
    },
    [
      diarizedSegments,
      displaySegments,
      isRecording,
      note.id,
      onLiveSpeakerLock,
      persistDisplaySegments,
      refreshSpeakerProfiles,
    ]
  );

  const handleConfirmSuggestion = useCallback(
    async (speakerId: string, suggestedName: string, profileId: number) => {
      await handleMapSpeaker(speakerId, suggestedName, null, profileId);
    },
    [handleMapSpeaker]
  );

  const handleAttachSpeakerEmail = useCallback(
    async (profileId: number, email: string | null) => {
      const result = await window.electronAPI?.attachSpeakerEmail?.(profileId, email);
      if (result?.success) {
        refreshSpeakerProfiles();
      }
    },
    [refreshSpeakerProfiles]
  );

  const handleDismissSuggestion = useCallback(
    async (speakerId: string) => {
      const currentSegments = displaySegments.map((s) =>
        s.speaker === speakerId
          ? applyTranscriptSpeakerPatch(s, {
              suggestedName: undefined,
              suggestedProfileId: undefined,
            })
          : s
      );
      await persistDisplaySegments(currentSegments, !!diarizedSegments || !isRecording);
    },
    [displaySegments, diarizedSegments, isRecording, persistDisplaySegments]
  );

  const [selectedSegmentIds, setSelectedSegmentIds] = useState<Set<string>>(new Set());
  const [selectionNoteId, setSelectionNoteId] = useState(note.id);
  if (selectionNoteId !== note.id) {
    setSelectionNoteId(note.id);
    setSelectedSegmentIds(new Set());
  }

  const handleToggleSelect = useCallback((segmentId: string) => {
    setSelectedSegmentIds((prev) => {
      const next = new Set(prev);
      if (next.has(segmentId)) next.delete(segmentId);
      else next.add(segmentId);
      return next;
    });
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedSegmentIds(new Set());
  }, []);

  useEffect(() => {
    if (selectedSegmentIds.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedSegmentIds.size, handleClearSelection]);

  const handleBulkAssignName = useCallback(
    async (displayName: string, _email?: string | null, profileId?: number) => {
      if (!selectedSegmentIds.size) return;
      const nextSegments = displaySegments.map((segment) =>
        selectedSegmentIds.has(segment.id)
          ? lockTranscriptSpeaker(segment, {
              speakerName: displayName,
              speakerIsPlaceholder: false,
              suggestedName: undefined,
              suggestedProfileId: profileId ?? undefined,
            })
          : segment
      );
      await persistDisplaySegments(nextSegments);
      handleClearSelection();
    },
    [displaySegments, selectedSegmentIds, persistDisplaySegments, handleClearSelection]
  );

  const handleTitleInput = useCallback(() => {
    if (titleRef.current) {
      const text = titleRef.current.textContent || "";
      onTitleChange(note.id, text);
    }
  }, [note.id, onTitleChange]);

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      editorRef.current?.commands.focus();
    }
  }, []);

  const handleTitlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain").replace(/\n/g, " ");
    document.execCommand("insertText", false, text);
  }, []);

  const contentScrollRef = useRef<HTMLDivElement>(null);

  const getActiveScroller = useCallback((root: HTMLDivElement): HTMLElement | null => {
    const candidates = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))].filter(
      (el) => el.scrollHeight - el.clientHeight > 2
    );
    if (!candidates.length) return null;
    return candidates.reduce((a, b) =>
      b.scrollHeight - b.clientHeight > a.scrollHeight - a.clientHeight ? b : a
    );
  }, []);

  const floatingChatPanelRef = useCallback(
    (panel: HTMLDivElement | null): (() => void) | undefined => {
      const container = panel?.parentElement;
      const contentRoot = contentScrollRef.current;
      if (!panel || !container || !contentRoot) return undefined;

      return observeFloatingChatLayout({
        panel,
        container,
        contentRoot,
        getActiveScroller: (): HTMLElement | null => getActiveScroller(contentRoot),
      });
    },
    [getActiveScroller]
  );

  const handleContentChange = useCallback(
    (newValue: string) => {
      onContentChange(note.id, newValue);
    },
    [note.id, onContentChange]
  );

  const handleEnhancedChange = useCallback(
    (value: string) => {
      enhancement?.onChange(note.id, value);
    },
    [enhancement, note.id]
  );

  const handleAskSubmit = useCallback(
    (text: string) => {
      if (chatMode === "hidden") {
        setChatMode("floating");
      }
      embeddedChat.sendMessage(text);
    },
    [chatMode, embeddedChat]
  );

  const handleChatInputFocus = useCallback(() => {
    if (chatMode === "hidden") {
      setChatMode("floating");
    }
  }, [chatMode]);

  const noteDate = formatNoteDate(note.created_at, locale);
  const shortDate = formatShortDate(note.created_at, locale);

  const exportOptions = useMemo<NoteExportOption[]>(() => {
    if (viewMode === "transcript" && onExportTranscript) {
      return (["txt", "srt", "md", "json"] as const).map((format) => ({
        id: format,
        label: t(TRANSCRIPT_EXPORT_LABEL_KEYS[format]),
        onSelect: () => onExportTranscript(format),
      }));
    }
    if (!onExportNote) return [];
    return (["md", "txt"] as const).map((format) => ({
      id: format,
      label: t(NOTE_EXPORT_LABEL_KEYS[format]),
      onSelect: () => onExportNote(format),
    }));
  }, [viewMode, onExportTranscript, onExportNote, t]);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="px-5 pt-5 pb-0">
          <div
            dir="auto"
            ref={titleRef}
            contentEditable={canEditNote}
            suppressContentEditableWarning
            onInput={handleTitleInput}
            onKeyDown={handleTitleKeyDown}
            onPaste={handleTitlePaste}
            data-placeholder={t("notes.editor.untitled")}
            className="text-3xl font-medium leading-tight text-foreground bg-transparent outline-none tracking-[-0.01em] empty:before:content-[attr(data-placeholder)] empty:before:text-foreground/45 empty:before:pointer-events-none"
            role="textbox"
            aria-label={t("notes.editor.noteTitle")}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <NoteParticipants
              noteId={note.id}
              participants={parsedParticipants}
              dateLabel={shortDate || undefined}
              dateTitle={noteDate}
            />
            {calendarEventName && (
              <span className={cn(NOTE_META_CHIP_CLASS, "cursor-default")}>
                <LinkIcon size={14} className="shrink-0 text-foreground/60" />
                <span className="max-w-40 truncate">{calendarEventName}</span>
              </span>
            )}
            {folders && onMoveToFolder && !canMoveToFolders && folderName && (
              <span className={cn(NOTE_META_CHIP_CLASS, "cursor-default")}>
                <FolderOpen size={14} className="shrink-0 text-foreground/60" />
                <span dir="auto">{folderName}</span>
              </span>
            )}
            {folders && onMoveToFolder && canMoveToFolders && (
              <DropdownMenu
                onOpenChange={(open) => {
                  if (!open) {
                    setFolderSearch("");
                    setIsCreatingFolder(false);
                    setNewFolderName("");
                  }
                }}
              >
                <DropdownMenuTrigger asChild>
                  <button className={NOTE_META_CHIP_CLASS}>
                    <FolderOpen size={14} className="shrink-0 text-foreground/60" />
                    {folderName ? <span dir="auto">{folderName}</span> : t("notes.editor.noFolder")}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" sideOffset={6} className="min-w-44 p-1">
                  {folders.length > 5 && (
                    <>
                      <div className="relative px-1.5 py-0.5">
                        <Search
                          size={9}
                          className="absolute start-3.5 top-1/2 -translate-y-1/2 text-foreground/45 pointer-events-none"
                        />
                        <input
                          dir="auto"
                          value={folderSearch}
                          onChange={(e) => setFolderSearch(e.target.value)}
                          onKeyDown={(e) => e.stopPropagation()}
                          placeholder={t("notes.context.searchFolders")}
                          className="input-inline w-full ps-4.5 pe-1 py-0.5 text-xs text-foreground placeholder:text-foreground/45 outline-none border-none appearance-none"
                        />
                      </div>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <div className="overflow-y-auto max-h-48">
                    {filteredFolders.map((folder) => {
                      const isCurrent = folder.id === note.folder_id;
                      return (
                        <DropdownMenuItem
                          key={folder.id}
                          disabled={isCurrent}
                          onClick={() => onMoveToFolder(note.id, folder.id)}
                          className="text-xs gap-2 rounded-md px-2 py-1.5"
                        >
                          <FolderOpen size={11} className="text-foreground/45 shrink-0" />
                          <span dir="auto" className="truncate flex-1">
                            {defaultFolderDisplayName(folder, t)}
                          </span>
                          {isCurrent && <Check size={9} className="text-primary shrink-0" />}
                        </DropdownMenuItem>
                      );
                    })}
                    {folderSearch && filteredFolders.length === 0 && (
                      <p className="text-xs text-foreground/45 text-center py-1.5">
                        {t("notes.context.noResults")}
                      </p>
                    )}
                  </div>
                  {onCreateFolderAndMove && (
                    <>
                      <DropdownMenuSeparator />
                      {isCreatingFolder ? (
                        <div className="px-1">
                          <input
                            dir="auto"
                            autoFocus
                            value={newFolderName}
                            onChange={(e) => setNewFolderName(e.target.value)}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === "Enter" && newFolderName.trim()) {
                                onCreateFolderAndMove(note.id, newFolderName.trim());
                                setNewFolderName("");
                                setIsCreatingFolder(false);
                              }
                              if (e.key === "Escape") {
                                setIsCreatingFolder(false);
                                setNewFolderName("");
                              }
                            }}
                            placeholder={t("notes.folders.folderName")}
                            className="input-inline w-full px-2 py-1.5 rounded-md bg-transparent text-xs text-foreground placeholder:text-foreground/45 outline-none border-none appearance-none"
                          />
                        </div>
                      ) : (
                        <DropdownMenuItem
                          onSelect={(e) => {
                            e.preventDefault();
                            setIsCreatingFolder(true);
                          }}
                          className="text-xs gap-2 rounded-md px-2 py-1.5 text-foreground/45"
                        >
                          <Plus size={10} />
                          {t("notes.context.newFolder")}
                        </DropdownMenuItem>
                      )}
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {isSaving && (
              <span className="inline-flex items-center gap-1 text-xs text-foreground/45 tabular-nums">
                <Loader2 size={10} className="animate-spin" />
                {t("notes.editor.saving")}
              </span>
            )}
          </div>
          <div className="mt-5 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center">
              <div
                ref={segmentContainerRef}
                className="relative flex shrink-0 items-center rounded-full bg-surface-3 p-0.5 dark:bg-surface-2"
              >
                <div
                  className="pointer-events-none absolute top-0.5 left-0 rounded-full bg-background shadow-sm transition-[width,height,transform,opacity] duration-200 ease-out dark:bg-surface-3"
                  style={indicatorStyle}
                />
                <button
                  data-segment-button
                  data-segment-value="transcript"
                  onClick={() => setViewMode("transcript")}
                  className={cn(
                    SEGMENT_BUTTON_CLASS,
                    viewMode === "transcript"
                      ? "text-foreground"
                      : "text-foreground/60 hover:text-foreground/80"
                  )}
                >
                  {isRecording ? <RecordingWave /> : <MessageSquareText size={12} />}
                  {t("notes.editor.transcript")}
                </button>
                <button
                  data-segment-button
                  data-segment-value="raw"
                  onClick={() => setViewMode("raw")}
                  className={cn(
                    SEGMENT_BUTTON_CLASS,
                    viewMode === "raw"
                      ? "text-foreground"
                      : "text-foreground/60 hover:text-foreground/80"
                  )}
                >
                  <AlignLeft size={12} />
                  {t("notes.editor.notes")}
                </button>
                {enhancement && (
                  <button
                    data-segment-button
                    data-segment-value="enhanced"
                    onClick={() => setViewMode("enhanced")}
                    className={cn(
                      SEGMENT_BUTTON_CLASS,
                      viewMode === "enhanced"
                        ? "text-foreground"
                        : "text-foreground/60 hover:text-foreground/80"
                    )}
                  >
                    <Sparkles size={12} />
                    {t("notes.editor.enhanced")}
                    {enhancement.isStale && (
                      <span
                        className="h-1 w-1 rounded-full bg-amber-400/60"
                        title={t("notes.editor.staleIndicator")}
                      />
                    )}
                  </button>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {canEditNote && (
                <NoteRecordControl
                  isRecording={isRecording}
                  isProcessing={isProcessing}
                  disabled={!recordingAllowed}
                  onStart={onStartRecording}
                  onStop={onStopRecording}
                />
              )}
              {exportOptions.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" className={NOTE_META_CHIP_CLASS}>
                      <FileText size={13} className="text-foreground/60" />
                      {t("notes.editor.export")}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {exportOptions.map((option) => (
                      <DropdownMenuItem key={option.id} onSelect={option.onSelect}>
                        {option.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>
        </div>


        <div className="flex-1 relative min-h-0">
          <div ref={contentScrollRef} className="h-full overflow-y-auto">
            {viewMode === "transcript" && (hasChatSegments || isRecording) ? (
              isRecording ? (
                <LiveMeetingTranscriptChat
                  speakerMappings={speakerMappings}
                  speakerProfiles={speakerProfiles}
                  participants={parsedParticipants}
                  isDiarizing={isDiarizing}
                  sessionDiarizationEnabled={sessionDiarizationEnabled}
                  sessionExpectedCount={sessionExpectedCount}
                  userTouchedStepper={userTouchedStepper}
                  onSetSessionDiarizationEnabled={onSetSessionDiarizationEnabled}
                  onSetSessionExpectedCount={onSetSessionExpectedCount}
                  onMapSpeaker={handleMapSpeaker}
                  onConfirmSuggestion={handleConfirmSuggestion}
                  onDismissSuggestion={handleDismissSuggestion}
                  onAttachSpeakerEmail={handleAttachSpeakerEmail}
                />
              ) : (
                <MeetingTranscriptChat
                  segments={displaySegments}
                  speakerMappings={speakerMappings}
                  speakerProfiles={knownSpeakers}
                  participants={parsedParticipants}
                  isDiarizing={isDiarizing}
                  sessionDiarizationEnabled={sessionDiarizationEnabled}
                  sessionExpectedCount={sessionExpectedCount}
                  userTouchedStepper={userTouchedStepper}
                  onSetSessionDiarizationEnabled={onSetSessionDiarizationEnabled}
                  onSetSessionExpectedCount={onSetSessionExpectedCount}
                  onMapSpeaker={handleMapSpeaker}
                  onConfirmSuggestion={handleConfirmSuggestion}
                  onDismissSuggestion={handleDismissSuggestion}
                  onAttachSpeakerEmail={handleAttachSpeakerEmail}
                  selectedSegmentIds={selectedSegmentIds}
                  onToggleSelect={handleToggleSelect}
                />
              )
            ) : viewMode === "transcript" && hasMeetingTranscript ? (
              <RichTextEditor value={note.transcript || ""} disabled />
            ) : viewMode === "transcript" ? (
              <EmptyStateCard
                icon={Mic}
                title={t("notes.editor.transcriptEmptyTitle")}
                description={t("notes.editor.transcriptEmptyDescription")}
                className="mt-2"
              >
                {canEditNote && recordingAllowed && (
                  <Button size="sm" onClick={onStartRecording} disabled={isProcessing}>
                    <Mic size={13} />
                    {t("notes.editor.startRecording")}
                  </Button>
                )}
              </EmptyStateCard>
            ) : viewMode === "enhanced" && enhancement ? (
              <RichTextEditor
                value={enhancement.content}
                onChange={handleEnhancedChange}
                disabled={!canEditNote}
                mentionPeople={mentionPeople}
              />
            ) : (
              <RichTextEditor
                value={note.content}
                onChange={handleContentChange}
                editorRef={editorRef}
                placeholder={t("notes.editor.startWriting")}
                disabled={!canEditNote || actionProcessingState === "processing"}
                mentionPeople={mentionPeople}
              />
            )}
          </div>
          <ActionProcessingOverlay
            state={actionProcessingState ?? "idle"}
            actionName={actionName ?? null}
          />
          <div
            className="absolute bottom-0 left-0 right-0 h-20 pointer-events-none"
            style={{
              background: "linear-gradient(to bottom, transparent, var(--color-background))",
            }}
          />
          {!isRecording && selectedSegmentIds.size > 0 && (
            <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-20 pointer-events-auto">
              <SelectionBar
                count={selectedSegmentIds.size}
                onClear={handleClearSelection}
                speakerProfiles={knownSpeakers}
                participants={parsedParticipants}
                onAssignName={handleBulkAssignName}
                t={t}
              />
            </div>
          )}
          <NoteBottomBar
            isRecording={isRecording}
            onAskSubmit={handleAskSubmit}
            onInputFocus={handleChatInputFocus}
            actionPicker={isRecording || !canEditNote ? undefined : actionPicker}
            callout={
              showSummaryCallout && (
                <Button className="h-9 gap-2 px-4 text-sm" onClick={onGenerateSummary}>
                  <AlignLeft size={16} />
                  {t("notes.editor.generateSummary")}
                </Button>
              )
            }
            hideInput={chatMode !== "hidden"}
          />
          {chatMode === "floating" && (
            <EmbeddedChat
              mode="floating"
              floatingPanelRef={floatingChatPanelRef}
              onModeChange={setChatMode}
              messages={embeddedChat.messages}
              agentState={embeddedChat.agentState}
              onTextSubmit={embeddedChat.sendMessage}
              onCancel={embeddedChat.cancelStream}
              noteConversations={embeddedChat.noteConversations}
              activeConversationId={embeddedChat.activeConversationId}
              onSwitchConversation={embeddedChat.switchConversation}
              onNewChat={embeddedChat.startNewChat}
            />
          )}
        </div>
      </div>
      {chatMode === "sidebar" && (
        <EmbeddedChat
          mode="sidebar"
          onModeChange={setChatMode}
          messages={embeddedChat.messages}
          agentState={embeddedChat.agentState}
          onTextSubmit={embeddedChat.sendMessage}
          onCancel={embeddedChat.cancelStream}
          noteConversations={embeddedChat.noteConversations}
          activeConversationId={embeddedChat.activeConversationId}
          onSwitchConversation={embeddedChat.switchConversation}
          onNewChat={embeddedChat.startNewChat}
        />
      )}
    </div>
  );
}
