import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Sliders,
  Brain,
  Wrench,
  Keyboard,
  Shield,
  BookOpen,
  Blocks,
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
  softwareUpdates: "system",
  privacy: "privacyData",
  permissions: "privacyData",
  developer: "system",
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
function parseSection(section: string | undefined): { section: SettingsSectionType; focus?: string } {
  if (!section) return { section: "general" };
  const [id, anchor] = section.split("#");
  return { section: (SECTION_ALIASES[id] ?? id) as SettingsSectionType, focus: anchor || LEGACY_FOCUS[id] };
}

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: string;
}

export default function SettingsModal({ open, onOpenChange, initialSection }: SettingsModalProps) {
  const { t } = useTranslation();
  const sidebarItems: SidebarItem<SettingsSectionType>[] = useMemo(() => {
    const items: SidebarItem<SettingsSectionType>[] = [
      {
        id: "general",
        label: t("settingsModal.sections.general.label"),
        icon: Sliders,
        description: t("settingsModal.sections.general.description"),
        group: t("settingsModal.groups.app"),
      },
      {
        id: "hotkeys",
        label: t("settingsModal.sections.hotkeys.label"),
        icon: Keyboard,
        description: t("settingsModal.sections.hotkeys.description"),
        group: t("settingsModal.groups.app"),
      },
      {
        id: "models",
        label: t("settingsModal.sections.models.label"),
        icon: Brain,
        description: t("settingsModal.sections.models.description"),
        group: t("settingsModal.groups.aiModels"),
      },
      {
        id: "dictionary",
        label: t("sidebar.dictionary"),
        icon: BookOpen,
        description: t("settingsModal.sections.dictionary.description"),
        group: t("settingsModal.groups.aiModels"),
      },
      {
        id: "integrations",
        label: t("sidebar.integrations"),
        icon: Blocks,
        description: t("integrations.description"),
        group: t("settingsModal.groups.system"),
      },
      {
        id: "privacyData",
        label: t("settingsModal.sections.privacyData.label"),
        icon: Shield,
        description: t("settingsModal.sections.privacyData.description"),
        group: t("settingsModal.groups.system"),
      },
      {
        id: "system",
        label: t("settingsModal.sections.system.label"),
        icon: Wrench,
        description: t("settingsModal.sections.system.description"),
        group: t("settingsModal.groups.system"),
      },
    ];
    return items;
  }, [t]);

  const [activeSection, setActiveSection] = React.useState<SettingsSectionType>(() => parseSection(initialSection).section);
  const [initialSubTab, setInitialSubTab] = useState<string | undefined>(() => parseSection(initialSection).focus);
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
