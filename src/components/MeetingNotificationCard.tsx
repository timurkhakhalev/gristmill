import { Mic, RotateCcw, Video, X } from "./icons";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { cn } from "./lib/utils";

export type MeetingNotificationIcon = "join" | "start" | "restart";

const ICONS = { join: Video, start: Mic, restart: RotateCcw } as const;

interface MeetingNotificationCardProps {
  title: string;
  body: string;
  startLabel: string;
  icon?: MeetingNotificationIcon;
  onStart?: () => void;
  onDismiss?: () => void;
  allowTitleWrap?: boolean;
  className?: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

/**
 * Presentational only — the live always-on-top overlay
 * (`MeetingNotificationOverlay`) layers slide animation, IPC and hover on top
 * via `className` and the handler props. One compact row: what's happening,
 * the one action, and a close button.
 */
export function MeetingNotificationCard({
  title,
  body,
  startLabel,
  icon = "start",
  onStart,
  onDismiss,
  allowTitleWrap = false,
  className,
  onMouseEnter,
  onMouseLeave,
}: MeetingNotificationCardProps) {
  const { t } = useTranslation();
  const Icon = ICONS[icon];
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-2xl border border-border bg-overlay py-1.5 ps-1.5 pe-1.5 text-overlay-foreground shadow-overlay",
        className
      )}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
        <Icon size={15} />
      </span>

      <div className="min-w-0 flex-1">
        <p
          dir="auto"
          className={cn(
            "text-[13px] font-medium leading-tight text-foreground",
            allowTitleWrap ? "whitespace-normal break-words" : "truncate"
          )}
        >
          {title}
        </p>
        <p
          className={cn(
            "mt-0.5 text-2xs leading-tight text-muted-foreground",
            allowTitleWrap ? "break-words" : "truncate"
          )}
        >
          {body}
        </p>
      </div>

      <Button size="sm" onClick={onStart} className="h-7 min-h-7 shrink-0 rounded-full px-3 text-xs">
        {startLabel}
      </Button>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("common.close")}
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-default hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus"
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}
