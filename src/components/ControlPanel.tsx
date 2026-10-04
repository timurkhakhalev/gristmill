import React, { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { EventDraftHandoff } from "../lib/noteEditorPendingSave";
import { useTranslation } from "react-i18next";
import { cn } from "./lib/utils";
import ControlPanelSidebar from "./ControlPanelSidebar";
import ControlPanelNavDrawer from "./ControlPanelNavDrawer";
import ControlPanelTopBar from "./ControlPanelTopBar";
import { useControlPanelNavItems, type ControlPanelView } from "./controlPanelNav";
import MeetingRecordingMount from "./MeetingRecordingMount";
import MeetingRecordingPill from "./notes/MeetingRecordingPill";
import EventNoteDraft from "./notes/EventNoteDraft";
import type { CalendarEvent } from "../contracts/calendar";
import type { NoteItem } from "../contracts/notes";
import { useCollapsibleSidebar } from "../hooks/useCollapsibleSidebar";
import { useIsMeetingMode, useMeetingRecordingStore } from "../stores/meetingRecordingStore";
import {
  createFolder,
  initializeNotes,
  initializeNotesTree,
  navigateToContainer,
  openNoteRow,
  setActiveFolderId,
  setActiveNoteId,
  useActiveContext,
  useActiveNoteId,
  useNotes,
  useSpaces,
} from "../stores/noteStore";
import { useNotesTreeActions } from "../hooks/useNotesTreeActions";
import { useSettingsStore } from "../stores/settingsStore";
import { useToast } from "./ui/useToast";
import BackgroundActionToastListener from "./notes/BackgroundActionToastListener";
import type { NotesDebugScenario } from "./notes/NotesDebugControls";
import { onOpenSettingsRequest } from "../utils/openSettings";
import { resolveAppShortcut } from "../utils/appShortcuts";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { HomeSkeleton } from "./home/HomeSkeleton";
import NoteSkeleton from "./notes/NoteSkeleton";
import { localMutationErrorKey } from "../lib/localMutationError";

const SIDEBAR_DEFAULT_WIDTH_PX = 192;
const SIDEBAR_MIN_WIDTH_PX = 176;
const SIDEBAR_MAX_WIDTH_PX = 320;
const SIDEBAR_WIDTH_KEY = "gristmill.sidebarWidth";

const clampSidebarWidth = (value: number) =>
  Math.min(SIDEBAR_MAX_WIDTH_PX, Math.max(SIDEBAR_MIN_WIDTH_PX, Math.round(value)));

function readSidebarWidth(): number {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampSidebarWidth(stored) : SIDEBAR_DEFAULT_WIDTH_PX;
}

const SettingsModal = React.lazy(() => import("./SettingsModal"));
const HomeView = React.lazy(() => import("./home/HomeView"));
const PersonalNotesView = React.lazy(() => import("./notes/PersonalNotesView"));
const UploadAudioView = React.lazy(() => import("./notes/UploadAudioView"));
const CommandSearch = React.lazy(() => import("./CommandSearch"));
const KeyboardShortcutsDialog = React.lazy(() => import("./KeyboardShortcutsDialog"));
const NotesDebugPreview = (import.meta.env.DEV || import.meta.env.VITE_GRISTMILL_DEV_BUILD === "true")
  ? React.lazy(() => import("./notes/NotesDebugPreview"))
  : null;

interface ControlPanelProps {
  initialSettingsSection?: string;
}

/** The durable app shell. Home is the start view; recording remains a
 * separate service mounted for every view so meeting capture can continue while
 * the user browses dictionaries, uploads, or integrations. */
export default function ControlPanel({ initialSettingsSection }: ControlPanelProps = {}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const navItems = useControlPanelNavItems();
  const { handleNewNote, startRecordingForNote } = useNotesTreeActions();
  // A calendar event opened before it has a note (see EventNoteDraft).
  const [eventDraft, setEventDraft] = useState<CalendarEvent | null>(null);
  const spaces = useSpaces();
  const activeContext = useActiveContext();
  const containerNotes = useNotes();
  const [requestedView, setActiveView] = useState<ControlPanelView>("home");
  const [showSettings, setShowSettings] = useState(Boolean(initialSettingsSection));
  const [settingsSection, setSettingsSection] = useState(initialSettingsSection);
  const [showSearch, setShowSearch] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [newFolderDialogOpen, setNewFolderDialogOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [notesDebugScenario, setNotesDebugScenario] = useState<NotesDebugScenario | null>(null);
  const [meetingRecordingRequest, setMeetingRecordingRequest] = useState<{
    noteId: number;
    folderId: null | number;
    event: any;
  } | null>(null);
  // A calendar-event draft's latest typed revision, forwarded to the notes
  // view once it owns the created/existing note (see EventNoteDraft). The
  // draft hands off before the view mounts, so the value waits in a ref the
  // mounted view consumes once.
  const pendingEventDraftHandoffRef = useRef<EventDraftHandoff | null>(null);
  const handleEventDraftHandoff = useCallback((handoff: EventDraftHandoff) => {
    pendingEventDraftHandoffRef.current = handoff;
  }, []);
  const isMeetingMode = useIsMeetingMode();
  const activeNoteId = useActiveNoteId();
  // Notes has no list page of its own: with no note open, Home is the list.
  // Derived during render so closing a note never paints an empty Notes frame.
  const activeView: ControlPanelView =
    requestedView === "personal-notes" && activeNoteId == null && notesDebugScenario == null
      ? "home"
      : requestedView;
  const recordingNoteId = useMeetingRecordingStore((state) => state.recordingNoteId);
  const recordingFolderId = useMeetingRecordingStore((state) => state.recordingFolderId);
  const {
    narrow,
    drawerOpen,
    toggle: toggleSidebar,
    close: closeSidebarDrawer,
  } = useCollapsibleSidebar();
  const noteSurfaceOpen =
    activeView === "personal-notes" &&
    (activeNoteId != null ||
      (notesDebugScenario != null &&
        notesDebugScenario !== "onboarding" &&
        notesDebugScenario !== "empty"));
  const isSidePanelLayout = isMeetingMode || (narrow && noteSurfaceOpen);
  const sidebarInline = !narrow && !isSidePanelLayout;
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const sidebarDrag = React.useRef<{ startX: number; startWidth: number } | null>(null);
  const onSidebarResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = sidebarDrag.current;
    if (!drag) return;
    // Mirrored in RTL, where the sidebar sits on the right.
    const delta = document.dir === "rtl" ? drag.startX - e.clientX : e.clientX - drag.startX;
    setSidebarWidth(clampSidebarWidth(drag.startWidth + delta));
  };
  const onSidebarResizeEnd = () => {
    if (!sidebarDrag.current) return;
    sidebarDrag.current = null;
    setResizingSidebar(false);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  };

  useEffect(() => {
    if (requestedView !== activeView) setActiveView(activeView);
  }, [requestedView, activeView]);

  // The sidebar tree renders on every view, not only inside the notes view.
  useEffect(() => {
    void initializeNotesTree();
  }, []);

  useEffect(() => {
    const drainMeeting = async () => {
      const data = await window.electronAPI?.getPendingMeetingNoteNavigation?.();
      if (!data) return;
      setActiveFolderId(data.folderId);
      setActiveNoteId(data.noteId);
      setActiveView("personal-notes");
      setMeetingRecordingRequest({ noteId: data.noteId, folderId: data.folderId, event: data.event });
      initializeNotes(null, 50, data.folderId);
      if (
        data.trigger === "hotkey" &&
        useSettingsStore.getState().meetingHotkeyLayoutMode === "side-panel" &&
        window.electronAPI?.snapToMeetingMode
      ) {
        window.electronAPI.snapToMeetingMode();
      }
    };
    void drainMeeting();
    const dispose = window.electronAPI?.onMeetingNoteNavigationPending?.(drainMeeting);
    return () => dispose?.();
  }, []);

  useEffect(() => {
    const drainNote = async () => {
      const data = await window.electronAPI?.getPendingNoteNavigation?.();
      if (!data) return;
      if (data.folderId != null) {
        setActiveFolderId(data.folderId);
        initializeNotes(null, 50, data.folderId);
      }
      setActiveNoteId(data.noteId);
      setActiveView("personal-notes");
    };
    void drainNote();
    const dispose = window.electronAPI?.onNoteNavigationPending?.(drainNote);
    return () => dispose?.();
  }, []);

  useEffect(() => {
    const dispose = window.electronAPI?.onShowSettings?.(() => setShowSettings(true));
    return () => dispose?.();
  }, []);

  const createAndOpenNote = useCallback(async () => {
    const note = await handleNewNote();
    if (note) {
      setNotesDebugScenario(null);
      setActiveView("personal-notes");
    }
  }, [handleNewNote]);

  useEffect(() => {
    const dispose = window.electronAPI?.onTrayNewNote?.(() => void createAndOpenNote());
    return () => dispose?.();
  }, [createAndOpenNote]);

  const openNote = useCallback((note: NoteItem) => {
    if (note.folder_id != null) setActiveFolderId(note.folder_id);
    else navigateToContainer(note.space_id, null);
    // Hold the full row: search/chat results can sit outside the newest-50
    // container caches, and the editor needs the row, not just the id (#185).
    void openNoteRow(note);
    setActiveView("personal-notes");
  }, []);

  // An event with a note opens it; one without opens a draft that creates
  // the note only once the user writes, records or asks.
  const openCalendarEvent = useCallback(
    async (event: CalendarEvent) => {
      const existing = await window.electronAPI.findCalendarEventNote?.(event.id);
      const note = existing ? await window.electronAPI.getNote(existing.noteId) : null;
      if (note) openNote(note);
      else setEventDraft(event);
    },
    [openNote]
  );

  useEffect(() => {
    const dispose = window.electronAPI?.onTrayOpenEvent?.((event) => {
      setActiveView("home");
      void openCalendarEvent(event);
    });
    return () => dispose?.();
  }, [openCalendarEvent]);

  // Leaving Home or opening any note drops the draft.
  useEffect(() => {
    if (activeView !== "home") setEventDraft(null);
  }, [activeView]);
  useEffect(() => {
    setEventDraft(null);
  }, [activeNoteId]);

  const openSettings = useCallback((section?: string) => {
    setSettingsSection(section);
    setShowSettings(true);
  }, []);

  useEffect(() => onOpenSettingsRequest(openSettings), [openSettings]);

  useEffect(() => {
    if (isSidePanelLayout) closeSidebarDrawer();
  }, [isSidePanelLayout, closeSidebarDrawer]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSidebarDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen, closeSidebarDrawer]);

  const goToAdjacentNote = useCallback(
    (delta: number) => {
      if (containerNotes.length === 0) return;
      const index = containerNotes.findIndex((note) => note.id === activeNoteId);
      const next = index === -1 ? (delta > 0 ? 0 : containerNotes.length - 1) : index + delta;
      if (next < 0 || next >= containerNotes.length) return;
      setActiveView("personal-notes");
      setActiveNoteId(containerNotes[next].id);
    },
    [containerNotes, activeNoteId]
  );

  const submitNewFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name || !activeContext) return;
    setNewFolderDialogOpen(false);
    setNewFolderName("");
    const result = await createFolder(name, activeContext.spaceId);
    if (!result.success && result.error) {
      toast({
        title: t("notes.folders.couldNotCreate"),
        description: t(localMutationErrorKey(result.error)),
        variant: "destructive",
      });
    }
  }, [newFolderName, activeContext, toast, t]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (showSettings) return;
      const shortcut = resolveAppShortcut(event);
      if (!shortcut) return;
      event.preventDefault();
      switch (shortcut) {
        case "search":
          setShowSearch((open) => !open);
          break;
        case "settings":
          openSettings();
          break;
        case "new-note":
          void createAndOpenNote();
          break;
        case "new-folder":
          if (spaces.length > 0) setNewFolderDialogOpen(true);
          break;
        case "next-note":
          goToAdjacentNote(1);
          break;
        case "prev-note":
          goToAdjacentNote(-1);
          break;
        case "view-notes":
          setActiveView("personal-notes");
          break;
        case "view-upload":
          setActiveView("upload");
          break;
        case "shortcuts-help":
          setShowShortcuts((open) => !open);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSettings, openSettings, createAndOpenNote, spaces.length, goToAdjacentNote]);

  const handleExitSidePanel = useCallback(() => {
    if (isMeetingMode) window.electronAPI?.restoreFromMeetingMode?.();
    if (notesDebugScenario) setNotesDebugScenario(null);
    else setActiveNoteId(null);
  }, [isMeetingMode, notesDebugScenario]);

  return (
    <div className="h-screen bg-surface-window flex flex-col">
      <MeetingRecordingMount />
      {showSettings && (
        <Suspense fallback={null}>
          <SettingsModal
            open={showSettings}
            onOpenChange={(open) => {
              setShowSettings(open);
              if (!open) setSettingsSection(undefined);
            }}
            initialSection={settingsSection}
          />
        </Suspense>
      )}

      <div className="flex flex-1 overflow-hidden relative">
        <div
          className={cn("relative shrink-0 overflow-hidden", !resizingSidebar && "transition-[width] duration-300 ease-out")}
          style={{ width: sidebarInline ? sidebarWidth : 0 }}
        >
          {sidebarInline && (
            <ControlPanelSidebar
              width={sidebarWidth}
              activeView={activeView}
              onViewChange={(view) => {
                setEventDraft(null);
                setActiveView(view);
              }}
              onOpenSettings={() => openSettings()}
            />
          )}
        </div>
        {sidebarInline && (
          <div
              role="separator"
              aria-orientation="vertical"
              aria-valuemin={SIDEBAR_MIN_WIDTH_PX}
              aria-valuemax={SIDEBAR_MAX_WIDTH_PX}
              aria-valuenow={sidebarWidth}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                sidebarDrag.current = { startX: e.clientX, startWidth: sidebarWidth };
                setResizingSidebar(true);
              }}
              onPointerMove={onSidebarResizeMove}
              onPointerUp={onSidebarResizeEnd}
              onPointerCancel={onSidebarResizeEnd}
              onDoubleClick={() => {
                setSidebarWidth(SIDEBAR_DEFAULT_WIDTH_PX);
                localStorage.removeItem(SIDEBAR_WIDTH_KEY);
              }}
              style={{ insetInlineStart: sidebarWidth + 8 - 3 }}
              className="absolute inset-y-2 z-20 w-1.5 cursor-col-resize touch-none rounded-full transition-colors hover:bg-primary/20 active:bg-primary/30"
            />
          )}
        {narrow && !isSidePanelLayout && (
          <ControlPanelNavDrawer open={drawerOpen} onClose={closeSidebarDrawer}>
            <ControlPanelSidebar
              activeView={activeView}
              onViewChange={(view) => {
                setEventDraft(null);
                setActiveView(view);
                closeSidebarDrawer();
              }}
              onOpenSettings={() => {
                closeSidebarDrawer();
                openSettings();
              }}
            />
          </ControlPanelNavDrawer>
        )}
        <main className="flex-1 flex flex-col overflow-hidden p-2">
          <div className="flex min-h-0 flex-1 flex-col overflow-clip rounded-(--radius-shell) border border-border bg-background dark:border-white/10">
            <ControlPanelTopBar
              title={navItems.find((item) => item.id === activeView)?.label ?? t("sidebar.notes")}
              showSidebarToggle={narrow && !isSidePanelLayout}
              sidebarOpen={drawerOpen}
              onToggleSidebar={toggleSidebar}
              onOpenSearch={() => setShowSearch(true)}
              onNewNote={() => void createAndOpenNote()}
              isSidePanelLayout={isSidePanelLayout}
              insetTrafficLights={!sidebarInline}
              onExitSidePanel={handleExitSidePanel}
              notesDebugScenario={notesDebugScenario}
              onNotesDebugScenarioChange={setNotesDebugScenario}
              showNotesDebug={activeView === "personal-notes"}
              trailing={
                <MeetingRecordingPill
                  activeView={activeView}
                  activeNoteId={activeNoteId}
                  onReturnToNote={() => {
                    setActiveView("personal-notes");
                    setActiveFolderId(recordingFolderId);
                    setActiveNoteId(recordingNoteId);
                  }}
                />
              }
            />
            <div className="scrollbar-hidden flex-1 overflow-y-auto">
              {activeView === "home" && eventDraft && (
                <EventNoteDraft
                  key={eventDraft.id}
                  event={eventDraft}
                  onBack={() => setEventDraft(null)}
                  onDraftHandoff={handleEventDraftHandoff}
                  onMaterialized={(note, intent) => {
                    setEventDraft(null);
                    openNote(note);
                    if (intent === "record" && !useMeetingRecordingStore.getState().isRecording) {
                      void startRecordingForNote(note);
                    }
                  }}
                />
              )}
              {activeView === "home" && !eventDraft && (
                <Suspense fallback={<HomeSkeleton />}>
                  <HomeView
                    onOpenNote={openNote}
                    onConnectCalendar={() => openSettings("calendar")}
                    onOpenEvent={(event) => void openCalendarEvent(event)}
                  />
                </Suspense>
              )}
              {activeView === "personal-notes" && (
                <Suspense fallback={<NoteSkeleton />}>
                  {notesDebugScenario && NotesDebugPreview ? (
                    <NotesDebugPreview
                      key={notesDebugScenario}
                      scenario={notesDebugScenario}
                      onSelectScenario={setNotesDebugScenario}
                    />
                  ) : (
                    <PersonalNotesView
                      onOpenSettings={openSettings}
                      meetingRecordingRequest={meetingRecordingRequest}
                      onMeetingRecordingRequestHandled={() => setMeetingRecordingRequest(null)}
                      chromeProvidesBack={isSidePanelLayout}
                      eventDraftHandoff={pendingEventDraftHandoffRef}
                    />
                  )}
                </Suspense>
              )}
              {activeView === "upload" && (
                <Suspense fallback={null}>
                  <UploadAudioView
                    onNoteCreated={(noteId, folderId) => {
                      setActiveNoteId(noteId);
                      if (folderId != null) setActiveFolderId(folderId);
                      setActiveView("personal-notes");
                    }}
                    onOpenSettings={openSettings}
                  />
                </Suspense>
              )}
            </div>
          </div>
        </main>
      </div>
      <Suspense fallback={null}>
        <CommandSearch
          open={showSearch}
          onOpenChange={setShowSearch}
          onNoteSelect={(id, folderId, spaceId) => {
            if (folderId != null) setActiveFolderId(folderId);
            else if (spaceId != null) navigateToContainer(spaceId, null);
            // Search can surface Notes past the container caches (#185): the
            // row is held or fetched by id inside openNoteRow.
            void openNoteRow({ id } as NoteItem);
            setActiveView("personal-notes");
          }}
          onContainerSelect={(spaceId, folderId) => {
            navigateToContainer(spaceId, folderId);
            setActiveView("personal-notes");
          }}
        />
      </Suspense>
      <Suspense fallback={null}>
        <KeyboardShortcutsDialog open={showShortcuts} onOpenChange={setShowShortcuts} />
      </Suspense>
      <Dialog
        open={newFolderDialogOpen}
        onOpenChange={(open) => {
          setNewFolderDialogOpen(open);
          if (!open) setNewFolderName("");
        }}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t("notes.context.newFolder")}</DialogTitle>
          </DialogHeader>
          <Input
            dir="auto"
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            placeholder={t("notes.folders.folderName")}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitNewFolder();
            }}
          />
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setNewFolderDialogOpen(false);
                setNewFolderName("");
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void submitNewFolder()} disabled={!newFolderName.trim()}>
              {t("common.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <BackgroundActionToastListener />
    </div>
  );
}
