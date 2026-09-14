import React, { Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import MeetingNotificationOverlay from "./components/MeetingNotificationOverlay.tsx";
import { useTheme } from "./hooks/useTheme";
import { useControlPanelWindowDrag } from "./hooks/useControlPanelWindowDrag";

const ControlPanel = React.lazy(() => import("./components/ControlPanel.tsx"));
const OnboardingFlow = React.lazy(() => import("./components/OnboardingFlow.tsx"));

export default function AppRouter() {
  useTheme();
  const params = window.location.search;

  if (params.includes("meeting-notification=true")) {
    return <MeetingNotificationOverlay />;
  }


  return <MainApp />;
}

function MainApp() {
  useControlPanelWindowDrag(true);
  const [showOnboarding, setShowOnboarding] = useState(
    () => localStorage.getItem("onboardingCompleted") !== "true"
  );
  const [postOnboardingSettingsSection, setPostOnboardingSettingsSection] = useState();

  useEffect(() => {
    window.electronAPI?.setOnboardingActive?.(showOnboarding);
    void window.electronAPI?.setOnboardingWindowMode?.(showOnboarding ? "compact" : "restore");
    return () => window.electronAPI?.setOnboardingActive?.(true);
  }, [showOnboarding]);

  const handleOnboardingComplete = (options) => {
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
      <div className="w-7 h-7 rounded-full border-[2.5px] border-transparent border-t-primary animate-spin" aria-label={t("common.loading")} />
    </div>
  );
}
