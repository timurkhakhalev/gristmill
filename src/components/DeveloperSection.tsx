import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { FolderOpen, Copy, Check } from "./icons";
import { useToast } from "./ui/useToast";
import { Toggle } from "./ui/toggle";
import { useSettingsLayout } from "./ui/useSettingsLayout";
import { SettingsCard, SettingsCardRow, SettingsPanelRow } from "./ui/SettingsSection";
import logger from "../utils/logger";

export default function DeveloperSection() {
  const { t } = useTranslation();
  const { isCompact } = useSettingsLayout();
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [logPath, setLogPath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isToggling, setIsToggling] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const { toast } = useToast();

  const loadDebugState = useCallback(async () => {
    try {
      setIsLoading(true);
      const state = await window.electronAPI.getDebugState();
      setDebugEnabled(state.enabled);
      setLogPath(state.logPath);
    } catch (error) {
      logger.error("Failed to load debug state", { error }, "developer");
      toast({
        title: t("developerSection.toasts.loadFailed.title"),
        description: t("developerSection.toasts.loadFailed.description"),
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [t, toast]);

  useEffect(() => {
    loadDebugState();
  }, [loadDebugState]);

  const handleToggleDebug = async () => {
    if (isToggling) return;

    try {
      setIsToggling(true);
      const newState = !debugEnabled;
      const result = await window.electronAPI.setDebugLogging(newState);

      if (!result.success) {
        throw new Error(result.error || "Failed to update debug logging");
      }

      setDebugEnabled(newState);
      await loadDebugState();

      toast({
        title: newState
          ? t("developerSection.toasts.debugEnabled.title")
          : t("developerSection.toasts.debugDisabled.title"),
        description: newState
          ? t("developerSection.toasts.debugEnabled.description")
          : t("developerSection.toasts.debugDisabled.description"),
        variant: "success",
      });
    } catch (error) {
      toast({
        title: t("developerSection.toasts.updateFailed.title"),
        description: t("developerSection.toasts.updateFailed.description"),
        variant: "destructive",
      });
    } finally {
      setIsToggling(false);
    }
  };

  const handleOpenLogsFolder = async () => {
    try {
      const result = await window.electronAPI.openLogsFolder();
      if (!result.success) {
        throw new Error(result.error || "Failed to open folder");
      }
    } catch (error) {
      toast({
        title: t("developerSection.toasts.openLogsFailed.title"),
        description: t("developerSection.toasts.openLogsFailed.description"),
        variant: "destructive",
      });
    }
  };

  const handleCopyPath = async () => {
    if (!logPath) return;

    try {
      await navigator.clipboard.writeText(logPath);
      setCopiedPath(true);
      toast({
        title: t("developerSection.toasts.copied.title"),
        description: t("developerSection.toasts.copied.description"),
        variant: "success",
        duration: 2000,
      });
      setTimeout(() => setCopiedPath(false), 2000);
    } catch (error) {
      toast({
        title: t("developerSection.toasts.copyFailed.title"),
        description: t("developerSection.toasts.copyFailed.description"),
        variant: "destructive",
      });
    }
  };

  const handleInstallCli = async () => {
    const result = await window.electronAPI.installAgentCli();
    toast({
      title: result.success ? t("developerSection.cliInstalled", { defaultValue: "CLI installed" }) : t("developerSection.cliInstallFailed", { defaultValue: "CLI installation failed" }),
      description: result.success ? "~/.local/bin/gristmill" : result.error,
      variant: result.success ? "success" : "destructive",
    });
  };

  const loggedItems = [
    t("developerSection.whatGetsLogged.items.audioProcessing"),
    t("developerSection.whatGetsLogged.items.apiRequests"),
    t("developerSection.whatGetsLogged.items.ffmpegOperations"),
    t("developerSection.whatGetsLogged.items.systemDiagnostics"),
    t("developerSection.whatGetsLogged.items.transcriptionPipeline"),
    t("developerSection.whatGetsLogged.items.errorDetails"),
  ];

  return (
    <SettingsCard title={t("developerSection.title")}>
      <SettingsCardRow
        label={t("developerSection.debugMode.label")}
        description={
          <>
            {debugEnabled
              ? t("developerSection.debugMode.enabledDescription")
              : t("developerSection.debugMode.disabledDescription")}
            <span className="mt-1 block">
              {t("developerSection.whatGetsLogged.title")}: {loggedItems.join(", ")}.
            </span>
          </>
        }
      >
        <Toggle
          checked={debugEnabled}
          onChange={handleToggleDebug}
          disabled={isLoading || isToggling}
        />
      </SettingsCardRow>

      {debugEnabled && logPath && (
        <SettingsPanelRow>
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            {t("developerSection.currentLogFile")}
          </p>
          <div className={`flex gap-2 ${isCompact ? "flex-col" : "items-center"}`}>
            <code
              dir="ltr"
              className="flex-1 break-all rounded-lg bg-subtle px-3 py-2 font-mono text-xs text-muted-foreground"
            >
              {logPath}
            </code>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                onClick={handleCopyPath}
                variant="ghost"
                size="icon"
                aria-label={t("common.copy", { defaultValue: "Copy" })}
              >
                {copiedPath ? (
                  <Check className="size-3.5 text-success" />
                ) : (
                  <Copy className="size-3.5 text-muted-foreground" />
                )}
              </Button>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            <span className="font-medium text-warning">
              {t("developerSection.performanceNote.label")}
            </span>{" "}
            {t("developerSection.performanceNote.description")}
          </p>
        </SettingsPanelRow>
      )}
      <SettingsPanelRow>
        <Button onClick={handleOpenLogsFolder} variant="outline" size="sm">
          <FolderOpen className="size-3.5" />
          {t("developerSection.openLogsFolder")}
        </Button>
      </SettingsPanelRow>
      <SettingsPanelRow>
        <Button onClick={() => void handleInstallCli()} variant="outline" size="sm">
          {t("developerSection.installCli", { defaultValue: "Install Notes CLI" })}
        </Button>
      </SettingsPanelRow>
    </SettingsCard>
  );
}
