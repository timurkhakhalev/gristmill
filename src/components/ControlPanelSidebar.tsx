import React from "react";
import { Settings } from "./icons";
import { useTranslation } from "react-i18next";
import { cn } from "./lib/utils";
import { useControlPanelNavItems, type ControlPanelView } from "./controlPanelNav";

export type { ControlPanelView };

const rowIconClass =
  "shrink-0 text-foreground/70 group-hover:text-foreground/90 dark:text-foreground/65 dark:group-hover:text-foreground/85 transition-colors duration-150";
const rowLabelClass =
  "text-[13px] text-foreground/90 group-hover:text-foreground dark:text-foreground/85 dark:group-hover:text-foreground transition-colors duration-150";
const rowButtonClass =
  "group flex items-center gap-2.5 w-full h-8 px-2.5 rounded-md text-start outline-none hover:bg-foreground/4 dark:hover:bg-white/4 focus-visible:ring-1 focus-visible:ring-primary/30 transition-colors duration-150";

interface ControlPanelSidebarProps {
  activeView: ControlPanelView;
  onViewChange: (view: ControlPanelView) => void;
  onOpenSettings: () => void;
  collapsed: boolean;
}

export default function ControlPanelSidebar({
  activeView,
  onViewChange,
  onOpenSettings,
  collapsed,
}: ControlPanelSidebarProps) {
  const { t } = useTranslation();
  const navItems = useControlPanelNavItems();

  return (
    <div className={cn("h-full shrink-0 flex flex-col bg-surface-window", collapsed ? "w-[68px]" : "w-48")}>
      <div
        className="w-full h-10 shrink-0"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />

      <nav aria-label={t("sidebar.notes")} className="flex flex-col gap-0.5 px-2 pt-2 pb-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeView === item.id;

          return (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              title={item.label}
              aria-label={item.label}
              className={cn(
                "group relative flex items-center gap-2.5 w-full h-9 rounded-md outline-none transition-colors duration-150 text-start",
                collapsed ? "justify-center px-0" : "px-2.5",
                "focus-visible:ring-1 focus-visible:ring-primary/30",
                isActive
                  ? "bg-primary/8 dark:bg-primary/10"
                  : "hover:bg-foreground/4 dark:hover:bg-white/4 active:bg-foreground/6"
              )}
            >
              <Icon
                size={16}
                className={cn(
                  "shrink-0 transition-colors duration-150",
                  isActive
                    ? "text-primary"
                    : "text-foreground/70 group-hover:text-foreground/90 dark:text-foreground/65 dark:group-hover:text-foreground/85"
                )}
              />
              {!collapsed && <span
                className={cn(
                  "text-[13px] transition-colors duration-150",
                  isActive
                    ? "text-foreground font-medium"
                    : "text-foreground/90 group-hover:text-foreground dark:text-foreground/85 dark:group-hover:text-foreground"
                )}
              >
                {item.label}
              </span>}
            </button>
          );
        })}
      </nav>

      <div className="flex-1" />

      <div className="px-2 pb-2 space-y-0.5">
        <button
          onClick={onOpenSettings}
          aria-label={t("sidebar.settings")}
          className={cn(rowButtonClass, collapsed && "justify-center px-0")}
          title={t("sidebar.settings")}
        >
          <Settings size={16} className={rowIconClass} />
          {!collapsed && <span className={rowLabelClass}>{t("sidebar.settings")}</span>}
        </button>

        <div className="mx-1 h-px bg-border/10 dark:bg-white/6 my-1.5!" />

      </div>
    </div>
  );
}
