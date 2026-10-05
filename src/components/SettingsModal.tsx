import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Sliders,
  User,
  NotebookPen,
  Mic,
  Calendar,
  Brain,
  KeyRound,
  HardDrive,
  BookOpen,
  Shield,
  Terminal,
} from "./icons";
import SidebarModal, { type SidebarItem } from "./ui/SidebarModal";
import SettingsPage, { SettingsSectionType } from "./SettingsPage";

export type { SettingsSectionType };

// Old AI-model sections (transcription, meetings, intelligence, agent mode) are
// one Models page now. Legacy deep links land on the matching task row.
const SECTION_ALIASES: Record<string, SettingsSectionType> = {
  aiModels: "models",
  agentConfig: "models",
  agentMode: "models",
  intelligence: "models",
  meetings: "models",
  prompts: "models",
  transcription: "models",
  uploadTranscription: "models",
  softwareUpdates: "advanced",
  privacy: "privacyData",
  permissions: "recording",
  developer: "advanced",
};

const LEGACY_FOCUS: Record<string, string> = {
  transcription: "meeting",
  uploadTranscription: "upload",
  meetings: "summary",
  aiModels: "summary",
  prompts: "summary",
  intelligence: "chat",
  agentMode: "chat",
  agentConfig: "chat",
};

/** "models#summary" opens a section focused on one of its anchors. */
function parseSection(section: string | undefined): {
  section: SettingsSectionType;
  focus?: string;
} {
  if (!section) return { section: "general" };
  const [id, anchor] = section.split("#");

  return {
    section: (SECTION_ALIASES[id] ?? id) as SettingsSectionType,
    focus: anchor || LEGACY_FOCUS[id],
  };
}

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: string;
}

export default function SettingsModal({ open, onOpenChange, initialSection }: SettingsModalProps) {
  const { t } = useTranslation();

  const sidebarItems: SidebarItem<SettingsSectionType>[] = useMemo(() => {
    const item = (
      id: SettingsSectionType,
      icon: SidebarItem<SettingsSectionType>["icon"],
      group: string
    ): SidebarItem<SettingsSectionType> => ({
      id,
      icon,
      label: t(`settingsModal.sections.${id}.label`),
      description: t(`settingsModal.sections.${id}.description`),
      group: t(`settingsModal.groups.${group}`),
    });

    const items = [
      item("profile", User, "general"),
      item("general", Sliders, "general"),
      item("notes", NotebookPen, "general"),
      item("recording", Mic, "meetings"),
      item("calendar", Calendar, "meetings"),
      item("models", Brain, "ai"),
      item("providers", KeyRound, "ai"),
      item("onDevice", HardDrive, "ai"),
      item("dictionary", BookOpen, "ai"),
      item("privacyData", Shield, "system"),
      item("advanced", Terminal, "system"),
    ];

    return items;
  }, [t]);

  const [activeSection, setActiveSection] = React.useState<SettingsSectionType>(
    () => parseSection(initialSection).section
  );

  const [initialSubTab, setInitialSubTab] = useState<string | undefined>(
    () => parseSection(initialSection).focus
  );

  const [prevOpen, setPrevOpen] = useState(open);

  if (open && !prevOpen && initialSection) {
    const parsed = parseSection(initialSection);
    setPrevOpen(open);
    setActiveSection(parsed.section);
    setInitialSubTab(parsed.focus);
  } else if (open !== prevOpen) {
    setPrevOpen(open);

    if (!open) setInitialSubTab(undefined);
  }

  const handleSectionChange = (section: SettingsSectionType) => {
    setActiveSection(section);
    setInitialSubTab(undefined);
  };

  return (
    <SidebarModal<SettingsSectionType>
      open={open}
      onOpenChange={onOpenChange}
      title={t("settingsModal.title")}
      sidebarItems={sidebarItems}
      activeSection={activeSection}
      onSectionChange={handleSectionChange}
      header={undefined}
    >
      <SettingsPage
        activeSection={activeSection}
        onNavigateToSection={handleSectionChange}
        initialSubTab={initialSubTab}
      />
    </SidebarModal>
  );
}
