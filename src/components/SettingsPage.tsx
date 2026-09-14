import React from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore, selectResolvedLLMConfig } from "../stores/settingsStore";
import { useTheme } from "../hooks/useTheme";
import { useSettings } from "../hooks/useSettings";
import LanguageSelector from "./ui/LanguageSelector";
import { SettingsRow } from "./ui/SettingsSection";
import { Toggle } from "./ui/toggle";
import InferenceConfigEditor from "./settings/InferenceConfigEditor";
import ChatAgentSettings from "./settings/ChatAgentSettings";
import { MeetingTranscriptionPanel } from "./settings/MeetingSettings";
import { UploadTranscriptionPanel } from "./settings/UploadSettings";

export type SettingsSectionType = "general" | "hotkeys" | "speechToText" | "llms" | "privacyData" | "system";

interface SettingsPageProps { activeSection?: SettingsSectionType; onNavigateToSection?: (section: SettingsSectionType) => void; initialSubTab?: string; }

const sections: SettingsSectionType[] = ["general", "hotkeys", "speechToText", "llms", "privacyData", "system"];

export function AccountAvatar({ image, name }: { image?: string | null; name: string }) {
  return image ? <img src={image} alt="" className="h-8 w-8 rounded-full object-cover" /> : <div aria-hidden="true" className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-sm font-medium text-primary">{name.slice(0, 1).toUpperCase()}</div>;
}

function Panel({ children }: { children: React.ReactNode }) { return <div className="space-y-6">{children}</div>; }
function Header({ title, description }: { title: string; description?: string }) { return <div><h2 className="text-base font-semibold text-foreground">{title}</h2>{description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}</div>; }

function GeneralSettings() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const language = useSettingsStore((s) => s.uiLanguage);
  const setLanguage = useSettingsStore((s) => s.setUiLanguage);
  const noteFilesEnabled = useSettingsStore((s) => s.noteFilesEnabled);
  const setNoteFilesEnabled = useSettingsStore((s) => s.setNoteFilesEnabled);
  const autoTitle = useSettingsStore((s) => s.autoGenerateNoteTitle);
  const setAutoTitle = useSettingsStore((s) => s.setAutoGenerateNoteTitle);
  return <Panel><Header title={t("settingsPage.general.title")} description={t("settingsPage.general.description")} /><div className="rounded-lg border border-border/70 divide-y divide-border/60"><SettingsRow label={t("settingsPage.general.language.label")} description={t("settingsPage.general.language.description")}><LanguageSelector value={language} onChange={setLanguage} /></SettingsRow><SettingsRow label={t("settingsPage.general.theme.label")} description={t("settingsPage.general.theme.description")}><select value={theme} onChange={(e) => setTheme(e.target.value as "light" | "dark" | "auto")} className="h-8 rounded border bg-background px-2 text-xs"><option value="auto">{t("settingsPage.general.theme.system")}</option><option value="light">{t("settingsPage.general.theme.light")}</option><option value="dark">{t("settingsPage.general.theme.dark")}</option></select></SettingsRow><SettingsRow label={t("settingsPage.general.autoGenerateTitle")} description={t("settingsPage.general.autoGenerateTitleDescription")}><Toggle checked={autoTitle} onChange={setAutoTitle} /></SettingsRow><SettingsRow label={t("settingsPage.general.noteFiles.label", { defaultValue: "Store note files" })} description={t("settingsPage.general.noteFiles.description", { defaultValue: "Keep local note files available in the file manager." })}><Toggle checked={noteFilesEnabled} onChange={setNoteFilesEnabled} /></SettingsRow></div></Panel>;
}

function PrivacySettings() {
  const { t } = useTranslation();
  const { audioRetentionDays, transcriptRetentionDays, dataRetentionEnabled, telemetryEnabled, setAudioRetentionDays, setTranscriptRetentionDays, setDataRetentionEnabled, setTelemetryEnabled } = useSettings();
  return <Panel><Header title={t("settingsPage.privacy.title")} description={t("settingsPage.privacy.description")} /><div className="rounded-lg border border-border/70 divide-y divide-border/60"><SettingsRow label={t("settingsPage.privacy.dataRetention.label", { defaultValue: "Local data retention" })} description={t("settingsPage.privacy.dataRetention.description", { defaultValue: "Delete local audio and transcripts after the selected period." })}><Toggle checked={dataRetentionEnabled} onChange={setDataRetentionEnabled} /></SettingsRow>{dataRetentionEnabled && <><SettingsRow label={t("settingsPage.privacy.audioRetention", { defaultValue: "Audio retention (days)" })}><input type="number" min={0} value={audioRetentionDays} onChange={(e) => setAudioRetentionDays(Number(e.target.value))} className="h-8 w-20 rounded border bg-background px-2 text-xs" /></SettingsRow><SettingsRow label={t("settingsPage.privacy.transcriptRetention", { defaultValue: "Transcript retention (days)" })}><input type="number" min={0} value={transcriptRetentionDays} onChange={(e) => setTranscriptRetentionDays(Number(e.target.value))} className="h-8 w-20 rounded border bg-background px-2 text-xs" /></SettingsRow></>}<SettingsRow label={t("settingsPage.privacy.telemetry.label", { defaultValue: "Anonymous diagnostics" })} description={t("settingsPage.privacy.telemetry.description", { defaultValue: "Share anonymous diagnostics to improve the app." })}><Toggle checked={telemetryEnabled} onChange={setTelemetryEnabled} /></SettingsRow></div></Panel>;
}

function SpeechSettings({ initialSubTab }: { initialSubTab?: string }) { const [tab, setTab] = React.useState(initialSubTab === "upload" ? "upload" : "meeting"); return <Panel><div className="flex gap-2"><button className="text-xs" onClick={() => setTab("meeting")}>Meeting notes</button><button className="text-xs" onClick={() => setTab("upload")}>Uploads</button></div>{tab === "meeting" ? <MeetingTranscriptionPanel /> : <UploadTranscriptionPanel />}</Panel>; }

function LlmSettings() { const t = useTranslation().t; const noteConfig = useSettingsStore((s) => selectResolvedLLMConfig(s, "noteFormatting")); return <Panel><Header title={t("settingsPage.aiModels.title")} description={t("settingsPage.aiModels.description")} /><InferenceConfigEditor scope="noteFormatting" /><div className="border-t border-border/70 pt-6"><Header title={t("settingsPage.aiModels.chatTitle", { defaultValue: "Embedded chat" })} /><ChatAgentSettings /></div><div className="text-xs text-muted-foreground">{noteConfig.provider && `Provider: ${noteConfig.provider}`}</div></Panel>; }

function HotkeysSettings() { const { t } = useTranslation(); return <Panel><Header title={t("settingsPage.hotkeys.title")} description={t("settingsPage.hotkeys.description")} /><p className="text-xs text-muted-foreground">{t("settingsPage.hotkeys.description")}</p></Panel>; }
function SystemSettings() { const { t } = useTranslation(); return <Panel><Header title={t("settingsPage.system.title")} description={t("settingsPage.system.description")} /><p className="text-xs text-muted-foreground">{t("settingsPage.system.description")}</p></Panel>; }

export default function SettingsPage({ activeSection = "general", initialSubTab }: SettingsPageProps) {
  const section = sections.includes(activeSection) ? activeSection : "general";
  switch (section) { case "general": return <GeneralSettings />; case "hotkeys": return <HotkeysSettings />; case "speechToText": return <SpeechSettings initialSubTab={initialSubTab} />; case "llms": return <LlmSettings />; case "privacyData": return <PrivacySettings />; case "system": return <SystemSettings />; default: return null; }
}
