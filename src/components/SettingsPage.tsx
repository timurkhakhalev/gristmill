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
import { SettingsCard, SettingsCardRow, SettingsPanelRow } from "./ui/SettingsSection";
import { SelectField } from "./ui/SelectField";
import { Toggle } from "./ui/toggle";
import InferenceConfigEditor from "./settings/InferenceConfigEditor";
import ChatAgentSettings from "./settings/ChatAgentSettings";
import { MeetingTranscriptionPanel } from "./settings/MeetingSettings";
import { UploadTranscriptionPanel } from "./settings/UploadSettings";
import { ConfirmDialog } from "./ui/dialog";
import { useDialogs } from "../hooks/useDialogs";
import { SUPPORTED_UI_LANGUAGES, type UiLanguage } from "../i18n";

// Each language is named in itself, so users can find theirs from any UI language.
const UI_LANGUAGE_NAMES: Record<UiLanguage, string> = {
  en: "English",
  ar: "العربية",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  pt: "Português",
  it: "Italiano",
  ru: "Русский",
  ja: "日本語",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
};

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

/** Every settings section: page title, then content in a readable column. */
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="pe-10">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </header>
      {children}
    </div>
  );
}

const Group = SettingsCard;
const Row = SettingsCardRow;

function SubTabs({
  selectedKey,
  onChange,
  label,
  tabs,
}: {
  selectedKey: string;
  onChange: (key: string) => void;
  label: string;
  tabs: { id: string; label: string }[];
}) {
  return (
    <Tabs selectedKey={selectedKey} onSelectionChange={(key) => onChange(String(key))} aria-label={label}>
      <Tabs.List aria-label={label}>
        {tabs.map((tab) => (
          <Tabs.Tab key={tab.id} id={tab.id}>
            {tab.label}
            <Tabs.Indicator />
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs>
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
    <Section
      title={t("settingsModal.sections.general.label")}
      description={t("settingsModal.sections.general.description")}
    >
      <Group>
        <Row
          label={t("settingsPage.general.language.label")}
          description={t("settingsPage.general.language.description")}
        >
          <SelectField
            value={language}
            onChange={setLanguage}
            options={SUPPORTED_UI_LANGUAGES.map((id) => ({ id, label: UI_LANGUAGE_NAMES[id] }))}
            className="w-36"
          />
        </Row>
        <Row
          label={t("settingsPage.general.theme.label")}
          description={t("settingsPage.general.theme.description")}
        >
          <SelectField
            value={theme}
            onChange={(value) => setTheme(value as "light" | "dark" | "auto")}
            options={[
              { id: "auto", label: t("settingsPage.general.theme.system") },
              { id: "light", label: t("settingsPage.general.theme.light") },
              { id: "dark", label: t("settingsPage.general.theme.dark") },
            ]}
            className="w-36"
          />
        </Row>
      </Group>
      <Group title={t("settingsPage.general.notesGroup")}>
        <Row
          label={t("settingsPage.general.autoGenerateTitle")}
          description={t("settingsPage.general.autoGenerateTitleDescription")}
        >
          <Toggle checked={autoTitle} onChange={setAutoTitle} />
        </Row>
        <Row
          label={t("settingsPage.general.noteFiles.label", { defaultValue: "Store note files" })}
          description={t("settingsPage.general.noteFiles.description", {
            defaultValue: "Keep local note files available in the file manager.",
          })}
        >
          <Toggle checked={noteFilesEnabled} onChange={setNoteFilesEnabled} />
        </Row>
      </Group>
    </Section>
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
    <Section
      title={t("settingsModal.sections.privacyData.label")}
      description={t("settingsModal.sections.privacyData.description")}
    >
      <Group title={t("settingsPage.privacy.audioGroup")}>
        <Row
          label={t("settingsPage.privacy.audioRetentionLabel")}
          description={t("settingsPage.privacy.audioRetentionDescription")}
        >
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              dir="ltr"
              type="number"
              min={0}
              step={1}
              className="h-8 w-20 rounded-lg px-2.5 text-sm"
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
        </Row>
        <Row
          label={t("settingsPage.privacy.deleteAllAudioLabel")}
          description={
            <>
              {t("settingsPage.privacy.deleteAllAudioDescription")}
              {audioDeleteMessage && (
                <span className="mt-1 block text-foreground" role="status">
                  {audioDeleteMessage}
                </span>
              )}
            </>
          }
        >
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
        </Row>
      </Group>
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
    </Section>
  );
}

function SpeechSettings({ initialSubTab }: { initialSubTab?: string }) {
  const { t } = useTranslation();
  const [tab, setTab] = React.useState(initialSubTab === "upload" ? "upload" : "meeting");
  return (
    <Section
      title={t("settingsModal.sections.speechToText.label")}
      description={t("settingsModal.sections.speechToText.description")}
    >
      <SubTabs
        selectedKey={tab}
        onChange={setTab}
        label={t("settingsPage.speechToText.title")}
        tabs={[
          { id: "meeting", label: t("settingsPage.speechToText.tabs.noteRecording") },
          { id: "upload", label: t("settingsPage.speechToText.tabs.upload") },
        ]}
      />
      {tab === "meeting" ? <MeetingTranscriptionPanel /> : <UploadTranscriptionPanel />}
    </Section>
  );
}

function LlmSettings() {
  const { t } = useTranslation();
  const [task, setTask] = React.useState("summary");
  return (
    <Section
      title={t("settingsModal.sections.llms.label")}
      description={t("settingsModal.sections.llms.description")}
    >
      <SubTabs
        selectedKey={task}
        onChange={setTask}
        label={t("settingsPage.aiModels.title")}
        tabs={[
          { id: "summary", label: t("settingsPage.aiModels.summaryTask") },
          { id: "chat", label: t("settingsPage.aiModels.chatTitle") },
        ]}
      />
      {task === "summary" && <InferenceConfigEditor scope="noteFormatting" />}
      {task === "chat" && <ChatAgentSettings />}
    </Section>
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
    <Section
      title={t("settingsModal.sections.hotkeys.label")}
      description={t("settingsModal.sections.hotkeys.description")}
    >
      <Group title={t("settingsPage.general.meetingHotkey.title")}>
        <SettingsPanelRow>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {t("settingsPage.general.meetingHotkey.description")}
            </p>
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
          </div>
        </SettingsPanelRow>
        <Row label={t("settingsPage.general.meetingHotkey.layoutLabel")}>
          <SelectField
            value={meetingHotkeyLayoutMode}
            onChange={(value) => setMeetingHotkeyLayoutMode(value as "full-width" | "side-panel")}
            options={[
              { id: "full-width", label: t("settingsPage.general.meetingHotkey.layoutFullWidth") },
              { id: "side-panel", label: t("settingsPage.general.meetingHotkey.layoutSidePanel") },
            ]}
          />
        </Row>
      </Group>
    </Section>
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
    <Section
      title={t("settingsModal.sections.system.label")}
      description={t("settingsModal.sections.system.description")}
    >
      <Group title={t("settingsPage.general.startup.title")}>
        <Row
          label={t("settingsPage.general.startup.launchAtLogin")}
          description={t("settingsPage.general.startup.launchAtLoginDescription")}
        >
          <Toggle
            checked={autoStart}
            onChange={(value) => {
              void updateAutoStart(value);
            }}
          />
        </Row>
        <Row
          label={t("settingsPage.general.startup.startMinimized")}
          description={t("settingsPage.general.startup.startMinimizedDescription")}
        >
          <Toggle checked={settings.startMinimized} onChange={settings.setStartMinimized} />
        </Row>
        {error && (
          <SettingsPanelRow>
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          </SettingsPanelRow>
        )}
      </Group>
      <Group title={t("cleanupSettings.permissions")}>
        <SettingsPanelRow>
          <MicrophoneSettings
            microphoneSelectionMode={settings.microphoneSelectionMode}
            selectedMicDeviceId={settings.selectedMicDeviceId}
            selectedMicDeviceLabel={settings.selectedMicDeviceLabel}
            onSelectionModeChange={settings.setMicrophoneSelectionMode}
            onDeviceSelect={settings.setSelectedMicDevice}
          />
        </SettingsPanelRow>
        <Row
          label={t("settingsPage.general.microphone.title")}
          description={permissions.micPermissionError || undefined}
        >
          <Button variant="outline" size="sm" onClick={() => void permissions.openMicPrivacySettings()}>
            {t("cleanupSettings.openSettings")}
          </Button>
        </Row>
        <Row label={t("cleanupSettings.systemAudio")}>
          <Button variant="outline" size="sm" onClick={() => void systemAudio.openSettings()}>
            {t("cleanupSettings.openSettings")}
          </Button>
        </Row>
        <Row label={t("settingsPage.general.notifications.title")}>
          <Toggle
            checked={settings.notificationsEnabled}
            onChange={settings.setNotificationsEnabled}
          />
        </Row>
      </Group>
      <DeveloperSection />
    </Section>
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
