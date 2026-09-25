import React from "react";
import { Settings } from "./icons";
import { useTranslation } from "react-i18next";
import { cn } from "./lib/utils";
import { useControlPanelNavItems, type ControlPanelView } from "./controlPanelNav";

export type { ControlPanelView };

const rowIconClass =
  "shrink-0 text-foreground/70 group-hover:text-foreground/90 dark:text-foreground/65 dark:group-hover:text-foreground/85 transition-colors duration-150";
const rowLabelClass =
  "text-ui text-foreground/90 group-hover:text-foreground dark:text-foreground/85 dark:group-hover:text-foreground transition-colors duration-150";
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
    <div className={cn("h-full shrink-0 flex flex-col bg-surface-window", collapsed ? "w-20" : "w-48")}>
      <div
        className="w-full h-10 shrink-0"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />

      <nav aria-label={t("sidebar.notes")} className={cn("flex flex-col gap-0.5 pt-2 pb-2", collapsed ? "px-1" : "px-2")}>
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
                collapsed ? "flex-col justify-center gap-1 px-0 h-12" : "px-2.5",
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
              <span
                className={cn(
                  collapsed ? "max-w-full truncate text-2xs leading-tight" : "text-ui transition-colors duration-150",
                  isActive
                    ? "text-foreground font-medium"
                    : "text-foreground/90 group-hover:text-foreground dark:text-foreground/85 dark:group-hover:text-foreground"
                )}
              >
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>

      <div className="flex-1" />

      <div className={cn("pb-2 space-y-0.5", collapsed ? "px-1" : "px-2")}>
        <button
          onClick={onOpenSettings}
          aria-label={t("sidebar.settings")}
          className={cn(rowButtonClass, collapsed && "flex-col justify-center gap-1 h-12 px-0")}
          title={t("sidebar.settings")}
        >
          <Settings size={16} className={rowIconClass} />
          <span className={collapsed ? "max-w-full truncate text-2xs leading-tight text-foreground/90" : rowLabelClass}>{t("sidebar.settings")}</span>
        </button>

      </div>
    </div>
  );
}
