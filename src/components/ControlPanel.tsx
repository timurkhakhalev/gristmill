import React, { Suspense, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ControlPanelSidebar from "./ControlPanelSidebar";
import ControlPanelTopBar from "./ControlPanelTopBar";
import { useControlPanelNavItems, type ControlPanelView } from "./controlPanelNav";
import MeetingRecordingMount from "./MeetingRecordingMount";
import MeetingRecordingPill from "./notes/MeetingRecordingPill";
import { useCollapsibleSidebar } from "../hooks/useCollapsibleSidebar";
import { useIsMeetingMode, useIsNarrowWindow, useMeetingRecordingStore } from "../stores/meetingRecordingStore";
import {
  initializeNotes,
  navigateToContainer,
  setActiveFolderId,
  setActiveNoteId,
  useActiveNoteId,
} from "../stores/noteStore";
import { useSettingsStore } from "../stores/settingsStore";
import BackgroundActionToastListener from "./notes/BackgroundActionToastListener";

const SIDEBAR_WIDTH_PX = 192;

const SettingsModal = React.lazy(() => import("./SettingsModal"));
const PersonalNotesView = React.lazy(() => import("./notes/PersonalNotesView"));
const DictionaryView = React.lazy(() => import("./DictionaryView"));
const UploadAudioView = React.lazy(() => import("./notes/UploadAudioView"));
const IntegrationsView = React.lazy(() => import("./IntegrationsView"));
const CommandSearch = React.lazy(() => import("./CommandSearch"));

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
  const [meetingRecordingRequest, setMeetingRecordingRequest] = useState<{
    noteId: number;
    folderId: number;
    event: any;
  } | null>(null);
  const isMeetingMode = useIsMeetingMode();
  const isNarrowWindow = useIsNarrowWindow();
  const activeNoteId = useActiveNoteId();
  const recordingNoteId = useMeetingRecordingStore((state) => state.recordingNoteId);
  const recordingFolderId = useMeetingRecordingStore((state) => state.recordingFolderId);
  const {
    collapsed: sidebarCollapsed,
    peek: sidebarPeek,
    toggle: toggleSidebar,
    showPeek,
    hidePeek,
    leaveToggle,
  } = useCollapsibleSidebar();
  const isSidePanelLayout =
    isMeetingMode || (isNarrowWindow && activeView === "personal-notes" && activeNoteId != null);

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

  const handleExitSidePanel = useCallback(() => {
    if (isMeetingMode) window.electronAPI?.restoreFromMeetingMode?.();
    else setActiveNoteId(null);
  }, [isMeetingMode]);

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
          className="shrink-0 transition-[width] duration-300 ease-out"
          style={{ width: sidebarCollapsed || isSidePanelLayout ? 0 : SIDEBAR_WIDTH_PX }}
        />
        <div
          className={`absolute inset-y-0 start-0 z-30 transition-transform duration-300 ease-out ${
            !isSidePanelLayout && (!sidebarCollapsed || sidebarPeek)
              ? "translate-x-0"
              : "ltr:-translate-x-full rtl:translate-x-full"
          }`}
          onMouseEnter={sidebarCollapsed ? showPeek : undefined}
          onMouseLeave={sidebarCollapsed ? hidePeek : undefined}
        >
          <ControlPanelSidebar
            activeView={activeView}
            onViewChange={setActiveView}
            onOpenSettings={() => openSettings()}
          />
        </div>
        <main className="flex-1 flex flex-col overflow-hidden p-2">
          <div className="flex min-h-0 flex-1 flex-col overflow-clip rounded-(--radius-shell) border border-border bg-background dark:border-white/10">
            <ControlPanelTopBar
              title={navItems.find((item) => item.id === activeView)?.label ?? t("sidebar.notes")}
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={toggleSidebar}
              onToggleMouseEnter={sidebarCollapsed ? showPeek : undefined}
              onToggleMouseLeave={sidebarCollapsed ? leaveToggle : undefined}
              onOpenSearch={() => setShowSearch(true)}
              isSidePanelLayout={isSidePanelLayout}
              onExitSidePanel={handleExitSidePanel}
            />
            <div className="scrollbar-hidden flex-1 overflow-y-auto">
              {activeView === "personal-notes" && (
                <Suspense fallback={null}>
                  <PersonalNotesView
                    onOpenSettings={openSettings}
                    meetingRecordingRequest={meetingRecordingRequest}
                    onMeetingRecordingRequestHandled={() => setMeetingRecordingRequest(null)}
                  />
                </Suspense>
              )}
              {activeView === "dictionary" && (
                <Suspense fallback={null}>
                  <DictionaryView />
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
              {activeView === "integrations" && (
                <Suspense fallback={null}>
                  <IntegrationsView />
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
