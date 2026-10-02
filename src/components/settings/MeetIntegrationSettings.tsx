import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CompanionSetup } from "../../contracts/companion";
import { Button } from "../ui/button";

export function MeetIntegrationSettings() {
  const { t } = useTranslation();
  const [setup, setSetup] = useState<CompanionSetup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void window.electronAPI
      ?.getMeetIntegrationSetup?.()
      .then((value) => {
        if (active) setSetup(value);
      })
      .catch((failure) => {
        if (active) setError(String(failure));
      });
    return () => {
      active = false;
    };
  }, []);
  const configure = async (action: "enable" | "disable" | "remove" | "reveal") => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI?.configureMeetIntegration?.(action);
      if (!result?.success) throw new Error(result?.error ?? t("meetIntegration.setupFailed"));
      setSetup(await window.electronAPI!.getMeetIntegrationSetup!());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 p-4">
      <h3 className="text-sm font-medium">{t("meetIntegration.title")}{setup?.channel === "development" ? " · Dev" : ""}</h3>
      <p className="text-xs text-muted-foreground">{t("meetIntegration.setupDescription")}</p>
      <p className="text-xs">
        {setup
          ? t(
              setup.enabled && setup.installed
                ? "meetIntegration.enabled"
                : "meetIntegration.disabled"
            )
          : t("meetIntegration.loading")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || !setup}
          onClick={() => void configure(setup?.enabled ? "disable" : "enable")}
        >
          {t(setup?.enabled ? "meetIntegration.disable" : "meetIntegration.enable")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !setup}
          onClick={() => void configure("reveal")}
        >
          {t("meetIntegration.openExtension")}
        </Button>
        {setup?.installed && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void configure("remove")}
          >
            {t("meetIntegration.remove")}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
