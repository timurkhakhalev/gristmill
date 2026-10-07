import React, { Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import MeetingNotificationOverlay from "./components/MeetingNotificationOverlay";
import MeetingCompanion from "./components/MeetingCompanion";
import { useTheme } from "./hooks/useTheme";
import { useControlPanelWindowDrag } from "./hooks/useControlPanelWindowDrag";
import { initializeNoteFiles } from "./stores/settingsStore";
import logger from "./utils/logger";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const ControlPanel = React.lazy(() => import("./components/ControlPanel"));

const OnboardingFlow = React.lazy(() => import("./components/OnboardingFlow"));

export default function AppRouter() {
  useTheme();
  const params = window.location.search;

  if (params.includes("meeting-notification=true")) {
    return <MeetingNotificationOverlay />;
  }

  if (params.includes("meeting-companion=true")) {
    return <MeetingCompanion />;
  }

  return <MainApp />;
}

function MainApp() {
  useControlPanelWindowDrag(true);
  useEffect(() => {
    // Fire-and-forget by contract: note-file initialization is a startup
    // side-effect; observe its rejection so it is not lost.
    initializeNoteFiles().catch((error) => {
      logger.error("Failed to initialize note files", { error: String(error) }, "notes");
    });
  }, []);

  const [showOnboarding, setShowOnboarding] = useState(
    () => localStorage.getItem("onboardingCompleted") !== "true"
  );

  const [postOnboardingSettingsSection, setPostOnboardingSettingsSection] = useState<
    string | undefined
  >();

  useEffect(() => {
    // Best-effort window-mode sync: the main process owns the window, and a
    // rejected call is recorded rather than floated.
    const report = (action: string) => (cause: unknown) =>
      logger.error(`Failed to ${action}`, { error: errorText(cause) }, "window");

    window.electronAPI
      ?.setOnboardingActive?.(showOnboarding)
      .catch(report("set onboarding active"));
    window.electronAPI
      ?.setOnboardingWindowMode?.(showOnboarding ? "compact" : "restore")
      .catch(report("set onboarding window mode"));

    return () => {
      window.electronAPI?.setOnboardingActive?.(true).catch(report("release onboarding active"));
    };
  }, [showOnboarding]);

  const handleOnboardingComplete = (options?: { openSettings?: boolean }) => {
    if (options?.openSettings) setPostOnboardingSettingsSection("transcription");
    localStorage.setItem("onboardingCompleted", "true");
    setShowOnboarding(false);
  };

  if (showOnboarding) {
    return (
      <Suspense fallback={<LoadingFallback />}>
        <OnboardingFlow onComplete={handleOnboardingComplete} />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<LoadingFallback />}>
      <ControlPanel initialSettingsSection={postOnboardingSettingsSection} />
    </Suspense>
  );
}

function LoadingFallback() {
  const { t } = useTranslation();

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div
        className="w-7 h-7 rounded-full border-[2.5px] border-transparent border-t-primary animate-spin"
        aria-label={t("common.loading")}
      />
    </div>
  );
}
