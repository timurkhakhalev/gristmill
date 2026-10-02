import React, { useState } from "react";
import { Home, Settings, Sparkles, Upload } from "./icons";
import { useTranslation } from "react-i18next";
import { cn } from "./lib/utils";
import { GristmillLogo } from "./ui/GristmillLogo";
import ActionManagerDialog from "./notes/ActionManagerDialog";
import SpacesTree from "./notes/SpacesTree";
import { useNotesTreeActions } from "../hooks/useNotesTreeActions";
import type { ControlPanelView } from "./controlPanelNav";

const rowIconClass =
  "shrink-0 text-foreground/70 group-hover:text-foreground/90 dark:text-foreground/65 dark:group-hover:text-foreground/85 transition-colors duration-150";
const rowLabelClass =
  "text-ui text-foreground/90 group-hover:text-foreground dark:text-foreground/85 dark:group-hover:text-foreground transition-colors duration-150";
const rowButtonClass =
  "group flex items-center gap-2.5 w-full h-8 px-2.5 rounded-md text-start outline-none hover:bg-default dark:hover:bg-white/4 focus-visible:ring-1 focus-visible:ring-primary/30 transition-colors duration-150";

interface ControlPanelSidebarProps {
  activeView: ControlPanelView;
  onViewChange: (view: ControlPanelView) => void;
  onOpenSettings: () => void;
  /** Inline width in px; the drawer keeps the default. */
  width?: number;
}

/** The single app sidebar: Home and the notes tree on top, Upload file and
 * Settings at the bottom. Dictionary and integrations live in the settings modal. */
export default function ControlPanelSidebar({
  activeView,
  onViewChange,
  onOpenSettings,
  width = 192,
}: ControlPanelSidebarProps) {
  const { t } = useTranslation();
  const [showActionManager, setShowActionManager] = useState(false);
  const {
    handleDelete,
    handleMoveNote,
    handleCreateFolderAndMove,
    handleNewNoteIn,
  } = useNotesTreeActions();

  return (
    <div className="flex h-full shrink-0 flex-col bg-surface-window" style={{ width }}>
      <div
        className="h-11 w-full shrink-0"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />

      <div className="px-4.5 pb-1 shrink-0">
        <GristmillLogo />
      </div>

      <div className="space-y-0.5 px-2 pt-2 pb-1 shrink-0">
        <button
          onClick={() => onViewChange("home")}
          aria-current={activeView === "home" ? "page" : undefined}
          className={cn(rowButtonClass, activeView === "home" && "bg-primary/8 dark:bg-primary/10")}
        >
          <Home size={16} className={rowIconClass} />
          <span className={rowLabelClass}>{t("sidebar.home")}</span>
        </button>
        <button
          onClick={() => setShowActionManager(true)}
          className={cn(
            "flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md text-xs",
            "text-foreground/85 hover:text-foreground hover:bg-default",
            "transition-colors duration-150",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-focus"
          )}
        >
          <Sparkles size={14} className="shrink-0" />
          {t("notes.sidebar.actions")}
        </button>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        <SpacesTree
          onDeleteNote={handleDelete}
          onMoveNote={handleMoveNote}
          onCreateFolderAndMove={handleCreateFolderAndMove}
          onNewNote={handleNewNoteIn}
          onNavigate={() => onViewChange("personal-notes")}
        />
      </div>

      <div className="space-y-0.5 px-2 pt-2 pb-2 shrink-0">
        <button
          onClick={() => onViewChange(activeView === "upload" ? "home" : "upload")}
          title={t("sidebar.upload")}
          aria-label={t("sidebar.upload")}
          aria-pressed={activeView === "upload"}
          className={cn(
            rowButtonClass,
            activeView === "upload" && "bg-primary/8 dark:bg-primary/10"
          )}
        >
          <Upload size={16} className={rowIconClass} />
          <span className={rowLabelClass}>{t("sidebar.upload")}</span>
        </button>
        <button
          onClick={onOpenSettings}
          aria-label={t("sidebar.settings")}
          className={rowButtonClass}
          title={t("sidebar.settings")}
        >
          <Settings size={16} className={rowIconClass} />
          <span className={rowLabelClass}>{t("sidebar.settings")}</span>
        </button>
      </div>

      <ActionManagerDialog open={showActionManager} onOpenChange={setShowActionManager} />
    </div>
  );
}
