import React, { Suspense, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ControlPanelSidebar from "./ControlPanelSidebar";
import ControlPanelNavDrawer from "./ControlPanelNavDrawer";
import ControlPanelTopBar from "./ControlPanelTopBar";
import { useControlPanelNavItems, type ControlPanelView } from "./controlPanelNav";
import MeetingRecordingMount from "./MeetingRecordingMount";
import MeetingRecordingPill from "./notes/MeetingRecordingPill";
import { useCollapsibleSidebar } from "../hooks/useCollapsibleSidebar";
import { useIsMeetingMode, useMeetingRecordingStore } from "../stores/meetingRecordingStore";
import {
  initializeNotes,
  navigateToContainer,
  setActiveFolderId,
  setActiveNoteId,
  useActiveNoteId,
} from "../stores/noteStore";
import { useSettingsStore } from "../stores/settingsStore";
import BackgroundActionToastListener from "./notes/BackgroundActionToastListener";
import type { NotesDebugScenario } from "./notes/NotesDebugControls";
import { onOpenSettingsRequest } from "../utils/openSettings";

const SIDEBAR_WIDTH_PX = 192;

const SettingsModal = React.lazy(() => import("./SettingsModal"));
const PersonalNotesView = React.lazy(() => import("./notes/PersonalNotesView"));
const UploadAudioView = React.lazy(() => import("./notes/UploadAudioView"));
const CommandSearch = React.lazy(() => import("./CommandSearch"));
const NotesDebugPreview = (import.meta.env.DEV || import.meta.env.VITE_OPENHERCULES_DEV_BUILD === "true")
  ? React.lazy(() => import("./notes/NotesDebugPreview"))
  : null;

interface ControlPanelProps {
  initialSettingsSection?: string;
}

/** The durable app shell. Notes is the only start view; recording remains a
 * separate service mounted for every view so meeting capture can continue while
 * the user browses dictionaries, uploads, or integrations. */
export default function ControlPanel({ initialSettingsSection }: ControlPanelProps = {}) {
  const { t } = useTranslation();
  const navItems = useControlPanelNavItems();
  const [activeView, setActiveView] = useState<ControlPanelView>("personal-notes");
  const [showSettings, setShowSettings] = useState(Boolean(initialSettingsSection));
  const [settingsSection, setSettingsSection] = useState(initialSettingsSection);
  const [showSearch, setShowSearch] = useState(false);
  const [notesDebugScenario, setNotesDebugScenario] = useState<NotesDebugScenario | null>(null);
  const [meetingRecordingRequest, setMeetingRecordingRequest] = useState<{
    noteId: number;
    folderId: number;
    event: any;
  } | null>(null);
  const isMeetingMode = useIsMeetingMode();
  const activeNoteId = useActiveNoteId();
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

  const handleExitSidePanel = useCallback(() => {
    if (isMeetingMode) window.electronAPI?.restoreFromMeetingMode?.();
    if (notesDebugScenario) setNotesDebugScenario(null);
    else setActiveNoteId(null);
  }, [isMeetingMode, notesDebugScenario]);

  return (
    <div className="h-screen bg-surface-window flex flex-col">
      <MeetingRecordingMount />
      <MeetingRecordingPill
        activeView={activeView}
        activeNoteId={activeNoteId}
        onReturnToNote={() => {
          setActiveView("personal-notes");
          setActiveFolderId(recordingFolderId);
          setActiveNoteId(recordingNoteId);
        }}
      />
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
          className="shrink-0 overflow-hidden transition-[width] duration-300 ease-out"
          style={{ width: sidebarInline ? SIDEBAR_WIDTH_PX : 0 }}
        >
          {sidebarInline && (
            <ControlPanelSidebar
              activeView={activeView}
              onViewChange={setActiveView}
              onOpenSettings={() => openSettings()}
            />
          )}
        </div>
        {narrow && !isSidePanelLayout && (
          <ControlPanelNavDrawer open={drawerOpen} onClose={closeSidebarDrawer}>
            <ControlPanelSidebar
              activeView={activeView}
              onViewChange={(view) => {
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
              isSidePanelLayout={isSidePanelLayout}
              insetTrafficLights={!sidebarInline}
              onExitSidePanel={handleExitSidePanel}
              notesDebugScenario={notesDebugScenario}
              onNotesDebugScenarioChange={setNotesDebugScenario}
              showNotesDebug={activeView === "personal-notes"}
            />
            <div className="scrollbar-hidden flex-1 overflow-y-auto">
              {activeView === "personal-notes" && (
                <Suspense fallback={null}>
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
            setActiveNoteId(id);
            setActiveView("personal-notes");
          }}
          onContainerSelect={(spaceId, folderId) => {
            navigateToContainer(spaceId, folderId);
            setActiveView("personal-notes");
          }}
        />
      </Suspense>
      <BackgroundActionToastListener />
    </div>
  );
}
