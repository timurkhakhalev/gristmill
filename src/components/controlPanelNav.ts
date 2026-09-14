import type React from "react";
import { useTranslation } from "react-i18next";
import { NotebookPen, BookOpen, Upload, Blocks } from "./icons";

export type ControlPanelView =
  "personal-notes" | "dictionary" | "upload" | "integrations";

export interface ControlPanelNavItem {
  id: ControlPanelView;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

/**
 * Single source of truth for main-window navigation. The sidebar renders these
 * rows and the top bar shows the active item's label as the page title, so the
 * two can never disagree.
 */
export function useControlPanelNavItems(): ControlPanelNavItem[] {
  const { t } = useTranslation();

  return [
    { id: "personal-notes", label: t("sidebar.notes"), icon: NotebookPen },
    { id: "upload", label: t("sidebar.upload"), icon: Upload },
    { id: "dictionary", label: t("sidebar.dictionary"), icon: BookOpen },
    { id: "integrations", label: t("sidebar.integrations"), icon: Blocks },
  ];
}
