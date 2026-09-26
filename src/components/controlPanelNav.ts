import type React from "react";
import { useTranslation } from "react-i18next";
import { Home, NotebookPen, Upload } from "./icons";

export type ControlPanelView = "home" | "personal-notes" | "upload";

export interface ControlPanelNavItem {
  id: ControlPanelView;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

/**
 * Single source of truth for main-window navigation. The sidebar renders the
 * notes tree with Upload file and Settings buttons at the bottom, and the top
 * bar shows the active view's label as the page title.
 */
export function useControlPanelNavItems(): ControlPanelNavItem[] {
  const { t } = useTranslation();

  return [
    { id: "home", label: t("sidebar.home"), icon: Home },
    { id: "personal-notes", label: t("sidebar.notes"), icon: NotebookPen },
    { id: "upload", label: t("sidebar.upload"), icon: Upload },
  ];
}
