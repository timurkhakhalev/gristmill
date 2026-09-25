import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useUiLocale } from "../../hooks/useUiLocale";
import {
  Loader2,
  FileText,
  Sparkles,
  AlignLeft,
  Mic,
  LinkIcon,
  FolderOpen,
  Search,
  Plus,
  Check,
  ArrowLeft,
  PanelRight,
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
import type { FolderItem } from "../../contracts/containers";
import type { NoteItem } from "../../contracts/notes";
import type { ActionProcessingState } from "../../hooks/useActionProcessing";
import ActionProcessingOverlay from "./ActionProcessingOverlay";
import NoteBottomBar from "./NoteBottomBar";
import NoteRecordControl, { RecordingWave } from "./NoteRecordControl";
import EmptyStateCard from "../ui/EmptyStateCard";
import { Button } from "../ui/button";
import EmbeddedChat, { type EmbeddedChatMode } from "./EmbeddedChat";
import { useEmbeddedChat } from "../../hooks/useEmbeddedChat";
import type { Message } from "../chat/types";
import { formatNoteDate, formatShortDate } from "../../utils/dateFormatting";
import { collectKnownPeople } from "../../utils/llmTranscript";
import { parseTranscriptSegments } from "../../utils/parseTranscriptSegments";
import {
  applyTranscriptSpeakerPatch,
  lockTranscriptSpeaker,
  serializeTranscriptSegments,
} from "../../utils/transcriptSpeakerState";
import NoteParticipants from "./NoteParticipants";
import type { CalendarAttendee } from "../../contracts/calendar";
import { observeFloatingChatLayout } from "./floatingChatLayout";
import { NOTE_META_CHIP_CLASS, defaultFolderDisplayName, folderMatchesQuery } from "./shared";
import { formatMmSs } from "../../utils/formatDuration";
import MeetingResultsPanel from "./MeetingResultsPanel";
import type { MeetingProcessingRecordingResult } from "../../contracts/meetingProcessing";

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

interface NoteEditorProps {
  note: NoteItem;
  onBackToNotes?: () => void;
  onTitleChange: (sourceNoteId: number, title: string) => void;
  onContentChange: (sourceNoteId: number, content: string) => void;
  isSaving: boolean;
  isRecording: boolean;
  isProcessing: boolean;
  recordingAllowed?: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onPauseRecording?: () => void;
  onResumeRecording?: () => void;
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
  debugPreview?: {
    recordings: MeetingProcessingRecordingResult[];
    capturePhase?: "idle" | "preparing" | "recording" | "paused" | "saving" | "saved" | "incomplete" | "failed";
    captureStartedAt?: number;
    captureErrorCode?: string;
    micStatus?: "inactive" | "active" | "reconnecting" | "unavailable";
    systemStatus?: "inactive" | "active" | "reconnecting" | "unavailable";
    viewMode?: MeetingViewMode;
  };
}

export default function NoteEditor({
  note,
  onBackToNotes,
  onTitleChange,
  onContentChange,
  isSaving,
  isRecording,
  isProcessing,
  recordingAllowed = true,
  onStartRecording,
  onStopRecording,
  onPauseRecording,
  onResumeRecording,
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
  debugPreview,
}: NoteEditorProps) {
  const { t } = useTranslation();
  const locale = useUiLocale();
  const liveCapturePhase = useMeetingRecordingStore((s) =>
    s.recordingNoteId === note.id ? s.capturePhase : "idle"
  );
  const capturePhase = debugPreview?.capturePhase ?? liveCapturePhase;
  const liveCaptureStartedAt = useMeetingRecordingStore((s) =>
    s.recordingNoteId === note.id ? s.captureStartedAt : null
  );
  const captureStartedAt = debugPreview?.captureStartedAt ?? liveCaptureStartedAt;
  const liveCaptureErrorCode = useMeetingRecordingStore((s) =>
    s.recordingNoteId === note.id ? s.captureErrorCode : null
  );
  const captureErrorCode = debugPreview?.captureErrorCode ?? liveCaptureErrorCode;
  const liveMicCaptureStatus = useMeetingRecordingStore((s) =>
    s.recordingNoteId === note.id ? s.micCaptureStatus : "inactive"
  );
  const liveSystemCaptureStatus = useMeetingRecordingStore((s) =>
    s.recordingNoteId === note.id ? s.systemCaptureStatus : "inactive"
  );
  const micCaptureStatus = debugPreview?.micStatus ?? liveMicCaptureStatus;
  const systemCaptureStatus = debugPreview?.systemStatus ?? liveSystemCaptureStatus;
  const capturePending = capturePhase === "preparing" || capturePhase === "saving";
  const captureLive = capturePhase === "recording";
  const captureHasStatus = capturePending || captureLive || capturePhase === "paused" || capturePhase === "incomplete" || capturePhase === "failed";
  const [viewMode, setViewMode] = useState<MeetingViewMode>(
    debugPreview?.viewMode ?? (note.note_type === "upload" && note.transcript ? "transcript" : "raw")
  );
  const [chatMode, setChatMode] = useState<EmbeddedChatMode>("hidden");
  const [folderSearch, setFolderSearch] = useState("");
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [isDiarizing, setIsDiarizing] = useState(false);
  const canEditNote = true;
  const canMoveToFolders = !debugPreview;
  const [diarizedSegments, setDiarizedSegments] = useState<TranscriptSegment[] | null>(null);
  const [speakerMappings, setSpeakerMappings] = useState<Record<string, string>>({});
  const [speakerProfiles, setSpeakerProfiles] = useState<
    Array<{ id: number; display_name: string; email: string | null }>
  >([]);
  const editorRef = useRef<Editor | null>(null);

  const embeddedChat = useEmbeddedChat({
    noteId: debugPreview ? null : note.id,
    disabled: Boolean(debugPreview),
    folderId: note.folder_id,
    noteTitle: note.title,
    noteContent: note.content,
    noteTranscript: note.transcript ?? undefined,
  });
  const [previewChatMessages, setPreviewChatMessages] = useState<Message[]>([]);
  const sendPreviewMessage = useCallback((text: string) => {
    setPreviewChatMessages((messages) => [
      ...messages,
      { id: crypto.randomUUID(), role: "user", content: text, isStreaming: false },
      { id: crypto.randomUUID(), role: "assistant", content: "Mock reply. No provider or database was used.", isStreaming: false },
    ]);
  }, []);
  const chatMessages = debugPreview ? previewChatMessages : embeddedChat.messages;
  const sendChatMessage = debugPreview ? sendPreviewMessage : embeddedChat.sendMessage;
  const titleRef = useRef<HTMLDivElement>(null);
  const prevNoteIdRef = useRef<number>(note.id);

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
    if (debugPreview) return;
    window.electronAPI?.getSpeakerProfiles?.().then((profiles) => {
      setSpeakerProfiles(
        (profiles || []).map((profile) => ({
          id: profile.id,
          display_name: profile.display_name,
          email: profile.email,
        }))
      );
    });
  }, [debugPreview]);

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
    if (debugPreview) return;
    window.electronAPI?.getSpeakerMappings?.(note.id).then((mappings) => {
      const map: Record<string, string> = {};
      for (const m of mappings || []) map[m.speaker_id] = m.display_name;
      setSpeakerMappings(map);
    });
    refreshSpeakerProfiles();
  }, [debugPreview, note.id, refreshSpeakerProfiles]);

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
    if (debugPreview) return;
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
  }, [completedDiarization, debugPreview, note.id]);

  const persistDisplaySegments = useCallback(
    async (nextSegments: TranscriptSegment[], updateOverlay = true) => {
      if (updateOverlay || debugPreview) {
        setDiarizedSegments(nextSegments);
      }
      if (debugPreview) return;
      await window.electronAPI?.updateNote(note.id, {
        transcript: serializeTranscriptSegments(nextSegments),
      });
    },
    [debugPreview, note.id]
  );

  const handleMapSpeaker = useCallback(
    async (
      speakerId: string,
      displayName: string,
      email?: string | null,
      profileId?: number | null
    ) => {
      setSpeakerMappings((prev) => ({ ...prev, [speakerId]: displayName }));
      if (!debugPreview) {
        await window.electronAPI?.setSpeakerMapping?.(
          note.id,
          speakerId,
          displayName,
          email,
          profileId
        );
      }

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
      debugPreview,
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
      if (debugPreview) return;
      const result = await window.electronAPI?.attachSpeakerEmail?.(profileId, email);
      if (result?.success) {
        refreshSpeakerProfiles();
      }
    },
    [debugPreview, refreshSpeakerProfiles]
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
        setChatMode("sidebar");
      }
      sendChatMessage(text);
    },
    [chatMode, sendChatMessage]
  );

  const handleChatInputFocus = useCallback(() => {
    if (chatMode === "hidden") {
      setChatMode("sidebar");
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
    <div className="relative flex h-full min-h-0">
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="oh-note-header px-5 pt-5 pb-0">
          {onBackToNotes && <button type="button" className="oh-back-button" onClick={onBackToNotes} aria-label={t("controlPanel.backToNotes")}><ArrowLeft size={16}/>{t("controlPanel.backToNotes")}</button>}
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
              preview={Boolean(debugPreview)}
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
          <div className="mt-5 flex items-center justify-end gap-3">
            <div className="flex shrink-0 items-center gap-2">
              <button type="button" className="oh-chat-toggle" onClick={() => setChatMode(chatMode === "sidebar" ? "hidden" : "sidebar")} aria-label={t("sidebar.chat")} aria-pressed={chatMode === "sidebar"}><PanelRight size={17} /></button>
              {canEditNote && (
                <NoteRecordControl
                  isRecording={isRecording}
                  isProcessing={isProcessing}
                  disabled={!recordingAllowed}
                  capturePhase={capturePhase}
                  captureStartedAt={captureStartedAt}
                  onStart={onStartRecording}
                  onStop={onStopRecording}
                  onPause={onPauseRecording}
                  onResume={onResumeRecording}
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
          <div ref={contentScrollRef} className="h-full overflow-y-auto agent-chat-scroll">
            {captureHasStatus && (
              <div className="m-4 rounded-xl border border-border bg-surface-2/70 p-4 dark:border-white/10">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                    {(capturePending || captureLive) && <RecordingWave className="me-1" />}
                    {t(`notes.editor.capture.${capturePhase}`, { defaultValue: capturePhase === "paused" ? t("notes.editor.capture.paused", { defaultValue: "Paused" }) : capturePhase })}
                  </div>
                  {captureStartedAt != null && (capturePending || captureLive) && (
                    <span className="text-xs tabular-nums text-foreground/60">
                      {formatMmSs(Math.max(0, Math.floor((Date.now() - captureStartedAt) / 1000)))}
                    </span>
                  )}
                </div>
                {(capturePending || captureLive) && <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  {(["mic", "system"] as const).map((source) => {
                    const status = source === "mic" ? micCaptureStatus : systemCaptureStatus;
                    return (
                      <span
                        key={source}
                        className={cn(
                          "rounded-full px-2 py-1",
                          status === "active"
                            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                            : "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                        )}
                      >
                        {t(`notes.editor.capture.${source}`)}: {t(`notes.editor.capture.${status}`)}
                      </span>
                    );
                  })}
                  {capturePhase === "recording" && (
                    <span className="rounded-full bg-primary/10 px-2 py-1 text-primary">
                      {t("notes.editor.capture.writingToDisk")}
                    </span>
                  )}
                </div>}
                {captureErrorCode && (
                  <p className="mt-2 text-xs text-foreground/60">
                    {t("notes.editor.capture.incompleteReason")}
                  </p>
                )}
              </div>
            )}
            <MeetingResultsPanel
              noteId={note.id}
              locale={locale}
              previewRecordings={debugPreview?.recordings}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              manualContent={<RichTextEditor
                value={note.content}
                onChange={handleContentChange}
                editorRef={editorRef}
                placeholder={t("notes.editor.startWriting")}
                disabled={!canEditNote || actionProcessingState === "processing"}
                mentionPeople={mentionPeople}
              />}
              fallbackSummary={enhancement ? <RichTextEditor
                value={enhancement.content}
                onChange={handleEnhancedChange}
                disabled={!canEditNote}
                mentionPeople={mentionPeople}
              /> : <EmptyStateCard icon={Sparkles} title={t("notes.editor.enhanced")} description={t("notes.editor.transcriptEmptyDescription")} />}
              fallbackTranscript={hasChatSegments && !isRecording ? <MeetingTranscriptChat
                segments={displaySegments}
                scrollElementRef={contentScrollRef}
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
              /> : hasMeetingTranscript ? <RichTextEditor value={note.transcript || ""} disabled /> : <EmptyStateCard
                icon={Mic}
                title={t("notes.editor.transcriptEmptyTitle")}
                description={t("notes.editor.transcriptEmptyDescription")}
                className="mt-2"
              />}
            />
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
                <Button className="h-9 gap-2 px-4 text-sm" onClick={() => {
                  onGenerateSummary?.();
                  if (debugPreview) setViewMode("enhanced");
                }}>
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
              messages={chatMessages}
              agentState={embeddedChat.agentState}
              onTextSubmit={sendChatMessage}
              onCancel={debugPreview ? () => {} : embeddedChat.cancelStream}
              noteConversations={debugPreview ? undefined : embeddedChat.noteConversations}
              activeConversationId={embeddedChat.activeConversationId}
              onSwitchConversation={debugPreview ? undefined : embeddedChat.switchConversation}
              onNewChat={debugPreview ? undefined : embeddedChat.startNewChat}
              voiceDraft={!debugPreview}
              preview={Boolean(debugPreview)}
            />
          )}
        </div>
      </div>
      {chatMode === "sidebar" && (
        <EmbeddedChat
          mode="sidebar"
          onModeChange={setChatMode}
          messages={chatMessages}
          agentState={embeddedChat.agentState}
          onTextSubmit={sendChatMessage}
          onCancel={debugPreview ? () => {} : embeddedChat.cancelStream}
          noteConversations={debugPreview ? undefined : embeddedChat.noteConversations}
          activeConversationId={embeddedChat.activeConversationId}
          onSwitchConversation={debugPreview ? undefined : embeddedChat.switchConversation}
          onNewChat={debugPreview ? undefined : embeddedChat.startNewChat}
          voiceDraft={!debugPreview}
          preview={Boolean(debugPreview)}
        />
      )}
    </div>
  );
}
