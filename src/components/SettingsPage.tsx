import React from "react";
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
import { ColorSchemePicker } from "./settings/ColorSchemePicker";
import ModelsSettings from "./settings/models/ModelsSettings";
import { ProvidersSettings } from "./settings/models/ProvidersSettings";
import BbAgentSettings from "./settings/BbAgentSettings";
import { LocalModelInventoryProvider } from "./settings/models/LocalModelInventory";
import { LocalModelsSettings } from "./settings/models/LocalModelsSettings";
import DictionaryView from "./DictionaryView";
import IntegrationsView from "./IntegrationsView";
import { ConfirmDialog } from "./ui/dialog";
import { useDialogs } from "../hooks/useDialogs";
import { cn } from "./lib/utils";
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
  | "general"
  | "notes"
  | "recording"
  | "calendar"
  | "models"
  | "providers"
  | "onDevice"
  | "dictionary"
  | "privacyData"
  | "advanced";

interface SettingsPageProps {
  activeSection?: SettingsSectionType;
  onNavigateToSection?: (section: SettingsSectionType) => void;
  initialSubTab?: string;
}

const sections: SettingsSectionType[] = [
  "general",
  "notes",
  "recording",
  "calendar",
  "models",
  "providers",
  "onDevice",
  "dictionary",
  "privacyData",
  "advanced",
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

function GeneralSettings() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const colorScheme = useSettingsStore((s) => s.colorScheme);
  const setColorScheme = useSettingsStore((s) => s.setColorScheme);
  const language = useSettingsStore((s) => s.uiLanguage);
  const setLanguage = useSettingsStore((s) => s.setUiLanguage);
  const startMinimized = useSettingsStore((s) => s.startMinimized);
  const setStartMinimized = useSettingsStore((s) => s.setStartMinimized);
  const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled);
  const setNotificationsEnabled = useSettingsStore((s) => s.setNotificationsEnabled);
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
        <Row
          label={t("settingsPage.general.colorScheme.label")}
          description={t("settingsPage.general.colorScheme.description")}
        >
          <ColorSchemePicker
            value={colorScheme}
            onChange={setColorScheme}
            label={t("settingsPage.general.colorScheme.label")}
          />
        </Row>
      </Group>
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
          <Toggle checked={startMinimized} onChange={setStartMinimized} />
        </Row>
        {error && (
          <SettingsPanelRow>
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          </SettingsPanelRow>
        )}
        <Row
          label={t("settingsPage.general.notifications.title")}
          description={t("settingsPage.general.notifications.description")}
        >
          <Toggle checked={notificationsEnabled} onChange={setNotificationsEnabled} />
        </Row>
      </Group>
    </Section>
  );
}

function NotesSettings() {
  const { t } = useTranslation();
  const noteFilesEnabled = useSettingsStore((s) => s.noteFilesEnabled);
  const setNoteFilesEnabled = useSettingsStore((s) => s.setNoteFilesEnabled);
  const autoTitle = useSettingsStore((s) => s.autoGenerateNoteTitle);
  const setAutoTitle = useSettingsStore((s) => s.setAutoGenerateNoteTitle);
  return (
    <Section
      title={t("settingsModal.sections.notes.label")}
      description={t("settingsModal.sections.notes.description")}
    >
      <Group>
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

function ModelsSection({ focus }: { focus?: string }) {
  const { t } = useTranslation();
  return (
    <Section title={t("settingsModal.sections.models.label")} description={t("settingsModal.sections.models.description")}>
      <ModelsSettings focus={focus} />
    </Section>
  );
}

function ProvidersSection() {
  const { t } = useTranslation();
  return (
    <Section title={t("settingsModal.sections.providers.label")} description={t("settingsModal.sections.providers.description")}>
      <ProvidersSettings />
      <section className="space-y-2">
        <h3 className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("modelsSettings.bb.title")}</h3>
        <BbAgentSettings />
      </section>
    </Section>
  );
}

function OnDeviceSection() {
  const { t } = useTranslation();
  return (
    <Section title={t("settingsModal.sections.onDevice.label")} description={t("settingsModal.sections.onDevice.description")}>
      <LocalModelInventoryProvider>
        <LocalModelsSettings />
      </LocalModelInventoryProvider>
    </Section>
  );
}

/** A macOS permission's current state, with a shortcut to System Settings while it is missing. */
function PermissionStatus({ granted, checking = false, onOpen }: { granted: boolean; checking?: boolean; onOpen: () => void }) {
  const { t } = useTranslation();
  const state = checking ? "checking" : granted ? "granted" : "missing";
  return (
    <div className="flex items-center gap-3">
      <span role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <span
          aria-hidden
          className={cn(
            "size-2 rounded-full",
            state === "granted" ? "bg-success" : state === "missing" ? "bg-warning" : "bg-muted"
          )}
        />
        {t(`settingsPage.permissionStatus.${state}`)}
      </span>
      {state === "missing" && (
        <Button variant="outline" size="sm" onClick={onOpen}>
          {t("cleanupSettings.openSettings")}
        </Button>
      )}
    </div>
  );
}

function RecordingSettings() {
  const { t } = useTranslation();
  const settings = useSettingsStore();
  const { meetingKey, setMeetingKey, meetingHotkeyLayoutMode, setMeetingHotkeyLayoutMode } = settings;
  const permissions = usePermissions();
  const systemAudio = useSystemAudioPermission();
  const { registerHotkey, isRegistering, lastError } = useHotkeyRegistration({
    registerFn: async (key) =>
      (await window.electronAPI.registerMeetingHotkey?.(key)) ?? { success: false },
    onSuccess: setMeetingKey,
  });
  return (
    <Section
      title={t("settingsModal.sections.recording.label")}
      description={t("settingsModal.sections.recording.description")}
    >
      <Group>
        <Row
          label={t("settingsPage.general.meetingCompanion.label")}
          description={t("settingsPage.general.meetingCompanion.description")}
        >
          <Toggle checked={settings.meetingCompanionEnabled} onChange={settings.setMeetingCompanionEnabled} />
        </Row>
      </Group>
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
              <p role="alert" className="text-xs text-danger">
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
          <PermissionStatus
            granted={permissions.micPermissionGranted}
            onOpen={() => void permissions.openMicPrivacySettings()}
          />
        </Row>
        <Row label={t("cleanupSettings.systemAudio")}>
          <PermissionStatus
            granted={systemAudio.granted}
            checking={systemAudio.isChecking && systemAudio.status === "unknown"}
            onOpen={() => void systemAudio.openSettings()}
          />
        </Row>
        <Row
          label={t("hooks.permissions.settingsTitles.accessibility")}
          description={t("cleanupSettings.accessibilityDetection")}
        >
          <PermissionStatus
            granted={permissions.accessibilityPermissionGranted}
            onOpen={() => void permissions.requestAccessibilityPermission()}
          />
        </Row>
      </Group>
    </Section>
  );
}

function AdvancedSettings() {
  const { t } = useTranslation();
  return (
    <Section
      title={t("settingsModal.sections.advanced.label")}
      description={t("settingsModal.sections.advanced.description")}
    >
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
    case "notes":
      return <NotesSettings />;
    case "recording":
      return <RecordingSettings />;
    case "calendar":
      return <IntegrationsView />;
    case "models":
      return <ModelsSection focus={initialSubTab} />;
    case "providers":
      return <ProvidersSection />;
    case "onDevice":
      return <OnDeviceSection />;
    case "dictionary":
      return <DictionaryView />;
    case "privacyData":
      return <PrivacySettings />;
    case "advanced":
      return <AdvancedSettings />;
    default:
      return null;
  }
}
