import React from "react";
import { Tabs } from "@heroui/react";
import { HotkeyListInput } from "./ui/HotkeyListInput";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { usePermissions } from "../hooks/usePermissions";
import { useSystemAudioPermission } from "../hooks/useSystemAudioPermission";
import MicrophoneSettings from "./ui/MicrophoneSettings";
import DeveloperSection from "./DeveloperSection";
import { Button } from "./ui/button";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../stores/settingsStore";
import { useTheme } from "../hooks/useTheme";
import LanguageSelector from "./ui/LanguageSelector";
import { SettingsRow } from "./ui/SettingsSection";
import { Toggle } from "./ui/toggle";
import InferenceConfigEditor from "./settings/InferenceConfigEditor";
import ChatAgentSettings from "./settings/ChatAgentSettings";
import { MeetingTranscriptionPanel } from "./settings/MeetingSettings";
import { UploadTranscriptionPanel } from "./settings/UploadSettings";
import { ConfirmDialog } from "./ui/dialog";
import { useDialogs } from "../hooks/useDialogs";

export type SettingsSectionType =
  "general" | "hotkeys" | "speechToText" | "llms" | "privacyData" | "system";

interface SettingsPageProps {
  activeSection?: SettingsSectionType;
  onNavigateToSection?: (section: SettingsSectionType) => void;
  initialSubTab?: string;
}

const sections: SettingsSectionType[] = [
  "general",
  "hotkeys",
  "speechToText",
  "llms",
  "privacyData",
  "system",
];

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="space-y-6">{children}</div>;
}
function Header({ title, description }: { title: string; description?: string }) {
  return (
    <div>
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

function GeneralSettings() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const language = useSettingsStore((s) => s.uiLanguage);
  const setLanguage = useSettingsStore((s) => s.setUiLanguage);
  const noteFilesEnabled = useSettingsStore((s) => s.noteFilesEnabled);
  const setNoteFilesEnabled = useSettingsStore((s) => s.setNoteFilesEnabled);
  const autoTitle = useSettingsStore((s) => s.autoGenerateNoteTitle);
  const setAutoTitle = useSettingsStore((s) => s.setAutoGenerateNoteTitle);
  return (
    <Panel>
      <Header
        title={t("settingsPage.general.title")}
        description={t("settingsPage.general.description")}
      />
      <div className="rounded-lg border border-border/70 divide-y divide-border/60">
        <SettingsRow
          label={t("settingsPage.general.language.label")}
          description={t("settingsPage.general.language.description")}
        >
          <LanguageSelector value={language} onChange={setLanguage} />
        </SettingsRow>
        <SettingsRow
          label={t("settingsPage.general.theme.label")}
          description={t("settingsPage.general.theme.description")}
        >
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value as "light" | "dark" | "auto")}
            className="h-8 rounded border bg-background px-2 text-xs"
          >
            <option value="auto">{t("settingsPage.general.theme.system")}</option>
            <option value="light">{t("settingsPage.general.theme.light")}</option>
            <option value="dark">{t("settingsPage.general.theme.dark")}</option>
          </select>
        </SettingsRow>
        <SettingsRow
          label={t("settingsPage.general.autoGenerateTitle")}
          description={t("settingsPage.general.autoGenerateTitleDescription")}
        >
          <Toggle checked={autoTitle} onChange={setAutoTitle} />
        </SettingsRow>
        <SettingsRow
          label={t("settingsPage.general.noteFiles.label", { defaultValue: "Store note files" })}
          description={t("settingsPage.general.noteFiles.description", {
            defaultValue: "Keep local note files available in the file manager.",
          })}
        >
          <Toggle checked={noteFilesEnabled} onChange={setNoteFilesEnabled} />
        </SettingsRow>
      </div>
    </Panel>
  );
}

function PrivacySettings() {
  const { t } = useTranslation();
  const audioRetentionDays = useSettingsStore((s) => s.audioRetentionDays);
  const setAudioRetentionDays = useSettingsStore((s) => s.setAudioRetentionDays);
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const [audioDeleteMessage, setAudioDeleteMessage] = React.useState("");
  const [audioRetentionInput, setAudioRetentionInput] = React.useState(String(audioRetentionDays));
  const [pendingRetentionDays, setPendingRetentionDays] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (pendingRetentionDays === null) setAudioRetentionInput(String(audioRetentionDays));
  }, [audioRetentionDays, pendingRetentionDays]);

  const saveAudioRetention = (next: number) => {
    setAudioRetentionDays(next);
    setAudioRetentionInput(String(next));
  };
  return (
    <Panel>
      <Header title={t("settingsPage.privacy.title")} />
      <p className="text-sm text-muted-foreground">{t("cleanupSettings.localPrivacy")}</p>
      <div className="rounded-lg border border-border/70 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">{t("settingsPage.privacy.audioRetentionLabel")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("settingsPage.privacy.audioRetentionDescription")}</p>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              dir="ltr"
              type="number"
              min={0}
              step={1}
              className="h-8 w-24 rounded border bg-background px-2"
              value={audioRetentionInput}
              onChange={(event) => {
                setAudioRetentionInput(event.target.value);
              }}
              onBlur={() => {
                const next = Number(audioRetentionInput);
                if (!Number.isSafeInteger(next) || next < 0) {
                  setAudioRetentionInput(String(audioRetentionDays));
                  return;
                }
                if (next >= audioRetentionDays) return saveAudioRetention(next);
                setPendingRetentionDays(next);
                showConfirmDialog({
                  title: t("settingsPage.privacy.retentionDecreaseTitle"),
                  description: t("settingsPage.privacy.retentionDecreaseDescription", { days: next }),
                  confirmText: t("settingsPage.privacy.retentionDecreaseConfirm"),
                  variant: "destructive",
                  onConfirm: () => {
                    setPendingRetentionDays(null);
                    saveAudioRetention(next);
                  },
                });
              }}
              aria-label={t("settingsPage.privacy.audioRetentionLabel")}
            />
            <span>{t("settingsPage.privacy.days")}</span>
          </label>
        </div>
      </div>
      <div className="rounded-lg border border-border/70 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">{t("settingsPage.privacy.deleteAllAudioLabel")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("settingsPage.privacy.deleteAllAudioDescription")}</p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => showConfirmDialog({
              title: t("settingsPage.privacy.deleteAllAudioTitle"),
              description: t("settingsPage.privacy.deleteAllAudioConfirmDescription"),
              confirmText: t("settingsPage.privacy.deleteAllAudioConfirm"),
              variant: "destructive",
              onConfirm: async () => {
                setAudioDeleteMessage("");
                try {
                  const result = await window.electronAPI.deleteAllAudio();
                  setAudioDeleteMessage(result.failed > 0
                    ? t("settingsPage.privacy.deleteAllAudioFailed", { count: result.failed })
                    : t("settingsPage.privacy.deleteAllAudioDone", { count: result.deleted }));
                } catch (error) {
                  setAudioDeleteMessage(error instanceof Error ? error.message : String(error));
                }
              },
            })}
          >
            {t("settingsPage.privacy.deleteAllAudioButton")}
          </Button>
        </div>
        {audioDeleteMessage && <p className="mt-2 text-xs text-muted-foreground" role="status">{audioDeleteMessage}</p>}
      </div>
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => {
          if (open) return;
          if (pendingRetentionDays !== null) {
            setPendingRetentionDays(null);
            setAudioRetentionInput(String(audioRetentionDays));
          }
          hideConfirmDialog();
        }}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />
    </Panel>
  );
}

function SpeechSettings({ initialSubTab }: { initialSubTab?: string }) {
  const { t } = useTranslation();
  const [tab, setTab] = React.useState(initialSubTab === "upload" ? "upload" : "meeting");
  return (
    <Panel>
      <Tabs selectedKey={tab} onSelectionChange={(key) => setTab(String(key))} aria-label={t("settingsPage.speechToText.title")}>
        <Tabs.List aria-label={t("settingsPage.speechToText.title")}>
          <Tabs.Tab id="meeting">{t("settingsPage.speechToText.tabs.noteRecording")}<Tabs.Indicator /></Tabs.Tab>
          <Tabs.Tab id="upload">{t("settingsPage.speechToText.tabs.upload")}<Tabs.Indicator /></Tabs.Tab>
        </Tabs.List>
      </Tabs>
      {tab === "meeting" ? <MeetingTranscriptionPanel /> : <UploadTranscriptionPanel />}
    </Panel>
  );
}

function LlmSettings() {
  const t = useTranslation().t;
  const [task, setTask] = React.useState("transcription");
  return (
    <Panel>
      <Header
        title={t("settingsPage.aiModels.title")}
        description={t("settingsPage.aiModels.description")}
      />
      <Tabs selectedKey={task} onSelectionChange={(key) => setTask(String(key))} aria-label={t("settingsPage.aiModels.title")}>
        <Tabs.List aria-label={t("settingsPage.aiModels.title")}>
          <Tabs.Tab id="transcription">{t("settingsPage.aiModels.transcriptionTask", { defaultValue: "Transcription" })}<Tabs.Indicator /></Tabs.Tab>
          <Tabs.Tab id="summary">{t("settingsPage.aiModels.summaryTask", { defaultValue: "Meeting summary" })}<Tabs.Indicator /></Tabs.Tab>
          <Tabs.Tab id="chat">{t("settingsPage.aiModels.chatTitle", { defaultValue: "Chat" })}<Tabs.Indicator /></Tabs.Tab>
        </Tabs.List>
      </Tabs>
      {task === "transcription" && <MeetingTranscriptionPanel />}
      {task === "summary" && <InferenceConfigEditor scope="noteFormatting" />}
      {task === "chat" && <ChatAgentSettings />}
    </Panel>
  );
}

function HotkeysSettings() {
  const { t } = useTranslation();
  const { meetingKey, setMeetingKey, meetingHotkeyLayoutMode, setMeetingHotkeyLayoutMode } =
    useSettingsStore();
  const { registerHotkey, isRegistering, lastError } = useHotkeyRegistration({
    registerFn: async (key) =>
      (await window.electronAPI.registerMeetingHotkey?.(key)) ?? { success: false },
    onSuccess: setMeetingKey,
  });
  return (
    <Panel>
      <Header
        title={t("settingsPage.general.meetingHotkey.title")}
        description={t("settingsPage.general.meetingHotkey.description")}
      />
      <HotkeyListInput
        value={meetingKey}
        onChange={registerHotkey}
        onClear={async () => {
          const result = (await window.electronAPI.registerMeetingHotkey?.("")) ?? {
            success: false,
          };
          if (result.success) setMeetingKey("");
          return result.success;
        }}
        disabled={isRegistering}
      />
      {lastError && (
        <p role="alert" className="text-xs text-destructive">
          {lastError}
        </p>
      )}
      <SettingsRow label={t("settingsPage.general.meetingHotkey.layoutLabel")}>
        <select
          value={meetingHotkeyLayoutMode}
          onChange={(e) =>
            setMeetingHotkeyLayoutMode(e.target.value as "full-width" | "side-panel")
          }
        >
          <option value="full-width">
            {t("settingsPage.general.meetingHotkey.layoutFullWidth")}
          </option>
          <option value="side-panel">
            {t("settingsPage.general.meetingHotkey.layoutSidePanel")}
          </option>
        </select>
      </SettingsRow>
    </Panel>
  );
}
function SystemSettings() {
  const { t } = useTranslation();
  const settings = useSettingsStore();
  const permissions = usePermissions(undefined, { macAccessibilityChecksEnabled: false });
  const systemAudio = useSystemAudioPermission();
  const [autoStart, setAutoStart] = React.useState(false);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    void window.electronAPI.getAutoStartEnabled?.().then((result) => setAutoStart(result.enabled));
  }, []);
  const updateAutoStart = async (enabled: boolean) => {
    const result = await window.electronAPI.setAutoStartEnabled?.(enabled);
    if (result?.success) {
      setAutoStart(enabled);
      setError("");
    } else setError(result?.error || t("common.error"));
  };
  return (
    <Panel>
      <Header
        title={t("settingsPage.general.startup.title")}
        description={t("settingsPage.general.startup.description")}
      />
      <SettingsRow label={t("settingsPage.general.startup.launchAtLogin")}>
        <Toggle
          checked={autoStart}
          onChange={(value) => {
            void updateAutoStart(value);
          }}
        />
      </SettingsRow>
      <SettingsRow label={t("settingsPage.general.startup.startMinimized")}>
        <Toggle checked={settings.startMinimized} onChange={settings.setStartMinimized} />
      </SettingsRow>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <MicrophoneSettings
        microphoneSelectionMode={settings.microphoneSelectionMode}
        selectedMicDeviceId={settings.selectedMicDeviceId}
        selectedMicDeviceLabel={settings.selectedMicDeviceLabel}
        onSelectionModeChange={settings.setMicrophoneSelectionMode}
        onDeviceSelect={settings.setSelectedMicDevice}
      />
      <Header title={t("cleanupSettings.permissions")} />
      <SettingsRow label={t("settingsPage.general.microphone.title")}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void permissions.openMicPrivacySettings()}
        >
          {t("cleanupSettings.openSettings")}
        </Button>
      </SettingsRow>
      {permissions.micPermissionError && <p role="alert">{permissions.micPermissionError}</p>}
      <SettingsRow label={t("cleanupSettings.systemAudio")}>
        <Button variant="outline" size="sm" onClick={() => void systemAudio.openSettings()}>
          {t("cleanupSettings.openSettings")}
        </Button>
      </SettingsRow>
      <SettingsRow label={t("settingsPage.general.notifications.title")}>
        <Toggle
          checked={settings.notificationsEnabled}
          onChange={settings.setNotificationsEnabled}
        />
      </SettingsRow>
      <DeveloperSection />
    </Panel>
  );
}

export default function SettingsPage({
  activeSection = "general",
  initialSubTab,
}: SettingsPageProps) {
  const section = sections.includes(activeSection) ? activeSection : "general";
  switch (section) {
    case "general":
      return <GeneralSettings />;
    case "hotkeys":
      return <HotkeysSettings />;
    case "speechToText":
      return <SpeechSettings initialSubTab={initialSubTab} />;
    case "llms":
      return <LlmSettings />;
    case "privacyData":
      return <PrivacySettings />;
    case "system":
      return <SystemSettings />;
    default:
      return null;
  }
}
