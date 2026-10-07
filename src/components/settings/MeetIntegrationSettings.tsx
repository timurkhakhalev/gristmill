import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CompanionSetup } from "../../contracts/companion";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";

export function MeetIntegrationSettings() {
  const { t } = useTranslation();
  const [setup, setSetup] = useState<CompanionSetup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void window.electronAPI
      ?.getMeetIntegrationSetup()
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

  const configure = async (action: "enable" | "disable" | "reveal") => {
    setBusy(true);
    setError(null);

    try {
      const result = await window.electronAPI?.configureMeetIntegration(action);

      if (!result?.success) throw new Error(result?.error ?? t("meetIntegration.setupFailed"));
      setSetup((await window.electronAPI?.getMeetIntegrationSetup()) ?? null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">{t("meetIntegration.title")}</h3>
          <p className="text-xs text-muted-foreground">{t("meetIntegration.setupDescription")}</p>
        </div>
        <Toggle
          ariaLabel={t("meetIntegration.title")}
          checked={setup?.enabled === true}
          disabled={busy || !setup}
          onChange={(enabled) => void configure(enabled ? "enable" : "disable")}
        />
      </div>
      {setup?.enabled && !setup.installed && (
        <p role="alert" className="text-xs text-destructive">
          {t("meetIntegration.setupFailed")}
        </p>
      )}
      {setup?.enabled && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">{t("meetIntegration.openExtension")}</summary>
          <p className="my-2">{t("meetIntegration.installInstructions")}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void configure("reveal")}
          >
            {t("meetIntegration.selectExtension")}
          </Button>
        </details>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
