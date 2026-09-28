import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useUiLocale } from "../../hooks/useUiLocale";
import {
  Loader2,
  Sparkles,
  AlignLeft,
  Mic,
  FolderOpen,
  Search,
  Plus,
  Check,
  ArrowLeft,
} from "../icons";
import { RichTextEditor } from "../ui/RichTextEditor";
import type { Editor } from "@tiptap/react";
import { calendarDescriptionText } from "../../helpers/calendarDescription";

/** Rich-text HTML → the plain text Copy puts on the clipboard. */
function htmlToPlainText(html: string): string {
  return calendarDescriptionText(html) ?? "";
}
import { MeetingTranscriptChat, SelectionBar } from "./MeetingTranscriptChat";
import {
  useMeetingRecordingStore,
  type TranscriptSegment,
} from "../../stores/meetingRecordingStore";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { MENU_ITEM_CLASS } from "../ui/surfaceStyles";
import { cn } from "../lib/utils";
import type { FolderItem } from "../../contracts/containers";
import type { NoteItem } from "../../contracts/notes";
import type { ActionProcessingState } from "../../hooks/useActionProcessing";
import ActionProcessingOverlay from "./ActionProcessingOverlay";
import NoteBottomBar from "./NoteBottomBar";
import NoteRecordControl from "./NoteRecordControl";
import { CaptureHealthLine, NoteNotice } from "./NoteNotices";
import { Button as HeroButton } from "@heroui/react";
import { openSettings } from "../../utils/openSettings";
import EmptyStateCard from "../ui/EmptyStateCard";
import { Button } from "../ui/button";
import ChatPanel, { type ChatPanelMode } from "../chat/ChatPanel";
import { setActiveFolderId, setActiveNoteId } from "../../stores/noteStore";
import { useEmbeddedChat } from "../../hooks/useEmbeddedChat";
import type { Message } from "../chat/types";
import { formatNoteDate, formatShortDate } from "../../utils/dateFormatting";
import { useDateTimePreferences } from "../../hooks/useDateTimePreferences";
import { collectKnownPeople } from "../../utils/llmTranscript";
import { parseTranscriptSegments } from "../../utils/parseTranscriptSegments";
import {
  applyTranscriptSpeakerPatch,
  lockTranscriptSpeaker,
  serializeTranscriptSegments,
} from "../../utils/transcriptSpeakerState";
import NoteParticipants from "./NoteParticipants";
import { takeNoteHandoff } from "./noteHandoff";
import NoteFindBar from "./NoteFindBar";
import type { CalendarAttendee, CalendarEvent } from "../../contracts/calendar";
import { observeFloatingChatLayout } from "./floatingChatLayout";
import { NOTE_META_CHIP_CLASS, defaultFolderDisplayName, folderMatchesQuery } from "./shared";
import MeetingResultsPanel from "./MeetingResultsPanel";
import type { MeetingProcessingRecordingResult } from "../../contracts/meetingProcessing";

export interface Enhancement {
  content: string;
  isStale: boolean;
  onChange: (sourceNoteId: number, content: string) => void;
}

type MeetingViewMode = "raw" | "transcript" | "enhanced";

type SpeakerProfileOption = { id?: number; display_name: string; email: string | null };

/** Opening priority: a ready Summary wins over the Notes body. */
function initialMeetingViewMode(note: NoteItem): MeetingViewMode {
  if (note.enhanced_content) return "enhanced";
  if (note.note_type === "upload" && note.transcript) return "transcript";
  return "raw";
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
  enhancement?: Enhancement;
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
  /** The linked calendar event, for the meeting card. Null when unlinked. */
  calendarEvent?: CalendarEvent | null;  folders?: FolderItem[];
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
  enhancement,
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
  calendarEvent,
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
  const liveMicCaptureStatus = useMeetingRecordingStore((s) =>
    s.recordingNoteId === note.id ? s.micCaptureStatus : "inactive"
  );
  const liveSystemCaptureStatus = useMeetingRecordingStore((s) =>
    s.recordingNoteId === note.id ? s.systemCaptureStatus : "inactive"
  );
  const micCaptureStatus = debugPreview?.micStatus ?? liveMicCaptureStatus;
  const systemCaptureStatus = debugPreview?.systemStatus ?? liveSystemCaptureStatus;
  const captureLive = capturePhase === "recording";
  const [viewMode, setViewMode] = useState<MeetingViewMode>(
    debugPreview?.viewMode ?? initialMeetingViewMode(note)
  );
  const [chatMode, setChatMode] = useState<ChatPanelMode>("hidden");
  const [folderSearch, setFolderSearch] = useState("");
  const [folderMenuOpen, setFolderMenuOpen] = useState(false);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [isDiarizing, setIsDiarizing] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
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
  const chatSuggestions = useMemo(
    () => (["summary", "actions", "decisions"] as const).map((key) => t(`embeddedChat.suggestions.${key}`)),
    [t]
  );
  const openChatNote = useCallback(async (noteId: number) => {
    const target = await window.electronAPI.getNote(noteId);
    if (target?.folder_id) setActiveFolderId(target.folder_id);
    setActiveNoteId(noteId);
  }, []);
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
  // A finished recording with no AI summary yet offers one from the Summary tab.
  const canGenerateSummary =
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
        setViewMode(initialMeetingViewMode(note));
        if (titleRef.current && titleRef.current.textContent !== note.title) {
          titleRef.current.textContent = note.title || "";
        }
        editorRef.current?.commands.focus();
      });
    }
  }, [note, scheduleUiUpdate]);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "f") return;
      e.preventDefault();
      setFindOpen((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  // A transcript opens at its newest row: the reader lands where the meeting
  // ended. The list is virtualized, so pin across a few frames while rows
  // measure and the real height settles.
  useEffect(() => {
    if (viewMode !== "transcript") return;
    const scroller = contentScrollRef.current;
    if (!scroller) return;
    let frame = 0;
    let remaining = 6;
    const pin = () => {
      scroller.scrollTop = scroller.scrollHeight;
      if (remaining-- > 0) frame = window.requestAnimationFrame(pin);
    };
    frame = window.requestAnimationFrame(pin);
    return () => window.cancelAnimationFrame(frame);
  }, [viewMode]);

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
      sendChatMessage(text);
    },
    [chatMode, sendChatMessage]
  );

  const chatPanelProps = {
    onModeChange: setChatMode,
    messages: chatMessages,
    agentState: embeddedChat.agentState,
    onTextSubmit: sendChatMessage,
    onCancel: debugPreview ? () => {} : embeddedChat.cancelStream,
    conversations: debugPreview ? undefined : embeddedChat.noteConversations,
    activeConversationId: embeddedChat.activeConversationId,
    onSwitchConversation: debugPreview ? undefined : embeddedChat.switchConversation,
    onNewChat: debugPreview ? undefined : embeddedChat.startNewChat,
    suggestions: chatSuggestions,
    emptyStateText: t("embeddedChat.emptyState"),
    onOpenNote: debugPreview ? undefined : openChatNote,
    allowSidebar: true,
    voiceDraft: !debugPreview,
  };

  // Focusing the ask bar reopens an ongoing conversation; a fresh one waits for the first question.
  // A note born from a calendar-event draft picks up where the draft left off.
  const handoffRef = useRef(debugPreview ? null : takeNoteHandoff(note.id));
  useEffect(() => {
    const handoff = handoffRef.current;
    if (!handoff) return;
    const frame = window.requestAnimationFrame(() => {
      handoffRef.current = null;
      if (handoff.focus === "title" && titleRef.current) {
        titleRef.current.focus();
        window.getSelection()?.selectAllChildren(titleRef.current);
        window.getSelection()?.collapseToEnd();
      } else if (handoff.focus === "content") {
        editorRef.current?.commands.focus("end");
      }
      if (handoff.ask) handleAskSubmit(handoff.ask);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [handleAskSubmit]);

  const handleChatInputFocus = useCallback(() => {
    if (chatMode === "hidden" && chatMessages.length > 0) {
      setChatMode("floating");
    }
  }, [chatMode, chatMessages.length]);

  const { dateFormat, timeFormat } = useDateTimePreferences();
  const noteDate = formatNoteDate(note.created_at, locale, dateFormat, timeFormat);
  const shortDate = formatShortDate(note.created_at, locale, dateFormat);

  return (
    <div className="relative flex h-full min-h-0">
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        <div className="@container mx-auto w-full max-w-[880px] px-[clamp(20px,5vw,54px)] max-[720px]:px-5 pt-5">
          {onBackToNotes && <button type="button" className="mb-6 inline-flex items-center gap-2 rounded text-xs text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus" onClick={onBackToNotes} aria-label={t("controlPanel.backToNotes")}><ArrowLeft size={16}/>{t("controlPanel.backToNotes")}</button>}
          <div
            dir="auto"
            ref={titleRef}
            contentEditable={canEditNote}
            suppressContentEditableWarning
            onInput={handleTitleInput}
            onKeyDown={handleTitleKeyDown}
            onPaste={handleTitlePaste}
            data-placeholder={t("notes.editor.untitled")}
            className="text-3xl font-semibold leading-tight text-foreground bg-transparent outline-none tracking-tight empty:before:content-[attr(data-placeholder)] empty:before:text-muted empty:before:pointer-events-none @max-[520px]:text-2xl"
            role="textbox"
            aria-label={t("notes.editor.noteTitle")}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <NoteParticipants
              noteId={note.id}
              participants={parsedParticipants}
              event={calendarEvent}
              dateLabel={shortDate || undefined}
              dateTitle={noteDate}
              preview={Boolean(debugPreview)}
            />
            {folders && onMoveToFolder && !canMoveToFolders && folderName && (
              <span className={cn(NOTE_META_CHIP_CLASS, "cursor-default")}>
                <FolderOpen size={14} className="shrink-0 text-muted" />
                <span dir="auto">{folderName}</span>
              </span>
            )}
            {folders && onMoveToFolder && canMoveToFolders && (
              <Popover
                open={folderMenuOpen}
                onOpenChange={(open) => {
                  setFolderMenuOpen(open);
                  if (!open) {
                    setFolderSearch("");
                    setIsCreatingFolder(false);
                    setNewFolderName("");
                  }
                }}
              >
                <PopoverTrigger asChild>
                  <button className={NOTE_META_CHIP_CLASS}>
                    <FolderOpen size={14} className="shrink-0 text-muted" />
                    {folderName ? <span dir="auto">{folderName}</span> : t("notes.editor.noFolder")}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-56 p-1">
                  {folders.length > 5 && (
                    <div className="relative mb-1 border-b border-border px-1.5 pb-1.5 pt-0.5">
                      <Search
                        size={12}
                        className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-muted"
                      />
                      <input
                        dir="auto"
                        autoFocus
                        value={folderSearch}
                        onChange={(e) => setFolderSearch(e.target.value)}
                        placeholder={t("notes.context.searchFolders")}
                        className="input-inline w-full appearance-none border-none py-1 ps-6 pe-1 text-xs text-foreground outline-none placeholder:text-muted"
                      />
                    </div>
                  )}
                  <div className="max-h-48 overflow-y-auto">
                    {filteredFolders.map((folder) => {
                      const isCurrent = folder.id === note.folder_id;
                      return (
                        <button
                          key={folder.id}
                          type="button"
                          disabled={isCurrent}
                          onClick={() => {
                            onMoveToFolder(note.id, folder.id);
                            setFolderMenuOpen(false);
                          }}
                          className={cn(MENU_ITEM_CLASS, "w-full gap-2 text-xs disabled:opacity-100")}
                        >
                          <FolderOpen size={14} className="shrink-0 text-muted" />
                          <span dir="auto" className="flex-1 truncate text-start">
                            {defaultFolderDisplayName(folder, t)}
                          </span>
                          {isCurrent && <Check size={12} className="shrink-0 text-primary" />}
                        </button>
                      );
                    })}
                    {folderSearch && filteredFolders.length === 0 && (
                      <p className="py-1.5 text-center text-xs text-muted">{t("notes.context.noResults")}</p>
                    )}
                  </div>
                  {onCreateFolderAndMove && (
                    <div className="mt-1 border-t border-border pt-1">
                      {isCreatingFolder ? (
                        <input
                          dir="auto"
                          autoFocus
                          value={newFolderName}
                          onChange={(e) => setNewFolderName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && newFolderName.trim()) {
                              onCreateFolderAndMove(note.id, newFolderName.trim());
                              setNewFolderName("");
                              setIsCreatingFolder(false);
                              setFolderMenuOpen(false);
                            }
                            if (e.key === "Escape") {
                              e.stopPropagation();
                              setIsCreatingFolder(false);
                              setNewFolderName("");
                            }
                          }}
                          placeholder={t("notes.folders.folderName")}
                          className="input-inline w-full appearance-none rounded-md border-none bg-transparent px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => setIsCreatingFolder(true)}
                          className={cn(MENU_ITEM_CLASS, "w-full gap-2 text-xs text-muted")}
                        >
                          <Plus size={14} />
                          {t("notes.context.newFolder")}
                        </button>
                      )}
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            )}
            {isSaving && (
              <span className="inline-flex items-center gap-1 text-xs text-muted tabular-nums">
                <Loader2 size={10} className="animate-spin" />
                {t("notes.editor.saving")}
              </span>
            )}
          </div>

        </div>


        <div className="flex-1 relative min-h-0 flex flex-col">
          <div ref={contentScrollRef} className="flex-1 min-h-0 overflow-y-auto agent-chat-scroll">
            <MeetingResultsPanel
              capturePhase={capturePhase}
              notice={captureLive ? (
                <CaptureHealthLine micStatus={micCaptureStatus} systemStatus={systemCaptureStatus} />
              ) : capturePhase === "failed" ? (
                <NoteNotice
                  status="danger"
                  title={t("notes.editor.capture.failed")}
                  description={t("notes.editor.capture.failedReason")}
                  actions={<HeroButton size="sm" variant="secondary" onPress={() => openSettings("recording")}>{t("meetingResults.openSettings")}</HeroButton>}
                />
              ) : null}
              actions={<div className="flex flex-wrap items-center gap-1.5">
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
            </div>}
              noteId={note.id}
              locale={locale}
              previewRecordings={debugPreview?.recordings}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              fallbackText={{
                raw: htmlToPlainText(note.content),
                enhanced: enhancement ? htmlToPlainText(enhancement.content) : "",
                transcript: note.transcript ?? "",
              }}
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
              /> : <EmptyStateCard icon={Sparkles} title={t("notes.editor.summaryEmptyTitle")} description={t(canGenerateSummary ? "notes.editor.summaryReadyDescription" : "notes.editor.summaryEmptyDescription")} className="mt-2">
                {canGenerateSummary && <Button size="sm" onClick={() => {
                  onGenerateSummary?.();
                  if (debugPreview) setViewMode("enhanced");
                }}>
                  <AlignLeft size={16} />
                  {t("notes.editor.generateSummary")}
                </Button>}
              </EmptyStateCard>}
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
          <NoteFindBar open={findOpen} onClose={() => setFindOpen(false)} containerRef={contentScrollRef} />
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
            hideInput={chatMode !== "hidden"}
          />
          {chatMode === "floating" && (
            <ChatPanel mode="floating" floatingPanelRef={floatingChatPanelRef} {...chatPanelProps} />
          )}
        </div>
      </div>
      {chatMode === "sidebar" && <ChatPanel mode="sidebar" {...chatPanelProps} />}
    </div>
  );
}
