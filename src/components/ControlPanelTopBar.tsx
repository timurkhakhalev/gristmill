import React from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, PanelLeftClose, Search } from "./icons";
import { Button } from "./ui/button";
import WindowControls from "./WindowControls";
import { cn } from "./lib/utils";
import { getCachedPlatform } from "../utils/platform";
import type { NotesDebugScenario } from "./notes/NotesDebugControls";

const NotesDebugControls = (import.meta.env.DEV || import.meta.env.VITE_OPENHERCULES_DEV_BUILD === "true")
  ? React.lazy(() => import("./notes/NotesDebugControls"))
  : null;

const platform = getCachedPlatform();

// Controls inside the drag region must opt out or the click starts a window drag.
const noDragStyle = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

const toggleIconClass =
  "text-muted group-hover:text-foreground/75 dark:text-muted dark:group-hover:text-foreground/65 transition-colors duration-150 rtl:scale-x-[-1]";

interface ControlPanelTopBarProps {
  title: string;
  showSidebarToggle: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenSearch: () => void;
  /** Meeting mode or a narrow window with an open note: sidebar hidden, back button shown. */
  isSidePanelLayout: boolean;
  /** Shift leading controls past macOS traffic lights when the sidebar column is gone. */
  insetTrafficLights: boolean;
  onExitSidePanel: () => void;
  notesDebugScenario: NotesDebugScenario | null;
  onNotesDebugScenarioChange: (scenario: NotesDebugScenario | null) => void;
  showNotesDebug: boolean;
}

export default function ControlPanelTopBar({
  title,
  showSidebarToggle,
  sidebarOpen,
  onToggleSidebar,
  onOpenSearch,
  isSidePanelLayout,
  insetTrafficLights,
  onExitSidePanel,
  notesDebugScenario,
  onNotesDebugScenarioChange,
  showNotesDebug,
}: ControlPanelTopBarProps) {
  const { t } = useTranslation();
  const clearTrafficLights = platform === "darwin" && insetTrafficLights;

  return (
    <header
      className={cn(
        // Search is a max-width child of a flexible column. A 340px grid track
        // ate the title and debug once the card dropped below ~560px.
        "@container grid h-12 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-border px-3 dark:border-white/10",
        "transition-[padding] duration-300 ease-out",
        clearTrafficLights && "ltr:ps-[76px]"
      )}
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <div className="flex min-w-0 items-center gap-2">
        {isSidePanelLayout ? (
          <Button
            variant="outline-flat"
            size="sm"
            onClick={onExitSidePanel}
            aria-label={t("controlPanel.backToNotes")}
            className="h-7 gap-1 px-2.5 ps-1.5"
            data-no-window-drag=""
            style={noDragStyle}
          >
            <ChevronLeft size={14} strokeWidth={1.8} className="rtl:rotate-180" />
            <span className="@max-[480px]:hidden">{t("controlPanel.backToNotes")}</span>
          </Button>
        ) : (
          <>
            {showSidebarToggle && (
              <button
                type="button"
                onClick={onToggleSidebar}
                aria-label={sidebarOpen ? t("sidebar.collapse") : t("sidebar.expand")}
                aria-expanded={sidebarOpen}
                data-no-window-drag=""
                style={noDragStyle}
                className="group relative z-40 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg outline-none transition-colors duration-150 hover:bg-default focus-visible:ring-1 focus-visible:ring-primary/30 dark:hover:bg-white/5"
              >
                <PanelLeftClose size={16} className={toggleIconClass} />
              </button>
            )}
            {/* Global h1 styles are display-sized; this is chrome, so pin it down. */}
            <h1 className="truncate text-sm font-medium leading-none tracking-normal text-foreground @max-[420px]:hidden">
              {title}
            </h1>
          </>
        )}
      </div>

      {!isSidePanelLayout && (
        <button
          type="button"
          onClick={onOpenSearch}
          data-no-window-drag=""
          style={noDragStyle}
          aria-label={t("commandSearch.placeholder")}
          className="flex h-8 w-full max-w-[340px] items-center gap-2.5 justify-self-center rounded-full bg-default px-4 text-start outline-none transition-colors duration-150 hover:bg-default focus-visible:ring-1 focus-visible:ring-primary/30 dark:bg-white/5 dark:hover:bg-white/8 @max-[560px]:w-8 @max-[560px]:max-w-8 @max-[560px]:justify-self-end @max-[560px]:gap-0 @max-[560px]:px-0 @max-[560px]:justify-center"
        >
          <Search size={14} className="shrink-0 text-muted" />
          <span className="flex-1 truncate text-ui text-muted @max-[560px]:hidden">
            {t("commandSearch.placeholder")}
          </span>
          <kbd
            dir="ltr"
            className="shrink-0 rounded-full bg-default px-1.5 py-px font-sans text-2xs font-medium text-muted dark:bg-white/8 @max-[560px]:hidden"
          >
            {platform === "darwin" ? "⌘ + K" : "Ctrl + K"}
          </kbd>
        </button>
      )}

      <div className="flex items-center justify-self-end">
        {showNotesDebug && NotesDebugControls && (
          <div data-no-window-drag="" style={noDragStyle}>
            <React.Suspense fallback={null}>
              <NotesDebugControls scenario={notesDebugScenario} onChange={onNotesDebugScenarioChange} />
            </React.Suspense>
          </div>
        )}
        {platform !== "darwin" && (
          <div data-no-window-drag="" style={noDragStyle}>
            <WindowControls />
          </div>
        )}
      </div>
    </header>
  );
}
