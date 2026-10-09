import { useTranslation } from "react-i18next";
import { AlertTriangle } from "./icons";
import { Button } from "./ui/button";
import type { CalendarSyncStatus } from "../contracts/calendar";

interface CalendarSyncWarningProps {
  provider: "google" | "microsoft";
  sync: CalendarSyncStatus;
  onAction: () => void;
  action?: "reconnect" | "retry" | "openSettings";
  disabled?: boolean;
}

export default function CalendarSyncWarning({
  provider,
  sync,
  onAction,
  action = "openSettings",
  disabled = false,
}: CalendarSyncWarningProps) {
  const { t } = useTranslation();

  if (sync.state !== "error") return null;

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3"
    >
      <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden="true" />
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-sm font-medium text-foreground">
          {t("integrations.sync.outOfSyncTitle", {
            provider: t(`integrations.${provider}Calendar.title`),
          })}
        </p>
        <p className="text-xs leading-relaxed text-foreground">
          {t(
            sync.requiresReconnect ? "integrations.sync.authRequired" : "integrations.sync.failed"
          )}
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={onAction} disabled={disabled}>
        {t(`integrations.sync.${action}`)}
      </Button>
    </div>
  );
}
