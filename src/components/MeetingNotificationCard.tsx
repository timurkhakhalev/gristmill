import { X } from "./icons";
import { useTranslation } from "react-i18next";
import { cn } from "./lib/utils";

interface MeetingNotificationCardProps {
  title: string;
  body: string;
  startLabel: string;
  onStart?: () => void;
  onDismiss?: () => void;
  allowTitleWrap?: boolean;
  /** Draws a shrinking bar along the bottom edge for this many milliseconds. */
  countdownMs?: number;
  className?: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

function GristmillMark({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 -20 512 500" width={size} height={size} aria-hidden="true">
      <g fill="#65704C">
        <path d="M218 58 C110 90 30 190 38 300 C46 410 140 475 250 462 C340 450 400 380 402 290 C402 268 385 262 370 268 C355 275 345 290 340 320 C330 385 285 425 230 428 C150 432 85 375 82 290 C80 200 140 130 218 58 Z" />
        <path d="M175 300 C210 262 260 232 340 228 C372 226 392 240 396 262 C350 252 300 262 250 282 C220 294 195 300 175 300 Z" />
      </g>
      <g fill="#C49A62">
        {[
          "translate(228 108) rotate(-52) scale(1.2)",
          "translate(300 100) rotate(-38) scale(1.1)",
          "translate(385 108) rotate(-14)",
          "translate(190 150) rotate(-8)",
          "translate(298 138) rotate(16) scale(1.05)",
        ].map((transform) => (
          <path key={transform} d="M0 0 Q50 -28 100 0 Q50 28 0 0 Z" transform={transform} />
        ))}
      </g>
    </svg>
  );
}

/**
 * Presentational only — the live always-on-top overlay
 * (`MeetingNotificationOverlay`) layers slide animation, IPC and hover on top
 * via `className` and the handler props. A swipe handle, what's happening, the
 * one action, and a close button on the card's corner.
 */
export function MeetingNotificationCard({
  title,
  body,
  startLabel,
  onStart,
  onDismiss,
  allowTitleWrap = false,
  countdownMs,
  className,
  onMouseEnter,
  onMouseLeave,
}: MeetingNotificationCardProps) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "group relative flex items-center gap-3 rounded-2xl border border-border bg-overlay py-2.5 ps-3 pe-2.5 text-overlay-foreground shadow-overlay",
        className
      )}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <span aria-hidden="true" className="h-9 shrink-0 self-center border-s border-dashed border-border" />

      <div className="min-w-0 flex-1">
        <p
          dir="auto"
          className={cn(
            "text-[13px] font-semibold leading-tight text-foreground",
            allowTitleWrap ? "whitespace-normal break-words" : "truncate"
          )}
        >
          {title}
        </p>
        <p
          className={cn(
            "mt-0.5 text-xs leading-tight text-muted-foreground",
            allowTitleWrap ? "break-words" : "line-clamp-2"
          )}
        >
          {body}
        </p>
      </div>

      <button
        type="button"
        onClick={onStart}
        className="flex h-9 shrink-0 items-center gap-2 rounded-[10px] border border-border bg-default ps-1.5 pe-3 text-[13px] font-medium text-foreground outline-none transition-colors hover:bg-border focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span className="flex size-6 items-center justify-center rounded-[7px] border border-border bg-white">
          <GristmillMark size={18} />
        </span>
        {startLabel}
      </button>

      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("common.close")}
          className="absolute -end-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-overlay text-muted-foreground opacity-0 shadow-sm outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-focus group-hover:opacity-100"
        >
          <X size={10} />
        </button>
      )}

      {countdownMs !== undefined && (
        <span
          aria-hidden="true"
          className="meeting-notification-countdown absolute inset-x-0 bottom-0 h-[3px] origin-left rounded-bs-2xl bg-warning"
          style={{ animationDuration: `${countdownMs}ms` }}
        />
      )}
    </div>
  );
}
