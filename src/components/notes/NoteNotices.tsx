import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Alert, Spinner } from "@heroui/react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { Clock, X } from "../icons";

type NoticeStatus = "default" | "accent" | "success" | "warning" | "danger";

/** One-line status or problem notice shared by the note screen. */
export function NoteNotice({
  status,
  title,
  description,
  actions,
  busy = false,
  progressStartedAt,
  role,
  onDismiss,
}: {
  status: NoticeStatus;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  busy?: boolean;
  /** When set with `busy`, show a live "elapsed" timer so the user knows the request is still moving. */
  progressStartedAt?: number;
  role?: "status" | "alert";
  /** Runs when the user closes the notice, e.g. to remember that beyond this mount. */
  onDismiss?: () => void;
}) {
  const { t } = useTranslation();
  // Busy notices track live work and notices with actions (retry, regenerate) stay unless the
  // caller opts in with onDismiss. Others can be closed; a changed title shows again.
  const [dismissedTitle, setDismissedTitle] = useState<ReactNode | null>(null);
  if (dismissedTitle !== null && dismissedTitle === title) return null;
  return (
    <Alert status={status} className="mb-4 rounded-xl motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200 motion-safe:slide-in-from-top-1" role={role ?? (status === "danger" ? "alert" : "status")}>
      {busy ? (
        <Alert.Indicator>
          <Spinner size="sm" color="current" />
        </Alert.Indicator>
      ) : (
        <Alert.Indicator />
      )}
      <Alert.Content>
        <Alert.Title className="flex items-center gap-2 text-sm">
          <span>{title}</span>
          {busy && progressStartedAt !== undefined && (
            <ElapsedClock since={progressStartedAt} />
          )}
        </Alert.Title>
        {description && <Alert.Description className="text-xs">{description}</Alert.Description>}
        {actions && <div className="mt-2.5 flex flex-wrap items-center gap-2">{actions}</div>}
      </Alert.Content>
      {!busy && (!actions || onDismiss) && (
        <button
          type="button"
          onClick={() => { setDismissedTitle(title); onDismiss?.(); }}
          aria-label={t("common.dismiss")}
          title={t("common.dismiss")}
          className="-me-1 -mt-1 flex size-6 shrink-0 items-center justify-center self-start rounded-md text-muted outline-none transition-colors hover:bg-default hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus"
        >
          <X size={14} />
        </button>
      )}
    </Alert>
  );
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function ElapsedClock({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span
      aria-label="Elapsed"
      className="inline-flex items-center gap-1 text-2xs font-normal text-muted tabular-nums"
    >
      <Clock size={11} className="shrink-0" />
      {formatElapsed(now - since)}
    </span>
  );
}

type SourceStatus = "active" | "reconnecting" | "unavailable" | "inactive";

/** Compact live-capture health line: one dot per audio source. */
export function CaptureHealthLine({
  micStatus,
  systemStatus,
}: {
  micStatus: SourceStatus;
  systemStatus: SourceStatus;
}) {
  const { t } = useTranslation();
  const sources = [
    ["mic", micStatus],
    ["system", systemStatus],
  ] as const;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg bg-subtle px-3 py-2 text-xs text-muted motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200 motion-safe:slide-in-from-top-1" role="status">
      {sources.map(([source, status]) => (
        <span key={source} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-full",
              status === "active" ? "bg-success" : status === "reconnecting" ? "bg-warning" : "bg-danger"
            )}
          />
          <span className="text-foreground">{t(`notes.editor.capture.${source}`)}</span>
          {status !== "active" && (
            <span className={status === "reconnecting" ? "text-warning" : "text-danger"}>
              {t(`notes.editor.capture.${status}`)}
            </span>
          )}
        </span>
      ))}
      <span className="ms-auto">{t("notes.editor.capture.writingToDisk")}</span>
    </div>
  );
}
