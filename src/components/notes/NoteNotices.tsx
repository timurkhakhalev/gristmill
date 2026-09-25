import type { ReactNode } from "react";
import { Alert, Spinner } from "@heroui/react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";

type NoticeStatus = "default" | "accent" | "success" | "warning" | "danger";

/** One-line status or problem notice shared by the note screen. */
export function NoteNotice({
  status,
  title,
  description,
  actions,
  busy = false,
  role,
}: {
  status: NoticeStatus;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  busy?: boolean;
  role?: "status" | "alert";
}) {
  return (
    <Alert status={status} className="mb-4 items-center rounded-xl motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200 motion-safe:slide-in-from-top-1" role={role ?? (status === "danger" ? "alert" : "status")}>
      {busy ? (
        <Alert.Indicator>
          <Spinner size="sm" color="current" />
        </Alert.Indicator>
      ) : (
        <Alert.Indicator />
      )}
      <Alert.Content>
        <Alert.Title className="text-sm">{title}</Alert.Title>
        {description && <Alert.Description className="text-xs">{description}</Alert.Description>}
      </Alert.Content>
      {actions && <div className="ms-auto flex flex-wrap items-center gap-1.5">{actions}</div>}
    </Alert>
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
